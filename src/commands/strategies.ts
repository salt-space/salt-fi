import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import type { Address } from "viem";
import {
  computeDashboard,
  computeFinalStrategyPnl,
  DELTA_NEUTRAL_PAIRS,
  executeDeltaNeutralOpen,
  executeRebalance,
  executeWindDown,
  listStrategies,
  loadDeltaNeutralContext,
  planDeltaNeutralOpen,
  planRebalance,
  planWindDown,
  reconcileStrategy,
  type DeltaNeutralPair,
  type DeltaNeutralStrategy,
} from "../delta-neutral.js";
import { reportError } from "../errors.js";
import { getAgentMetadata } from "../hyperliquid.js";
import { computeLeverageOptions } from "../hyperliquid-risk.js";
import { ensureFunded, pickHyperliquidAccount, resolveAgentKeySigner } from "./hyperliquid.js";
import { select } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

// --- Formatting helpers (mirrors commands/hyperliquid.ts's, kept local per this codebase's per-file convention) --

function fmtUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(value: number, maxDecimals = 6): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

function fmtSignedNum(value: number, maxDecimals = 6): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: maxDecimals })}`;
}

function fmtPct(fraction: number, decimals = 4): string {
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(decimals)}%`;
}

// --- Menu wiring ---------------------------------------------------------------------

export async function strategiesFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const choice = await select({
    message: "Strategies",
    options: [{ value: "delta-neutral", label: "Basis ▸" }],
  });
  if (p.isCancel(choice)) return;
  await deltaNeutralAssetFlow(salt, walletClient);
}

async function deltaNeutralAssetFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const pair = await select({
    message: "Basis",
    options: DELTA_NEUTRAL_PAIRS.map((p) => ({ value: p, label: p, hint: "long spot, short perp" })),
  });
  if (p.isCancel(pair)) return;
  await deltaNeutralPairFlow(salt, walletClient, pair);
}

async function deltaNeutralPairFlow(salt: Salt, walletClient: SaltWalletClient, pair: DeltaNeutralPair): Promise<void> {
  const choice = await select({
    message: `${pair} Basis`,
    options: [
      { value: "open", label: "Open", hint: `long ${pair} spot + short ${pair} perp` },
      { value: "dashboard", label: "Dashboard", hint: "active strategy status" },
      { value: "rebalance", label: "Rebalance", hint: "correct delta imbalance" },
      { value: "wind-down", label: "Wind Down", hint: "close both legs" },
    ],
  });
  if (p.isCancel(choice)) return;
  if (choice === "open") await openDeltaNeutralFlow(salt, walletClient, pair);
  else if (choice === "dashboard") await dashboardFlow(salt, walletClient, pair);
  else if (choice === "rebalance") await rebalanceFlow(salt, walletClient, pair);
  else await windDownFlow(salt, walletClient, pair);
}

// --- Shared account + strategy picker ------------------------------------------------

async function pickOpenStrategy(
  salt: Salt,
  walletClient: SaltWalletClient,
  pair: DeltaNeutralPair,
  message: string,
): Promise<{ strategy: DeltaNeutralStrategy; userAddress: Address; accountId: string } | undefined> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Which account?");
  if (!picked) return undefined;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  const strategies = listStrategies(accountId, pair);
  if (strategies.length === 0) {
    p.log.info(`No ${pair} basis strategies for this account yet — use Open first.`);
    return undefined;
  }

  const strategyId = await select({
    message,
    options: strategies.map((s) => ({
      value: s.id,
      label: `${s.pair} — ${s.status}`,
      hint: `opened ${new Date(s.createdAt).toLocaleString()}`,
    })),
  });
  if (p.isCancel(strategyId)) return undefined;
  const strategy = strategies.find((s) => s.id === strategyId)!;
  return { strategy, userAddress, accountId };
}

// --- Open ------------------------------------------------------------------------------

async function openDeltaNeutralFlow(salt: Salt, walletClient: SaltWalletClient, pair: DeltaNeutralPair): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, `Open a ${pair} basis strategy for which account?`);
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  const agentMeta = getAgentMetadata(accountId);
  if (!agentMeta?.lastVerified) {
    p.log.error(
      'No verified agent wallet on this account. Approve one via "Getting Started" first — Basis signs every leg via the agent key, never a Salt MPC ceremony.',
    );
    return;
  }
  const signer = await resolveAgentKeySigner(accountId, agentMeta.agentAddress, walletClient);
  if (!signer) return;

  const s = p.spinner();
  s.start(`Loading ${pair} markets and account state`);
  let context;
  try {
    context = await loadDeltaNeutralContext(userAddress, pair);
    s.stop("Loaded");
  } catch (err) {
    s.stop("Failed to load");
    reportError(err);
    return;
  }

  p.log.message(
    "Loaded\n" +
      `  Spot USDC available     ${fmtUsd(context.spotUsdcAvailable)}\n` +
      `  Perp available margin   ${fmtUsd(context.perpAvailableMargin)}\n` +
      `  ${pair} spot price           ${fmtNum(context.spotPrice, 2)}\n` +
      `  ${pair} perp mark             ${fmtNum(context.perpMark, 2)}\n` +
      `  Current funding rate      ${fmtPct(context.fundingRatePerHour)} / hour\n` +
      `  Max perp leverage        ${context.markets.perpMaxLeverage}x\n` +
      `  Taker fee rate            ${fmtPct(context.takerFeeRate, 3)}\n` +
      `  Active agent              ${agentMeta.agentName} (${agentMeta.agentAddress})`,
  );

  if (context.perpExistingPosition) {
    p.log.warn(
      `This account already has a ${pair} perp position (${fmtSignedNum(context.perpExistingPosition.szi)}) outside any strategy — ` +
        "Rebalance/Wind Down for the new strategy will only ever touch the quantity this strategy itself opens, never that existing position.",
    );
  }

  const capitalInput = await p.text({
    message: `Capital to deploy (spot USDC available: ${fmtUsd(context.spotUsdcAvailable)}, perp margin available: ${fmtUsd(context.perpAvailableMargin)})`,
    validate: (v) => {
      if (!v) return "Amount is required";
      const n = Number(v);
      return !Number.isFinite(n) || n <= 0 ? "Enter a positive amount" : undefined;
    },
  });
  if (p.isCancel(capitalInput)) return;
  const capital = Number(capitalInput);

  const leverageOptions = computeLeverageOptions(context.markets.perpMaxLeverage);
  const leverage = await select({
    message: "Perp leverage",
    initialValue: leverageOptions.includes(2) ? 2 : leverageOptions[0],
    options: leverageOptions.map((l) => ({ value: l, label: `${l}x`, hint: l === 2 ? "default — conservative" : undefined })),
  });
  if (p.isCancel(leverage)) return;

  const plan = planDeltaNeutralOpen(context, capital, leverage);

  const spotShortfall = Math.max(0, plan.allocation.spotAllocation - context.spotUsdcAvailable);
  const perpShortfall = Math.max(0, plan.allocation.perpMargin - context.perpAvailableMargin);
  if (spotShortfall > 0 || perpShortfall > 0) {
    const routed = await ensureFunded(salt, walletClient, accountId, userAddress, {
      spotUsdc: spotShortfall > 0 ? plan.allocation.spotAllocation : undefined,
      perpMargin: perpShortfall > 0 ? plan.allocation.perpMargin : undefined,
    });
    if (!routed) {
      if (spotShortfall > 0) p.log.error(`Spot allocation (${fmtUsd(plan.allocation.spotAllocation)}) exceeds available spot USDC (${fmtUsd(context.spotUsdcAvailable)}), and nothing routable elsewhere covers the difference.`);
      if (perpShortfall > 0) p.log.error(`Perp margin (${fmtUsd(plan.allocation.perpMargin)}) exceeds available perp margin (${fmtUsd(context.perpAvailableMargin)}), and nothing routable elsewhere covers the difference.`);
      return;
    }
    context.spotUsdcAvailable = routed.spot.usdc;
    context.perpAvailableMargin = routed.perp.withdrawable;
    if (plan.allocation.spotAllocation > context.spotUsdcAvailable || plan.allocation.perpMargin > context.perpAvailableMargin) {
      p.log.error("Still short after routing — check balances and try a smaller capital amount.");
      return;
    }
  }
  if (plan.sizeRoundsToZero) {
    p.log.error(`That capital amount rounds to zero size at ${pair}'s market precision — increase capital.`);
    return;
  }

  p.note(
    [
      `${pair} Basis — capital ${fmtUsd(capital)}, ${leverage}x perp`,
      "",
      `Spot allocation:       ${fmtUsd(plan.allocation.spotAllocation)}`,
      `Perp margin:           ${fmtUsd(plan.allocation.perpMargin)}`,
      `Long ${pair} spot:         ~${fmtNum(plan.allocation.spotQty)} ${pair} (~${fmtUsd(plan.allocation.spotNotional)})`,
      `Short ${pair} perp:        ~${fmtNum(plan.allocation.perpQty)} ${pair} (~${fmtUsd(plan.allocation.perpNotional)})`,
      `Gross exposure:        ${fmtUsd(plan.allocation.grossExposure)}`,
      `Target net exposure:   ${fmtSignedUsd(plan.allocation.targetNetExposure)}`,
      "",
      `Spot price:            ${fmtNum(context.spotPrice, 2)}`,
      `Perp mark:             ${fmtNum(context.perpMark, 2)}`,
      `Spot/perp basis:       ${fmtSignedUsd(plan.basis)} (${fmtPct(plan.basisPct, 3)})`,
      "",
      `Current funding rate:  ${fmtPct(plan.fundingRatePerHour)} / hour — variable, not guaranteed`,
      `Est. entry fees:       ${fmtUsd(plan.estimatedEntryFees)}`,
      `Est. slippage (worst): ${fmtUsd(plan.estimatedSlippage)}`,
      "",
      `Signing:               agent "${agentMeta.agentName}"`,
    ].join("\n"),
    "Pre-trade preview",
  );

  if (plan.fundingWarning) {
    p.log.warn(
      plan.fundingRatePerHour <= 0
        ? "Current funding rate is non-positive — this short perp leg would be paying funding, not receiving it, until the rate flips. Funding is variable."
        : `Estimated funding income over ${plan.fundingHorizonHours}h (${fmtUsd(plan.fundingSufficiency.estimatedFundingIncome)}) looks insufficient to cover estimated round-trip costs (${fmtUsd(plan.roundTripCostEstimate)}). Funding is variable and not guaranteed.`,
    );
  }

  const confirmed = await p.confirm({
    message: plan.fundingWarning ? "Funding may not cover costs — open anyway?" : "Open this strategy?",
    initialValue: !plan.fundingWarning,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s2 = p.spinner();
  s2.start("Opening — submitting spot and perp legs");
  try {
    const strategy = await executeDeltaNeutralOpen({ accountId, userAddress, signer, context, plan });
    if (strategy.status === "OPEN") {
      s2.stop(`Open — ${fmtNum(strategy.currentSpotQty)} ${pair} spot / ${fmtNum(Math.abs(strategy.currentPerpQty))} ${pair} perp short (id ${strategy.id})`);
    } else {
      s2.stop(
        `UNBALANCED — one leg didn't fully fill. Spot: ${fmtNum(strategy.currentSpotQty)} ${pair}, Perp: ${fmtNum(Math.abs(strategy.currentPerpQty))} ${pair}. ` +
          `Use Rebalance to correct, or Wind Down to unwind. (id ${strategy.id})`,
      );
    }
  } catch (err) {
    s2.stop("Open failed");
    reportError(err);
  }
}

// --- Dashboard -----------------------------------------------------------------------

async function dashboardFlow(salt: Salt, walletClient: SaltWalletClient, pair: DeltaNeutralPair): Promise<void> {
  const picked = await pickOpenStrategy(salt, walletClient, pair, "View which strategy?");
  if (!picked) return;
  const { strategy, userAddress } = picked;

  const s = p.spinner();
  s.start("Reconciling and loading live state");
  try {
    const reconciled = await reconcileStrategy(strategy, userAddress);
    const dashboard = await computeDashboard(reconciled, userAddress);
    s.stop("Dashboard");

    p.log.message(
      [
        `${pair} Basis`,
        "",
        `Status:                ${dashboard.strategy.status}`,
        "",
        `Spot ${pair.padEnd(4)}           ${fmtSignedNum(dashboard.strategy.currentSpotQty)}`,
        `Perp ${pair.padEnd(4)}           ${fmtSignedNum(dashboard.strategy.currentPerpQty)}`,
        "",
        `Spot exposure          ${fmtUsd(dashboard.spotExposure)}`,
        `Perp exposure          ${fmtUsd(dashboard.perpExposure)}`,
        `Gross exposure         ${fmtUsd(dashboard.grossExposure)}`,
        `Net exposure           ${fmtSignedUsd(dashboard.netExposure)}`,
        `Delta imbalance        ${(dashboard.imbalancePct * 100).toFixed(2)}%`,
        "",
        `Funding received       ${fmtSignedUsd(dashboard.fundingReceived)}`,
        `Fees                   ${fmtSignedUsd(-dashboard.fees)}`,
        `Strategy PnL           ${fmtSignedUsd(dashboard.strategyPnl)}`,
        "",
        `Current funding rate   ${fmtPct(dashboard.currentFundingRatePerHour)} / hour`,
      ].join("\n"),
    );
    if (dashboard.divergenceWarning) p.log.warn(dashboard.divergenceWarning);
    if (dashboard.unbalanced) p.log.warn("Imbalance exceeds 1% — use Rebalance to correct, or Wind Down to unwind.");
  } catch (err) {
    s.stop("Failed to load dashboard");
    reportError(err);
  }
}

// --- Rebalance -----------------------------------------------------------------------

async function rebalanceFlow(salt: Salt, walletClient: SaltWalletClient, pair: DeltaNeutralPair): Promise<void> {
  const picked = await pickOpenStrategy(salt, walletClient, pair, "Rebalance which strategy?");
  if (!picked) return;
  const { strategy, userAddress, accountId } = picked;

  const agentMeta = getAgentMetadata(accountId);
  if (!agentMeta?.lastVerified) {
    p.log.error("No verified agent wallet on this account — can't sign a rebalance order.");
    return;
  }

  const s = p.spinner();
  s.start("Checking imbalance");
  let plan;
  try {
    const reconciled = await reconcileStrategy(strategy, userAddress);
    plan = await planRebalance(reconciled, userAddress);
    s.stop(plan ? "Imbalance found" : "Already balanced");
  } catch (err) {
    s.stop("Failed to check imbalance");
    reportError(err);
    return;
  }
  if (!plan) {
    p.log.success("This strategy is within the 1% imbalance threshold — nothing to rebalance.");
    return;
  }

  p.note(
    [
      `Current imbalance:    ${(plan.dashboard.imbalancePct * 100).toFixed(2)}%`,
      `Correcting leg:       perp`,
      `Order:                ${plan.isBuy ? "Buy (reduce short)" : "Sell (increase short)"} ${fmtNum(plan.size)} ${strategy.pair} perp`,
      `Estimated notional:   ${fmtUsd(plan.estimatedNotional)}`,
    ].join("\n"),
    "Rebalance preview",
  );
  const confirmed = await p.confirm({ message: "Submit this corrective order?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  const signer = await resolveAgentKeySigner(accountId, agentMeta.agentAddress, walletClient);
  if (!signer) return;

  const s2 = p.spinner();
  s2.start("Submitting rebalance order");
  try {
    const updated = await executeRebalance(userAddress, signer, plan);
    s2.stop(`Rebalanced — now ${updated.status}. Spot: ${fmtNum(updated.currentSpotQty)} ${updated.pair}, Perp: ${fmtNum(Math.abs(updated.currentPerpQty))} ${updated.pair}.`);
  } catch (err) {
    s2.stop("Rebalance failed");
    reportError(err);
  }
}

// --- Wind Down -----------------------------------------------------------------------

async function windDownFlow(salt: Salt, walletClient: SaltWalletClient, pair: DeltaNeutralPair): Promise<void> {
  const picked = await pickOpenStrategy(salt, walletClient, pair, "Wind down which strategy?");
  if (!picked) return;
  const { strategy, userAddress, accountId } = picked;

  const agentMeta = getAgentMetadata(accountId);
  if (!agentMeta?.lastVerified) {
    p.log.error("No verified agent wallet on this account — can't sign a wind-down order.");
    return;
  }

  const s = p.spinner();
  s.start("Loading close plan");
  let plan;
  try {
    const reconciled = await reconcileStrategy(strategy, userAddress);
    plan = await planWindDown(reconciled, userAddress);
    s.stop("Loaded");
  } catch (err) {
    s.stop("Failed to load close plan");
    reportError(err);
    return;
  }

  if (plan.spotSellQty <= 0 && plan.perpBuyQty <= 0) {
    p.log.info("This strategy has nothing left to close.");
    return;
  }

  p.note(
    [
      `Sell ${strategy.pair} spot:          ~${fmtNum(plan.spotSellQty)} ${strategy.pair}`,
      `Buy-to-close ${strategy.pair} perp:  ~${fmtNum(plan.perpBuyQty)} ${strategy.pair} (reduce-only)`,
      "",
      `This only closes this strategy's own tracked ${strategy.pair} — not the account's full ${strategy.pair} exposure.`,
    ].join("\n"),
    "Wind Down preview",
  );
  const confirmed = await p.confirm({ message: "Wind down this strategy?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  const signer = await resolveAgentKeySigner(accountId, agentMeta.agentAddress, walletClient);
  if (!signer) return;

  const s2 = p.spinner();
  s2.start("Closing — submitting spot and perp legs");
  try {
    const updated = await executeWindDown(userAddress, signer, plan);
    if (updated.status === "COMPLETE") {
      s2.stop(`Complete — final strategy PnL ${fmtSignedUsd(computeFinalStrategyPnl(updated))}`);
    } else {
      s2.stop(
        `Still CLOSING — one leg didn't fully close. Spot left: ${fmtNum(updated.currentSpotQty)} ${updated.pair}, Perp left: ${fmtNum(Math.abs(updated.currentPerpQty))} ${updated.pair}. ` +
          "Re-run Wind Down to retry the remainder.",
      );
    }
  } catch (err) {
    s2.stop("Wind Down failed");
    reportError(err);
  }
}
