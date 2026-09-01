/**
 * Delta-neutral strategy engine: sits above the existing Hyperliquid trading layer
 * (hyperliquid.ts's order construction/signing/submission, never duplicated here) and orchestrates
 * a *pair* of legs — long spot, short perp, same asset — as one strategy operation, for any of
 * {@link DELTA_NEUTRAL_PAIRS}. No CLI/prompt dependency; commands/strategies.ts is the interactive
 * layer that calls into this.
 *
 * Hyperliquid gives no way to distinguish "this strategy's BTC/ETH/SOL/HYPE" from any other
 * holding of the same asset in the same account (spot balances and the perp position are both
 * single netted totals). Every piece of strategy state below is tracked in a local persisted store
 * and treated as authoritative over raw wallet totals — live totals are used only to
 * reconcile/flag divergence, never to silently overwrite what this strategy believes it owns.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { network } from "./env.js";
import {
  buildLimitOrderAction,
  buildUpdateLeverageAction,
  extractActionErrors,
  fetchClearinghouseState,
  fetchL2Book,
  fetchMeta,
  fetchMetaAndAssetCtxs,
  fetchOpenOrders,
  fetchSpotClearinghouseState,
  fetchSpotMeta,
  fetchUserFees,
  fetchUserFills,
  findSpotPairAgainstUsdc,
  marketOrderLimitPrice,
  MARKET_ORDER_SLIPPAGE,
  roundSpotPrice,
  signAndSubmitL1Action,
  spotAssetId,
  type ExchangeActionResponse,
  type L1ActionSigner,
  type LimitOrderParams,
  type UserFill,
} from "./hyperliquid.js";
import {
  computeDeltaNeutralAllocation,
  computeNetExposure,
  DEFAULT_FUNDING_HORIZON_HOURS,
  estimateFundingSufficiency,
  isUnbalanced,
  type DeltaNeutralAllocationResult,
  type FundingSufficiencyResult,
} from "./delta-neutral-math.js";

// --- Market resolution — never hardcoded ---------------------------------------

/** Assets this strategy supports. Perp markets for all four exist under this exact name on both networks (confirmed live) — it's the *spot* side that varies, see {@link SPOT_SYMBOL_BY_PAIR}. */
export type DeltaNeutralPair = "BTC" | "ETH" | "SOL" | "HYPE";

export const DELTA_NEUTRAL_PAIRS: DeltaNeutralPair[] = ["BTC", "ETH", "SOL", "HYPE"];

/**
 * Hyperliquid's spot exchange does not list plain "BTC"/"ETH"/"SOL" tokens — confirmed live
 * against both networks. Mainnet lists Unit protocol's bridged representations instead (`UBTC`,
 * `UETH`, `USOL`); testnet has its own non-canonical `BTC` test listing but no `UBTC`, while
 * `UETH`/`USOL` exist on testnet too. HYPE is the native token and is listed as `HYPE` on both.
 * This mapping is what makes {@link resolveMarkets} correct instead of guessing — get it wrong and
 * spot-market resolution throws rather than silently trading the wrong asset.
 */
const SPOT_SYMBOL_BY_PAIR: Record<typeof network.saltEnv, Record<DeltaNeutralPair, string>> = {
  testnet: { BTC: "BTC", ETH: "UETH", SOL: "USOL", HYPE: "HYPE" },
  mainnet: { BTC: "UBTC", ETH: "UETH", SOL: "USOL", HYPE: "HYPE" },
};

export interface PairMarkets {
  perpAssetIndex: number;
  perpSzDecimals: number;
  perpMaxLeverage: number;
  /** The actual spot token symbol traded (e.g. `"UBTC"` for `pair: "BTC"` on mainnet) — see {@link SPOT_SYMBOL_BY_PAIR}. Distinct from `pair`, which is always the perp/display symbol. */
  spotSymbol: string;
  spotPairIndex: number;
  spotSzDecimals: number;
}

/** Resolves `pair`'s perp asset index and spot pair index live from Hyperliquid metadata — no hardcoded ids, so a delisting/relisting doesn't silently break this. */
export async function resolveMarkets(pair: DeltaNeutralPair): Promise<PairMarkets> {
  const [meta, spotMeta] = await Promise.all([fetchMeta(), fetchSpotMeta()]);
  const perpAssetIndex = meta.universe.findIndex((a) => a.name === pair);
  if (perpAssetIndex < 0) throw new Error(`Couldn't resolve ${pair} in the perp universe`);
  const perpAsset = meta.universe[perpAssetIndex];
  const spotSymbol = SPOT_SYMBOL_BY_PAIR[network.saltEnv][pair];
  const spot = findSpotPairAgainstUsdc(spotMeta, spotSymbol);
  if (!spot) throw new Error(`Couldn't resolve a ${spotSymbol}/USDC spot market for ${pair}`);
  return {
    perpAssetIndex,
    perpSzDecimals: perpAsset.szDecimals,
    perpMaxLeverage: perpAsset.maxLeverage,
    spotSymbol,
    spotPairIndex: spot.pairIndex,
    spotSzDecimals: spot.szDecimals,
  };
}

// --- Context loading -------------------------------------------------------------

export interface DeltaNeutralContext {
  userAddress: Address;
  pair: DeltaNeutralPair;
  markets: PairMarkets;
  spotUsdcAvailable: number;
  perpAvailableMargin: number;
  /** Non-strategy-aware — the account's whole perp position in this pair, if any. Surfaced so Open can warn the user rather than silently commingling with a pre-existing manual position. */
  perpExistingPosition?: { szi: number; entryPx: number };
  /** Mid of best bid/ask on the pair's spot/USDC book. */
  spotPrice: number;
  perpMark: number;
  /** Current hourly funding rate — see {@link "./hyperliquid.js".AssetCtx.funding}'s sign-convention caveat. */
  fundingRatePerHour: number;
  takerFeeRate: number;
}

export async function loadDeltaNeutralContext(userAddress: Address, pair: DeltaNeutralPair): Promise<DeltaNeutralContext> {
  const markets = await resolveMarkets(pair);
  const [spot, perp, book, [, assetCtxs], fees] = await Promise.all([
    fetchSpotClearinghouseState(userAddress),
    fetchClearinghouseState(userAddress),
    fetchL2Book(`@${markets.spotPairIndex}`),
    fetchMetaAndAssetCtxs(),
    fetchUserFees(userAddress),
  ]);

  const bestBid = Number(book.levels[0][0]?.px ?? 0);
  const bestAsk = Number(book.levels[1][0]?.px ?? 0);
  const spotPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

  const perpCtx = assetCtxs[markets.perpAssetIndex];
  const existing = perp.assetPositions.find((ap) => ap.position.coin === pair);

  return {
    userAddress,
    pair,
    markets,
    spotUsdcAvailable: spotBalance(spot, "USDC"),
    perpAvailableMargin: Number(perp.withdrawable),
    perpExistingPosition: existing ? { szi: Number(existing.position.szi), entryPx: Number(existing.position.entryPx) } : undefined,
    spotPrice,
    perpMark: Number(perpCtx?.markPx ?? 0),
    fundingRatePerHour: Number(perpCtx?.funding ?? 0),
    takerFeeRate: Number(fees.userCrossRate ?? 0),
  };
}

function spotBalance(spot: Awaited<ReturnType<typeof fetchSpotClearinghouseState>>, coin: string): number {
  const b = spot.balances.find((bal) => bal.coin === coin);
  return b ? Number(b.total) - Number(b.hold) : 0;
}

// --- Pre-trade plan ----------------------------------------------------------------

export interface DeltaNeutralOpenPlan {
  capital: number;
  perpLeverage: number;
  allocation: DeltaNeutralAllocationResult;
  basis: number;
  basisPct: number;
  fundingRatePerHour: number;
  estimatedEntryFees: number;
  estimatedSlippage: number;
  roundTripCostEstimate: number;
  fundingHorizonHours: number;
  fundingSufficiency: FundingSufficiencyResult;
  /** True if funding is non-positive or estimated-insufficient — the caller must surface this prominently and never present funding as guaranteed. */
  fundingWarning: boolean;
  sizeRoundsToZero: boolean;
}

export function planDeltaNeutralOpen(context: DeltaNeutralContext, capital: number, perpLeverage: number): DeltaNeutralOpenPlan {
  const allocation = computeDeltaNeutralAllocation({
    capital,
    perpLeverage,
    spotPrice: context.spotPrice,
    perpMark: context.perpMark,
    spotSzDecimals: context.markets.spotSzDecimals,
    perpSzDecimals: context.markets.perpSzDecimals,
  });

  const estimatedEntryFees = (allocation.spotNotional + allocation.perpNotional) * context.takerFeeRate;
  // Worst-case slippage bound using the same IOC slippage tolerance perp market orders use
  // elsewhere in this app — actual slippage on a liquid book is typically far less.
  const estimatedSlippage = (allocation.spotNotional + allocation.perpNotional) * MARKET_ORDER_SLIPPAGE;
  // Round trip = entry fees + exit fees (same notional, assumed symmetric) + slippage.
  const roundTripCostEstimate = estimatedEntryFees * 2 + estimatedSlippage;

  const fundingSufficiency = estimateFundingSufficiency({
    fundingRatePerHour: context.fundingRatePerHour,
    perpNotional: allocation.perpNotional,
    roundTripCostEstimate,
  });

  return {
    capital,
    perpLeverage,
    allocation,
    basis: context.perpMark - context.spotPrice,
    basisPct: context.spotPrice > 0 ? (context.perpMark - context.spotPrice) / context.spotPrice : 0,
    fundingRatePerHour: context.fundingRatePerHour,
    estimatedEntryFees,
    estimatedSlippage,
    roundTripCostEstimate,
    fundingHorizonHours: DEFAULT_FUNDING_HORIZON_HOURS,
    fundingSufficiency,
    fundingWarning: context.fundingRatePerHour <= 0 || !fundingSufficiency.sufficient,
    sizeRoundsToZero: allocation.spotQty <= 0 || allocation.perpQty <= 0,
  };
}

// --- Persisted strategy state ------------------------------------------------------

export type DeltaNeutralStatus = "OPENING" | "OPEN" | "UNBALANCED" | "CLOSING" | "COMPLETE";

export type LegAttemptStatus = "submitted" | "filled" | "partial" | "resting" | "error" | "unknown";

export interface LegAttempt {
  cloid: Hex;
  assetIndex: number;
  isBuy: boolean;
  sizeRequested: number;
  submittedAt: number;
  status: LegAttemptStatus;
  oid?: number;
  filledSize?: number;
  avgPx?: number;
  fee?: number;
  closedPnl?: number;
  error?: string;
}

export interface DeltaNeutralStrategy {
  id: string;
  accountId: string;
  pair: DeltaNeutralPair;
  status: DeltaNeutralStatus;
  createdAt: number;
  updatedAt: number;
  targetCapital: number;
  perpLeverage: number;
  perpAssetIndex: number;
  /** The actual spot token symbol traded — see {@link SPOT_SYMBOL_BY_PAIR}; distinct from `pair` for BTC/ETH/SOL. */
  spotSymbol: string;
  spotPairIndex: number;
  spotSzDecimals: number;
  perpSzDecimals: number;
  openLegs: { spot: LegAttempt[]; perp: LegAttempt[] };
  closeLegs: { spot: LegAttempt[]; perp: LegAttempt[] };
  rebalanceLegs: LegAttempt[];
  /** Quantity of `pair` currently attributable to this strategy on spot — never assumed equal to the account's total holdings of it. */
  currentSpotQty: number;
  /** Negative = short. */
  currentPerpQty: number;
  /** Running dollar cost basis of `currentSpotQty`, for realized-PnL accounting on close. */
  spotCostBasis: number;
  fees: number;
  /** Captured from the perp position's cumFunding right before Wind Down closes it (see caveat there — whole-position, not strictly per-strategy, if other manual activity in this pair's perp ever occurred). */
  accumulatedFunding: number;
  realizedSpotPnl: number;
  realizedPerpPnl: number;
}

const STORE_FILE = path.resolve(process.cwd(), `.hyperliquid-delta-neutral.${network.saltEnv}.json`);

type StrategyStore = Record<string, DeltaNeutralStrategy>;

function readStore(): StrategyStore {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) as StrategyStore;
  } catch {
    return {};
  }
}

/** Atomic write (temp file + rename) — this file tracks real capital, unlike AgentStore's bare writeFileSync, so a crash mid-write must never leave a truncated/corrupt store. */
function writeStore(store: StrategyStore): void {
  const tmpFile = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, STORE_FILE);
}

export function getStrategy(id: string): DeltaNeutralStrategy | undefined {
  return readStore()[id];
}

/** Lists an account's strategies, optionally scoped to one pair — omit `pair` to list every pair the account has open/closed strategies in. */
export function listStrategies(accountId: string, pair?: DeltaNeutralPair): DeltaNeutralStrategy[] {
  return Object.values(readStore())
    .filter((s) => s.accountId === accountId && (pair === undefined || s.pair === pair))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function saveStrategy(strategy: DeltaNeutralStrategy): void {
  strategy.updatedAt = Date.now();
  const store = readStore();
  store[strategy.id] = strategy;
  writeStore(store);
}

function generateStrategyId(): string {
  return `dn-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function generateCloid(): Hex {
  return `0x${randomBytes(16).toString("hex")}` as Hex;
}

function buildLegAttempt({ assetIndex, isBuy, size }: { assetIndex: number; isBuy: boolean; size: number }): LegAttempt {
  return { cloid: generateCloid(), assetIndex, isBuy, sizeRequested: size, submittedAt: Date.now(), status: "submitted" };
}

/** Recomputes attributable quantities from the full attempt history — the single source of truth, rather than incrementally mutated counters that could drift out of sync with what actually happened. */
function recomputeAttributableQuantities(strategy: DeltaNeutralStrategy): void {
  const filled = (a: LegAttempt) => a.filledSize ?? 0;

  const spotBought = strategy.openLegs.spot.filter((a) => a.isBuy).reduce((s, a) => s + filled(a), 0);
  const spotSold = strategy.closeLegs.spot.filter((a) => !a.isBuy).reduce((s, a) => s + filled(a), 0);
  strategy.currentSpotQty = Math.max(0, spotBought - spotSold);

  const perpShortOpened = strategy.openLegs.perp.filter((a) => !a.isBuy).reduce((s, a) => s + filled(a), 0);
  const perpShortClosed = strategy.closeLegs.perp.filter((a) => a.isBuy).reduce((s, a) => s + filled(a), 0);
  const rebalanceShortAdds = strategy.rebalanceLegs.filter((a) => !a.isBuy).reduce((s, a) => s + filled(a), 0);
  const rebalanceShortReduces = strategy.rebalanceLegs.filter((a) => a.isBuy).reduce((s, a) => s + filled(a), 0);
  strategy.currentPerpQty = -Math.max(0, perpShortOpened + rebalanceShortAdds - perpShortClosed - rebalanceShortReduces);
}

// --- Submission + fill verification -------------------------------------------------

/** Parses a settled `signAndSubmitL1Action` result into the leg's real outcome — never infers success from the promise merely resolving; an HTTP-200 response with a per-item `{error}` is still a failure (see `extractActionErrors`), and a rejected promise (network/timeout) is genuinely ambiguous, not a confirmed failure. */
function applyLegOutcome(attempt: LegAttempt, result: PromiseSettledResult<ExchangeActionResponse>): void {
  if (result.status === "rejected") {
    attempt.status = "unknown";
    attempt.error = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return;
  }
  const errors = extractActionErrors(result.value);
  if (errors.length > 0) {
    attempt.status = "error";
    attempt.error = errors.join("; ");
    return;
  }
  const status = result.value.response?.data?.statuses?.[0] as
    | { resting?: { oid: number }; filled?: { oid: number; totalSz: string; avgPx: string } }
    | undefined;
  if (status?.filled) {
    attempt.status = Number(status.filled.totalSz) >= attempt.sizeRequested ? "filled" : "partial";
    attempt.oid = status.filled.oid;
    attempt.filledSize = Number(status.filled.totalSz);
    attempt.avgPx = Number(status.filled.avgPx);
  } else if (status?.resting) {
    // An IOC resting isn't a real fate (IOC either fills or is cancelled) — handled defensively
    // rather than assumed, treated as unresolved so a later reconcile/verify pass catches it.
    attempt.status = "resting";
    attempt.oid = status.resting.oid;
  } else {
    attempt.status = "unknown";
  }
}

function summarizeFills(fills: UserFill[]): { size: number; avgPx: number; fee: number; closedPnl: number } {
  const size = fills.reduce((sum, f) => sum + Number(f.sz), 0);
  const notional = fills.reduce((sum, f) => sum + Number(f.sz) * Number(f.px), 0);
  const fee = fills.reduce((sum, f) => sum + Number(f.fee), 0);
  const closedPnl = fills.reduce((sum, f) => sum + Number(f.closedPnl), 0);
  return { size, avgPx: size > 0 ? notional / size : 0, fee, closedPnl };
}

async function pollForFillByCloid(userAddress: Address, cloid: Hex, attempts = 5, delayMs = 400): Promise<UserFill[]> {
  for (let i = 0; i < attempts; i++) {
    const fills = await fetchUserFills(userAddress);
    const matches = fills.filter((f) => f.cloid?.toLowerCase() === cloid.toLowerCase());
    if (matches.length > 0) return matches;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return [];
}

/**
 * Submits two legs as close together as two independent stateless `/exchange` POSTs can be
 * (`Promise.allSettled` — no true cross-order atomicity exists in the API), then parses each
 * result independently regardless of the other's outcome. Never assumes both filled from HTTP 200.
 */
async function submitTwoLegs(
  signer: L1ActionSigner,
  legA: { params: LimitOrderParams; attempt: LegAttempt },
  legB: { params: LimitOrderParams; attempt: LegAttempt },
): Promise<void> {
  const [resA, resB] = await Promise.allSettled([
    signAndSubmitL1Action(signer, buildLimitOrderAction(legA.params)),
    signAndSubmitL1Action(signer, buildLimitOrderAction(legB.params)),
  ]);
  applyLegOutcome(legA.attempt, resA);
  applyLegOutcome(legB.attempt, resB);
}

/** Cross-checks a leg's immediate-response outcome against Hyperliquid's actual fill records (the real proof of what happened, not the synchronous order-response alone) — overwrites the attempt with authoritative fill size/price/fee/PnL when found. */
async function verifyLeg(userAddress: Address, attempt: LegAttempt): Promise<void> {
  if (attempt.status !== "filled" && attempt.status !== "partial") return;
  const fills = await pollForFillByCloid(userAddress, attempt.cloid);
  if (fills.length === 0) return;
  const { size, avgPx, fee, closedPnl } = summarizeFills(fills);
  attempt.filledSize = size;
  attempt.avgPx = avgPx;
  attempt.fee = fee;
  attempt.closedPnl = closedPnl;
  attempt.status = size >= attempt.sizeRequested ? "filled" : size > 0 ? "partial" : "error";
}

/**
 * Safety net for any leg left in a non-terminal state (e.g. the process crashed between
 * persisting the attempt and getting a response) — queries Hyperliquid's actual open orders and
 * fills before ever deciding anything, the same "never treat ambiguity as failure, check real
 * status first" principle this app already applies to Salt transaction timeouts. Re-derives
 * attributable quantities from the full attempt history afterward, so stored state can't drift
 * from what Hyperliquid actually confirms.
 */
export async function reconcileStrategy(strategy: DeltaNeutralStrategy, userAddress: Address): Promise<DeltaNeutralStrategy> {
  const pending = [...strategy.openLegs.spot, ...strategy.openLegs.perp, ...strategy.closeLegs.spot, ...strategy.closeLegs.perp, ...strategy.rebalanceLegs].filter(
    (a) => a.status === "submitted" || a.status === "unknown" || a.status === "resting",
  );
  if (pending.length === 0) return strategy;

  const [openOrders, fills] = await Promise.all([fetchOpenOrders(userAddress), fetchUserFills(userAddress)]);
  for (const attempt of pending) {
    const matchingFills = fills.filter((f) => f.cloid?.toLowerCase() === attempt.cloid.toLowerCase());
    if (matchingFills.length > 0) {
      const { size, avgPx, fee, closedPnl } = summarizeFills(matchingFills);
      attempt.filledSize = size;
      attempt.avgPx = avgPx;
      attempt.fee = fee;
      attempt.closedPnl = closedPnl;
      attempt.status = size >= attempt.sizeRequested ? "filled" : size > 0 ? "partial" : "error";
      continue;
    }
    const stillOpen = openOrders.find((o) => o.cloid?.toLowerCase() === attempt.cloid.toLowerCase());
    if (stillOpen) {
      attempt.status = "resting";
      attempt.oid = stillOpen.oid;
      continue;
    }
    // Neither a fill nor an open order carries this cloid — for an IOC that means it was cancelled
    // with zero fill (its only other fate). Resolved, not left ambiguous forever.
    attempt.status = "error";
    attempt.error ??= "No matching fill or open order found on Hyperliquid — likely never filled.";
    attempt.filledSize ??= 0;
  }

  recomputeAttributableQuantities(strategy);
  saveStrategy(strategy);
  return strategy;
}

// --- Open ----------------------------------------------------------------------------

export async function executeDeltaNeutralOpen({
  accountId,
  userAddress,
  signer,
  context,
  plan,
}: {
  accountId: string;
  userAddress: Address;
  signer: L1ActionSigner;
  context: DeltaNeutralContext;
  plan: DeltaNeutralOpenPlan;
}): Promise<DeltaNeutralStrategy> {
  const { pair, markets, spotPrice, perpMark } = context;
  const { spotQty, perpQty } = plan.allocation;

  const strategy: DeltaNeutralStrategy = {
    id: generateStrategyId(),
    accountId,
    pair,
    status: "OPENING",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetCapital: plan.capital,
    perpLeverage: plan.perpLeverage,
    perpAssetIndex: markets.perpAssetIndex,
    spotSymbol: markets.spotSymbol,
    spotPairIndex: markets.spotPairIndex,
    spotSzDecimals: markets.spotSzDecimals,
    perpSzDecimals: markets.perpSzDecimals,
    openLegs: { spot: [], perp: [] },
    closeLegs: { spot: [], perp: [] },
    rebalanceLegs: [],
    currentSpotQty: 0,
    currentPerpQty: 0,
    spotCostBasis: 0,
    fees: 0,
    accumulatedFunding: 0,
    realizedSpotPnl: 0,
    realizedPerpPnl: 0,
  };
  saveStrategy(strategy);

  // Isolated margin, per spec — set before the order that opens the perp leg.
  await signAndSubmitL1Action(signer, buildUpdateLeverageAction({ assetIndex: markets.perpAssetIndex, leverage: plan.perpLeverage, isCross: false }));

  const spotAttempt = buildLegAttempt({ assetIndex: spotAssetId(markets.spotPairIndex), isBuy: true, size: spotQty });
  const perpAttempt = buildLegAttempt({ assetIndex: markets.perpAssetIndex, isBuy: false, size: perpQty });
  // Persist the attempts — with their cloids — BEFORE firing the HTTP calls, so a crash mid-flight
  // still leaves a reconcilable record instead of an untracked in-flight order.
  strategy.openLegs = { spot: [spotAttempt], perp: [perpAttempt] };
  saveStrategy(strategy);

  const spotLimitPx = roundSpotPrice(spotPrice * (1 + MARKET_ORDER_SLIPPAGE), markets.spotSzDecimals);
  const perpLimitPx = marketOrderLimitPrice(perpMark, false, markets.perpSzDecimals);

  await submitTwoLegs(
    signer,
    { params: { assetIndex: spotAttempt.assetIndex, isBuy: true, limitPx: spotLimitPx, size: spotQty, tif: "Ioc", cloid: spotAttempt.cloid }, attempt: spotAttempt },
    { params: { assetIndex: perpAttempt.assetIndex, isBuy: false, limitPx: perpLimitPx, size: perpQty, tif: "Ioc", cloid: perpAttempt.cloid }, attempt: perpAttempt },
  );
  saveStrategy(strategy);

  await Promise.all([verifyLeg(userAddress, spotAttempt), verifyLeg(userAddress, perpAttempt)]);

  recomputeAttributableQuantities(strategy);
  strategy.spotCostBasis = strategy.currentSpotQty * (spotAttempt.avgPx ?? 0);
  strategy.fees = (spotAttempt.fee ?? 0) + (perpAttempt.fee ?? 0);

  const exposure = computeNetExposure({
    spotQty: strategy.currentSpotQty,
    perpQty: Math.abs(strategy.currentPerpQty),
    spotPrice: spotAttempt.avgPx ?? spotPrice,
    perpMark: perpAttempt.avgPx ?? perpMark,
  });
  const bothFilled = spotAttempt.status === "filled" && perpAttempt.status === "filled";
  strategy.status = bothFilled && !isUnbalanced(exposure.imbalancePct) ? "OPEN" : "UNBALANCED";

  saveStrategy(strategy);
  return strategy;
}

// --- Dashboard -----------------------------------------------------------------------

export interface DashboardView {
  strategy: DeltaNeutralStrategy;
  liveSpotQty: number;
  livePerpQty: number;
  spotPrice: number;
  perpMark: number;
  spotExposure: number;
  perpExposure: number;
  grossExposure: number;
  netExposure: number;
  imbalancePct: number;
  unbalanced: boolean;
  fundingReceived: number;
  fees: number;
  strategyPnl: number;
  currentFundingRatePerHour: number;
  divergenceWarning?: string;
}

export async function computeDashboard(strategy: DeltaNeutralStrategy, userAddress: Address): Promise<DashboardView> {
  const [spot, perp, [, assetCtxs], book] = await Promise.all([
    fetchSpotClearinghouseState(userAddress),
    fetchClearinghouseState(userAddress),
    fetchMetaAndAssetCtxs(),
    fetchL2Book(`@${strategy.spotPairIndex}`),
  ]);

  const spotBalanceEntry = spot.balances.find((b) => b.coin === strategy.spotSymbol);
  // Available (sellable) qty: exclude anything on hold (e.g. resting orders), matching every other
  // spot read in this codebase. planWindDown caps the sell size at this, so `total` alone would
  // over-size the closing IOC beyond what can actually fill.
  const liveSpotQty = spotBalanceEntry ? Number(spotBalanceEntry.total) - Number(spotBalanceEntry.hold) : 0;
  const perpPosition = perp.assetPositions.find((ap) => ap.position.coin === strategy.pair);
  const livePerpQty = perpPosition ? Number(perpPosition.position.szi) : 0;

  let divergenceWarning: string | undefined;
  if (liveSpotQty < strategy.currentSpotQty) {
    divergenceWarning = `Wallet holds less ${strategy.pair} spot (${liveSpotQty}) than this strategy tracks as its own (${strategy.currentSpotQty}) — funds may have moved outside the strategy.`;
  }

  const bestBid = Number(book.levels[0][0]?.px ?? 0);
  const bestAsk = Number(book.levels[1][0]?.px ?? 0);
  const spotPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
  const perpCtx = assetCtxs[strategy.perpAssetIndex];
  const perpMark = Number(perpCtx?.markPx ?? 0);

  const exposure = computeNetExposure({ spotQty: strategy.currentSpotQty, perpQty: Math.abs(strategy.currentPerpQty), spotPrice, perpMark });
  const unbalanced = isUnbalanced(exposure.imbalancePct);
  if (unbalanced && strategy.status === "OPEN") {
    strategy.status = "UNBALANCED";
    saveStrategy(strategy);
  }

  // Hyperliquid nets funding at the whole-position level, not per-strategy — accurate only if the
  // account's entire perp exposure in this pair belongs to this strategy. Surfaced as-is (matching this
  // app's existing cumFunding caveat elsewhere), not silently presented as exact.
  // Hyperliquid's cumFunding.sinceOpen is POSITIVE when funding was *paid* — negate it for a
  // trader-facing "received" figure (matches fundingCell / portfolio's fundingPnl convention). A
  // delta-neutral short earning funding has a negative cumFunding, so this reads as income. This
  // value also feeds executeWindDown → strategy.accumulatedFunding, so the fix carries through to
  // the realized P&L.
  const fundingReceived = perpPosition ? -Number(perpPosition.position.cumFunding.sinceOpen) : strategy.accumulatedFunding;
  const spotUnrealizedPnl = strategy.currentSpotQty * spotPrice - strategy.spotCostBasis;
  const perpUnrealizedPnl = perpPosition ? Number(perpPosition.position.unrealizedPnl) : 0;
  const strategyPnl = spotUnrealizedPnl + perpUnrealizedPnl + fundingReceived - strategy.fees;

  return {
    strategy,
    liveSpotQty,
    livePerpQty,
    spotPrice,
    perpMark,
    spotExposure: exposure.spotExposure,
    perpExposure: exposure.perpExposure,
    grossExposure: exposure.grossExposure,
    netExposure: exposure.netExposure,
    imbalancePct: exposure.imbalancePct,
    unbalanced,
    fundingReceived,
    fees: strategy.fees,
    strategyPnl,
    currentFundingRatePerHour: Number(perpCtx?.funding ?? 0),
    divergenceWarning,
  };
}

// --- Rebalance -------------------------------------------------------------------------

export interface RebalancePlan {
  strategy: DeltaNeutralStrategy;
  dashboard: DashboardView;
  isBuy: boolean;
  size: number;
  estimatedNotional: number;
}

/** Returns `undefined` when already within the 1% threshold — nothing to correct. Always corrects via the perp leg (doesn't touch spot USDC/pair balances, so it's the simpler single order). */
export async function planRebalance(strategy: DeltaNeutralStrategy, userAddress: Address): Promise<RebalancePlan | undefined> {
  const dashboard = await computeDashboard(strategy, userAddress);
  if (!dashboard.unbalanced) return undefined;

  const qtyDelta = strategy.currentSpotQty - Math.abs(strategy.currentPerpQty); // positive = net long the pair
  const isBuy = qtyDelta < 0; // perp short exceeds spot -> buy back (reduce) the short
  const size = Math.round(Math.abs(qtyDelta) * 10 ** strategy.perpSzDecimals) / 10 ** strategy.perpSzDecimals;

  return { strategy, dashboard, isBuy, size, estimatedNotional: size * dashboard.perpMark };
}

export async function executeRebalance(userAddress: Address, signer: L1ActionSigner, plan: RebalancePlan): Promise<DeltaNeutralStrategy> {
  const { strategy } = plan;
  const attempt = buildLegAttempt({ assetIndex: strategy.perpAssetIndex, isBuy: plan.isBuy, size: plan.size });
  strategy.rebalanceLegs.push(attempt);
  saveStrategy(strategy);

  const limitPx = marketOrderLimitPrice(plan.dashboard.perpMark, plan.isBuy, strategy.perpSzDecimals);
  const [result] = await Promise.allSettled([
    signAndSubmitL1Action(
      signer,
      buildLimitOrderAction({ assetIndex: strategy.perpAssetIndex, isBuy: plan.isBuy, limitPx, size: plan.size, reduceOnly: plan.isBuy, tif: "Ioc", cloid: attempt.cloid }),
    ),
  ]);
  applyLegOutcome(attempt, result);
  await verifyLeg(userAddress, attempt);

  strategy.fees += attempt.fee ?? 0;
  if (plan.isBuy) strategy.realizedPerpPnl += attempt.closedPnl ?? 0;
  recomputeAttributableQuantities(strategy);

  const exposure = computeNetExposure({
    spotQty: strategy.currentSpotQty,
    perpQty: Math.abs(strategy.currentPerpQty),
    spotPrice: plan.dashboard.spotPrice,
    perpMark: plan.dashboard.perpMark,
  });
  strategy.status = isUnbalanced(exposure.imbalancePct) ? "UNBALANCED" : "OPEN";
  saveStrategy(strategy);
  return strategy;
}

// --- Wind Down -------------------------------------------------------------------------

export interface WindDownPlan {
  strategy: DeltaNeutralStrategy;
  dashboard: DashboardView;
  spotSellQty: number;
  perpBuyQty: number;
}

/** Sizes both closing legs from this strategy's own tracked quantities only — never "close all X," since the account may hold unrelated X. `spotSellQty` is capped at the live wallet balance in case less is actually available than tracked. */
export async function planWindDown(strategy: DeltaNeutralStrategy, userAddress: Address): Promise<WindDownPlan> {
  const dashboard = await computeDashboard(strategy, userAddress);
  return {
    strategy,
    dashboard,
    spotSellQty: Math.min(strategy.currentSpotQty, dashboard.liveSpotQty),
    perpBuyQty: Math.abs(strategy.currentPerpQty),
  };
}

export async function executeWindDown(userAddress: Address, signer: L1ActionSigner, plan: WindDownPlan): Promise<DeltaNeutralStrategy> {
  const { strategy } = plan;
  strategy.status = "CLOSING";
  // Capture funding-to-date before the position (and its cumFunding) potentially closes to zero.
  strategy.accumulatedFunding = plan.dashboard.fundingReceived;
  saveStrategy(strategy);

  const spotAttempt = buildLegAttempt({ assetIndex: spotAssetId(strategy.spotPairIndex), isBuy: false, size: plan.spotSellQty });
  const perpAttempt = buildLegAttempt({ assetIndex: strategy.perpAssetIndex, isBuy: true, size: plan.perpBuyQty });
  strategy.closeLegs = {
    spot: [...strategy.closeLegs.spot, spotAttempt],
    perp: [...strategy.closeLegs.perp, perpAttempt],
  };
  saveStrategy(strategy);

  const spotLimitPx = roundSpotPrice(plan.dashboard.spotPrice * (1 - MARKET_ORDER_SLIPPAGE), strategy.spotSzDecimals);
  const perpLimitPx = marketOrderLimitPrice(plan.dashboard.perpMark, true, strategy.perpSzDecimals);

  await submitTwoLegs(
    signer,
    { params: { assetIndex: spotAttempt.assetIndex, isBuy: false, limitPx: spotLimitPx, size: plan.spotSellQty, tif: "Ioc", cloid: spotAttempt.cloid }, attempt: spotAttempt },
    {
      params: { assetIndex: perpAttempt.assetIndex, isBuy: true, limitPx: perpLimitPx, size: plan.perpBuyQty, reduceOnly: true, tif: "Ioc", cloid: perpAttempt.cloid },
      attempt: perpAttempt,
    },
  );
  saveStrategy(strategy);

  await Promise.all([verifyLeg(userAddress, spotAttempt), verifyLeg(userAddress, perpAttempt)]);

  const spotClosedQty = spotAttempt.filledSize ?? 0;
  const spotCostOfSold = strategy.currentSpotQty > 0 ? strategy.spotCostBasis * (spotClosedQty / strategy.currentSpotQty) : 0;
  const spotProceeds = spotClosedQty * (spotAttempt.avgPx ?? 0);

  strategy.spotCostBasis = Math.max(0, strategy.spotCostBasis - spotCostOfSold);
  strategy.realizedSpotPnl += spotProceeds - spotCostOfSold;
  strategy.realizedPerpPnl += perpAttempt.closedPnl ?? 0;
  strategy.fees += (spotAttempt.fee ?? 0) + (perpAttempt.fee ?? 0);

  recomputeAttributableQuantities(strategy);

  // Exact-zero float comparisons are unreliable — use each market's own size precision as epsilon.
  const spotEpsilon = 10 ** -strategy.spotSzDecimals;
  const perpEpsilon = 10 ** -strategy.perpSzDecimals;
  const fullyClosed = strategy.currentSpotQty <= spotEpsilon && Math.abs(strategy.currentPerpQty) <= perpEpsilon;
  strategy.status = fullyClosed ? "COMPLETE" : "CLOSING";

  saveStrategy(strategy);
  return strategy;
}

export function computeFinalStrategyPnl(strategy: DeltaNeutralStrategy): number {
  return strategy.realizedSpotPnl + strategy.realizedPerpPnl + strategy.accumulatedFunding - strategy.fees;
}
