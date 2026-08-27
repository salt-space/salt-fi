import * as p from "@clack/prompts";
import type { Salt, SaltAccount, SaltTypedData } from "salt-sdk";
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hyperEvmTestnet } from "../chains.js";
import { reportError } from "../errors.js";
import {
  agentKeySigner,
  buildApproveAgentTypedData,
  buildCancelOrderAction,
  buildLimitOrderAction,
  buildSendAssetTypedData,
  buildUpdateLeverageAction,
  buildUsdClassTransferTypedData,
  coreSystemAddress,
  extractActionErrors,
  fetchAllMids,
  fetchClearinghouseState,
  fetchExtraAgents,
  fetchFundingRates,
  fetchL2Book,
  fetchMeta,
  fetchOpenOrders,
  fetchSpotClearinghouseState,
  fetchSpotMeta,
  fetchUserFills,
  findSpotPairAgainstUsdc,
  getAgentMetadata,
  marketOrderLimitPrice,
  MARKET_ORDER_SLIPPAGE,
  resolveSpotCoin,
  roundPerpPrice,
  roundSpotPrice,
  signAndSubmitL1Action,
  spotAssetId,
  HYPE_CORE_SYSTEM_ADDRESS,
  HYPE_CORE_TOKEN_ID,
  HYPEREVM_CHAIN_ID,
  HYPEREVM_RPC_URL,
  saveAgentMetadata,
  submitApproveAgent,
  submitSendAsset,
  submitUsdClassTransfer,
  touchAgentVerified,
  USDC_CORE_TOKEN_ID,
  USDC_CORE_TOKEN_INDEX,
  USDC_HYPEREVM_ADDRESS,
  type ClearinghouseState,
  type ExchangeActionResponse,
  type HyperliquidSignature,
  type L1ActionSigner,
  type OpenOrder,
  type OrderSide,
  type PerpMeta,
  type UserFill,
} from "../hyperliquid.js";
import {
  computeAccountImpact,
  computeLeverageOptions,
  computeOrderSizing,
  estimateIsolatedLiquidationPrice,
  validateMargin,
} from "../hyperliquid-risk.js";
import { pickOrganisation, select } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Org -> eligible-account picker shared by every Hyperliquid flow: an
 * "eligible" account is one that's finished MPC setup (has an `evmAddress`)
 * and that the caller is a signer on. Mirrors swap.ts's `fastSwapFlow`.
 */
async function pickHyperliquidAccount(
  salt: Salt,
  walletClient: SaltWalletClient,
  message: string,
): Promise<{ accountId: string; account: SaltAccount } | undefined> {
  const selfAddress = walletClient.account.address;

  // Escape hatch for orgs with a large number of accounts: set HL_ACCOUNT_ID to
  // an account id or evm address to target it directly and skip the org + account
  // pickers. Falls back to the pickers if it doesn't resolve to an eligible
  // account you sign on.
  const pin = process.env.HL_ACCOUNT_ID?.toLowerCase();
  if (pin) {
    for (const org of await salt.getOrganisations()) {
      const accs = await salt.getAccounts(org.id).catch(() => [] as SaltAccount[]);
      const hit = accs.find(
        (a) => a.id.toLowerCase() === pin || (a.evmAddress ?? "").toLowerCase() === pin,
      );
      if (hit?.evmAddress && hit.signers.some((s) => s.toLowerCase() === selfAddress.toLowerCase())) {
        p.log.info(`Using account "${hit.name}" (${hit.evmAddress}) via HL_ACCOUNT_ID.`);
        return { accountId: hit.id, account: hit };
      }
    }
    p.log.warn(`HL_ACCOUNT_ID "${process.env.HL_ACCOUNT_ID}" didn't match an account you sign on — falling back to the pickers.`);
  }

  const organisationId = await pickOrganisation(salt, "Which organisation?");
  if (!organisationId) return undefined;

  let accounts: SaltAccount[];
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return undefined;
  }

  const eligible = accounts.filter(
    (a) => Boolean(a.evmAddress) && a.signers.some((s) => s.toLowerCase() === selfAddress.toLowerCase()),
  );
  if (eligible.length === 0) {
    p.log.info("No accounts here are both fully set up and ones you're a signer on.");
    return undefined;
  }

  const accountId = await select({
    message,
    options: eligible.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress })),
  });
  if (p.isCancel(accountId)) return undefined;
  const account = eligible.find((a) => a.id === accountId)!;
  return { accountId, account };
}

function signatureFromEvm(sig: { r: `0x${string}`; s: `0x${string}`; v: bigint }): HyperliquidSignature {
  return { r: sig.r, s: sig.s, v: Number(sig.v) };
}

// --- Order-signing: agent key (fast, no ceremony) vs. Salt MPC ceremony (slower, no local key) --

/**
 * Agent private keys entered here live only in this map, in this process's memory, for the
 * rest of the run — never written to disk. Keyed by accountId since one account has at most
 * one approved agent at a time in this app's model.
 */
const agentSignerCache = new Map<string, L1ActionSigner>();

const PRIVATE_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Prompts for the agent wallet's raw private key (masked input), verifies it actually derives
 * the address that was approved on Hyperliquid (catches pasting the wrong key outright, rather
 * than failing confusingly at signature-verification time later), and caches the resulting
 * signer in memory for the rest of this session. Returns `undefined` on cancel or a mismatched
 * key — never caches or uses a key that doesn't match.
 */
async function resolveAgentKeySigner(accountId: string, expectedAgentAddress: Address): Promise<L1ActionSigner | undefined> {
  const cached = agentSignerCache.get(accountId);
  if (cached) return cached;

  const keyInput = await p.password({
    message: `Private key for agent ${expectedAgentAddress}\nHeld in memory only for this run — never written to disk.`,
    validate: (v) => (!v || !PRIVATE_KEY_PATTERN.test(v.trim()) ? "Enter a 32-byte private key (64 hex chars, with or without 0x)" : undefined),
  });
  if (p.isCancel(keyInput)) return undefined;

  const trimmed = keyInput.trim();
  const privateKey = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
  const derivedAddress = privateKeyToAccount(privateKey).address;
  if (derivedAddress.toLowerCase() !== expectedAgentAddress.toLowerCase()) {
    p.log.error(`That key derives to ${derivedAddress}, not the approved agent ${expectedAgentAddress} — not using it.`);
    return undefined;
  }

  const signer = agentKeySigner(privateKey);
  agentSignerCache.set(accountId, signer);
  return signer;
}

/**
 * Wraps a Salt MPC ceremony as an {@link L1ActionSigner} — signs the same "phantom agent"
 * EIP-712 struct the agent-key path does, but via `salt.signTypedData` instead of a local key.
 * The fallback/experimental path: no local key needed at all, but a full presence-and-sign
 * ceremony runs on every single order/cancel instead of once per session.
 */
function mpcCeremonySigner(salt: Salt, walletClient: SaltWalletClient, accountId: string, onPresence: (joined: number, total: number) => void): L1ActionSigner {
  return {
    async signAgent(args) {
      const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData: args as SaltTypedData });
      ceremony.on("presence", (event) => onPresence(event.joined, event.total));
      const { signature } = await ceremony.wait();
      return signatureFromEvm(signature);
    },
  };
}

type SigningChoice = { kind: "agent"; signer: L1ActionSigner } | { kind: "mpc" };

/**
 * Prompts for how this order/cancel will be signed — deliberately runs *before* any spinner is
 * started, since interactive prompts (the method choice, and the agent-key password if needed)
 * don't play nicely rendered underneath a spinner. If a verified agent exists for the account,
 * offers the fast agent-key path alongside the MPC-ceremony fallback; otherwise MPC is the only
 * option. The MPC signer itself is built later, once the caller has its own spinner to bind
 * presence updates to — see {@link mpcCeremonySigner}. Returns `undefined` on cancel or a
 * mismatched/rejected agent key.
 */
async function chooseOrderSigningMethod(accountId: string): Promise<SigningChoice | undefined> {
  const agentMeta = getAgentMetadata(accountId);
  const hasVerifiedAgent = Boolean(agentMeta?.lastVerified);

  if (!hasVerifiedAgent) {
    p.log.info(
      "No verified agent on this account yet, so this will sign via a Salt MPC ceremony instead. " +
        'Approve an agent via "Getting Started" for faster, ceremony-free order signing.',
    );
    return { kind: "mpc" };
  }

  const choice = await select({
    message: "Sign this order with:",
    options: [
      { value: "agent", label: "Agent key", hint: "fast, no ceremony — needs the agent's private key" },
      { value: "mpc", label: "Salt MPC ceremony", hint: "slower, no local key — experimental for order signing" },
    ],
  });
  if (p.isCancel(choice)) return undefined;
  if (choice === "mpc") return { kind: "mpc" };

  const signer = await resolveAgentKeySigner(accountId, agentMeta!.agentAddress);
  return signer ? { kind: "agent", signer } : undefined;
}

// --- Formatting helpers --------------------------------------------------------

function fmtUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Same as {@link fmtUsd} but always carries an explicit +/- sign — for PnL and funding, where the sign is the point. */
function fmtSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(value: string | number, maxDecimals = 4): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

/** `returnOnEquity` from Hyperliquid is already a decimal fraction (e.g. `0.05` = 5%). */
function fmtPct(fraction: number): string {
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(2)}%`;
}

function fmtSide(side: OrderSide): string {
  return side === "B" ? "Buy " : "Sell";
}

/**
 * A compact per-position funding cell: accrued **Funding P&L** since the position
 * opened (+ earned / − paid) plus the **current hourly rate** and whether THIS
 * position pays or earns it. `cumFundingSinceOpen` follows Hyperliquid's
 * convention (positive = funding *paid*), so the trader's Funding P&L is its
 * negation. `rate` is the coin's current hourly funding (positive = longs pay);
 * a position pays when its side matches the rate's sign.
 */
function fundingCell(szi: number, cumFundingSinceOpen: number, rate: number | undefined): string {
  const pnl = fmtSignedUsd(-cumFundingSinceOpen); // + = net received, − = net paid
  if (rate === undefined) return pnl;
  if (rate === 0) return `${pnl}  0%/h flat`;
  const paying = Math.sign(szi) === Math.sign(rate); // long + positive rate ⇒ pays
  return `${pnl}  ${(rate * 100).toFixed(4)}%/h ${paying ? "pay" : "earn"}`;
}

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Right-pads every row to the same column widths so a table reads cleanly in a monospace terminal. */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

// --- Getting Started ---------------------------------------------------------

export async function hyperliquidGettingStartedFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Set up Hyperliquid for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  p.note(
    "Salt is the vault: it owns the funds and positions on Hyperliquid.\n" +
      "An agent wallet is a trading badge — an address you authorize to place\n" +
      "and cancel orders on this account's behalf. It never holds funds, and\n" +
      "you can revoke it at any time. Approving (or revoking) an agent runs\n" +
      "Salt's MPC signing ceremony once; the agent itself trades without it.",
    "Owner vs. agent",
  );

  const s = p.spinner();
  s.start("Checking Hyperliquid account");
  let extraAgents;
  try {
    extraAgents = await fetchExtraAgents(userAddress);
    s.stop(
      extraAgents.length > 0
        ? `Found ${extraAgents.length} approved agent(s) already on this account`
        : "No agents approved yet on this account",
    );
  } catch (err) {
    s.stop("Couldn't reach Hyperliquid");
    reportError(err);
    return;
  }

  if (extraAgents.length > 0) {
    p.log.message(
      extraAgents
        .map((a) => `  • ${a.name || "(unnamed)"} — ${a.address}\n    valid until ${new Date(a.validUntil).toLocaleString()}`)
        .join("\n"),
    );
  }

  // Confirmed empirically against testnet: Hyperliquid rejects *any* signed
  // action, including approveAgent, with "Must deposit before performing
  // actions" until HyperCore has a deposit on record for this address. So
  // this has to be checked and short-circuited here, before offering to
  // approve — otherwise the ceremony succeeds but the submission fails with
  // a confusing API error after the (real, MPC) work is already done.
  if (extraAgents.length === 0) {
    const spot = await fetchSpotClearinghouseState(userAddress);
    const perp = await fetchClearinghouseState(userAddress);
    const hasDeposit =
      ((spot.balances as unknown[] | undefined)?.length ?? 0) > 0 ||
      Number((perp.marginSummary as { accountValue?: string } | undefined)?.accountValue ?? "0") > 0;
    if (!hasDeposit) {
      p.log.warn(
        "This account has no funds on HyperCore yet. Hyperliquid won't accept an agent approval (or any\n" +
          'signed action) until something has been deposited. Use "Move Funds" -> "Deposit" first, then come\n' +
          "back here.",
      );
      return;
    }
  }

  const proceed = await p.confirm({
    message: extraAgents.length > 0 ? "Approve another agent wallet?" : "Approve an agent wallet now?",
    initialValue: extraAgents.length === 0,
  });
  if (p.isCancel(proceed) || !proceed) return;

  const agentAddressInput = await p.text({
    message: "Agent wallet address to approve — an EOA you already control; salt-fi never sees or stores its private key",
    validate: (v) => (!v || !ADDRESS_PATTERN.test(v) ? "Enter a valid 0x-prefixed address" : undefined),
  });
  if (p.isCancel(agentAddressInput)) return;
  const agentAddress = agentAddressInput as Address;

  const agentNameInput = await p.text({
    message: "Name for this agent (shown in Hyperliquid's UI)",
    placeholder: "salt-fi agent",
    defaultValue: "salt-fi agent",
  });
  if (p.isCancel(agentNameInput)) return;
  const agentName = agentNameInput || "salt-fi agent";

  const confirmed = await p.confirm({
    message: `Approve ${agentAddress} as a trading agent for "${account.name}"? This starts an MPC signing ceremony.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const nonce = Date.now();
  const typedData = buildApproveAgentTypedData({ agentAddress, agentName, nonce });

  const ceremonySpinner = p.spinner();
  ceremonySpinner.start("Starting agent-approval signing ceremony");
  try {
    const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData });
    ceremony.on("presence", (event) => {
      ceremonySpinner.message(`Waiting for signers: ${event.joined}/${event.total} joined`);
    });
    const { signature } = await ceremony.wait();
    ceremonySpinner.message("Submitting approval to Hyperliquid");
    await submitApproveAgent({ agentAddress, agentName, nonce }, signatureFromEvm(signature));
    ceremonySpinner.stop("Agent approved");
  } catch (err) {
    ceremonySpinner.stop("Agent approval failed");
    reportError(err);
    return;
  }

  saveAgentMetadata(accountId, { agentAddress, agentName, approvedAt: Date.now() });

  const verifySpinner = p.spinner();
  verifySpinner.start("Verifying approval");
  try {
    const updated = await fetchExtraAgents(userAddress);
    const match = updated.find((a) => a.address.toLowerCase() === agentAddress.toLowerCase());
    if (match) {
      touchAgentVerified(accountId, Date.now());
      verifySpinner.stop("Verified — Hyperliquid confirms this agent is approved");
      p.log.success(
        `Active agent: ${match.name || "(unnamed)"} — ${match.address}\n  valid until ${new Date(match.validUntil).toLocaleString()}`,
      );
    } else {
      verifySpinner.stop("Hyperliquid doesn't show this agent yet — it may take a moment to propagate. Re-run Getting Started to re-check.");
    }
  } catch (err) {
    verifySpinner.stop("Couldn't verify");
    reportError(err);
  }
}

// --- Move Funds ---------------------------------------------------------------
//
// Three separate buckets, and "funding trading" means moving value all the way through all of
// them, not just the first hop:
//   HyperEVM  --(plain transfer)-->  HyperCore Spot  --(sell for USDC, if needed)-->
//   HyperCore Spot USDC  --(UsdClassTransfer)-->  HyperCore Perps (margin)
// "Fund Trading" / "Withdraw Trading Funds" below orchestrate the full trip; "Advanced" exposes
// the individual hops (useful for anything that isn't about perp margin — spot-only usage,
// moving an asset without selling it, etc.).
//
// Security boundary that shapes the signer choices below: an approved agent wallet can sign L1
// actions (orders/cancels — see chooseOrderSigningMethod) on Hyperliquid's behalf, but NOT
// fund-movement actions (SendAsset, UsdClassTransfer) — those are scoped to the master account
// only, matching how this app already describes agents to users ("a trading badge... it never
// holds funds"). So every transfer primitive below always signs via a full Salt MPC ceremony on
// the master account; only the spot sell order gets a signing-method choice.

type SupportedFundingAsset = "HYPE" | "USDC";

// Confirmed live against testnet spotMeta: HYPE is 18 decimals on HyperEVM (native gas token),
// USDC is 6 (spotMeta's weiDecimals=8 + evm_extra_wei_decimals=-2).
const FUNDING_ASSET_DECIMALS: Record<SupportedFundingAsset, number> = { HYPE: 18, USDC: 6 };

/** Hyperliquid's minimum spot order value, confirmed via a live rejection ("Order must have minimum value of 10 USDC"). */
const SPOT_MIN_ORDER_USD = 10;

function hyperEvmPublicClient() {
  return createPublicClient({ chain: hyperEvmTestnet, transport: http(HYPEREVM_RPC_URL) });
}

const ERC20_TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
function encodeErc20Transfer(to: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to, amount] });
}

/** HyperEVM -> HyperCore Spot: a plain EVM transfer to Hyperliquid's system address, signed via Salt's normal transaction ceremony (no Hyperliquid-specific signing scheme involved). Returns the broadcast tx hash. */
async function transferHyperEvmToSpot(
  salt: Salt,
  walletClient: SaltWalletClient,
  accountId: string,
  asset: SupportedFundingAsset,
  amount: bigint,
  onProgress: (message: string) => void,
): Promise<string | undefined> {
  const destination = asset === "HYPE" ? HYPE_CORE_SYSTEM_ADDRESS : coreSystemAddress(USDC_CORE_TOKEN_INDEX);
  const ceremony = await salt.submitTx({
    accountId,
    to: asset === "HYPE" ? destination : USDC_HYPEREVM_ADDRESS,
    value: asset === "HYPE" ? amount : 0n,
    data: asset === "HYPE" ? "0x" : encodeErc20Transfer(destination, amount),
    chainId: HYPEREVM_CHAIN_ID,
    userAddress: walletClient.account.address,
    walletClient,
    publicClient: hyperEvmPublicClient(),
  });
  ceremony.on("stateChanged", (event) => onProgress(`${event.stage}...`));
  const { transaction } = await ceremony.wait();
  return transaction.broadcastReceipt?.transactionHash;
}

/** HyperCore Spot -> HyperEVM, via the signed `SendAsset` L1 action (master-account MPC ceremony — see the note above). */
async function transferSpotToHyperEvm(
  salt: Salt,
  walletClient: SaltWalletClient,
  accountId: string,
  asset: SupportedFundingAsset,
  amountDecimal: string,
  onPresence: (joined: number, total: number) => void,
): Promise<void> {
  const destination = asset === "HYPE" ? HYPE_CORE_SYSTEM_ADDRESS : coreSystemAddress(USDC_CORE_TOKEN_INDEX);
  const tokenId = asset === "HYPE" ? HYPE_CORE_TOKEN_ID : USDC_CORE_TOKEN_ID;
  const params = { destination, token: `${asset}:${tokenId}`, amount: amountDecimal, sourceDex: "spot", destinationDex: "spot", fromSubAccount: "", nonce: Date.now() };
  const typedData = buildSendAssetTypedData(params);
  const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData });
  ceremony.on("presence", (event) => onPresence(event.joined, event.total));
  const { signature } = await ceremony.wait();
  await submitSendAsset(params, signatureFromEvm(signature));
}

/** HyperCore Spot <-> Perps, via the signed `UsdClassTransfer` L1 action (master-account MPC ceremony — see the note above). */
async function transferUsdClass(
  salt: Salt,
  walletClient: SaltWalletClient,
  accountId: string,
  amountDecimal: string,
  toPerp: boolean,
  onPresence: (joined: number, total: number) => void,
): Promise<void> {
  const params = { amount: amountDecimal, toPerp, nonce: Date.now() };
  const typedData = buildUsdClassTransferTypedData(params);
  const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData });
  ceremony.on("presence", (event) => onPresence(event.joined, event.total));
  const { signature } = await ceremony.wait();
  await submitUsdClassTransfer(params, signatureFromEvm(signature));
}

// --- Fund Trading: HyperEVM -> Spot -> (sell for USDC) -> Perps ----------------

async function fundTradingFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Fund trading for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const accountAddress = account.evmAddress as Address;

  const asset = await select({
    message: "Pay with:",
    options: [
      { value: "HYPE", label: "HYPE", hint: "sold for USDC on HyperCore's own spot book, then moved to margin" },
      { value: "USDC", label: "USDC", hint: "moved straight to margin — no swap needed" },
    ],
  });
  if (p.isCancel(asset)) return;

  const decimals = FUNDING_ASSET_DECIMALS[asset];
  const amountInput = await p.text({
    message: `Amount of ${asset} to fund trading with`,
    validate: (v) => {
      if (!v) return "Amount is required";
      try {
        if (parseUnits(v, decimals) <= 0n) return "Amount must be greater than 0";
      } catch {
        return "Not a valid amount";
      }
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const amount = parseUnits(amountInput, decimals);

  // Check the sell will clear Hyperliquid's spot minimum-order-value rule *before* moving
  // anything — catching this after the HyperEVM->Spot transfer means the asset is stuck on Spot,
  // unsold, needing a manual cleanup via Advanced (this is exactly how that gap was found).
  if (asset === "HYPE") {
    const s0 = p.spinner();
    s0.start("Checking HYPE/USDC market");
    try {
      const spotMeta = await fetchSpotMeta();
      const resolved = findSpotPairAgainstUsdc(spotMeta, "HYPE");
      if (!resolved) throw new Error("Couldn't resolve the HYPE/USDC spot market");
      const book = await fetchL2Book(`@${resolved.pairIndex}`);
      const bestBid = Number(book.levels[0][0]?.px ?? 0);
      const estNotional = Number(amountInput) * bestBid;
      s0.stop(`Est. value at current best bid (${fmtNum(bestBid)}): ${fmtUsd(estNotional)}`);
      if (bestBid <= 0 || estNotional < SPOT_MIN_ORDER_USD) {
        const minAmount = bestBid > 0 ? SPOT_MIN_ORDER_USD / bestBid : undefined;
        p.log.error(
          `Hyperliquid requires spot orders worth at least ${fmtUsd(SPOT_MIN_ORDER_USD)} — ${amountInput} HYPE is only ~${fmtUsd(estNotional)}.` +
            (minAmount ? `\nTry at least ~${fmtNum(minAmount * 1.1)} HYPE to clear the minimum with some room for price movement.` : ""),
        );
        return;
      }
    } catch (err) {
      s0.stop("Failed to check market data");
      reportError(err);
      return;
    }
  }

  const plan = [`1. Transfer ${amountInput} ${asset} — HyperEVM -> HyperCore Spot`];
  if (asset === "HYPE") plan.push(`2. Sell ${amountInput} HYPE for USDC on HyperCore's spot book (market/IOC)`);
  plan.push(`${plan.length + 1}. Move the resulting USDC — HyperCore Spot -> Perps`);
  plan.push(`${plan.length + 1}. Confirm available perp collateral`);
  p.note(plan.join("\n"), "Funding plan");
  const confirmed = await p.confirm({ message: "Proceed?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s1 = p.spinner();
  s1.start(`Transferring ${amountInput} ${asset} to HyperCore`);
  try {
    const hash = await transferHyperEvmToSpot(salt, walletClient, accountId, asset, amount, (msg) => s1.message(`Transferring — ${msg}`));
    s1.stop(`Transferred — tx hash: ${hash ?? "(pending)"}`);
  } catch (err) {
    s1.stop("Transfer failed");
    reportError(err);
    return;
  }

  if (asset === "HYPE") {
    const sold = await sellSpotForUsdc(salt, walletClient, accountId, "HYPE", Number(amountInput));
    if (!sold) {
      p.log.warn(`${amountInput} HYPE reached HyperCore Spot but wasn't sold — sell it via Trade, then move the USDC to Perps via Advanced.`);
      return;
    }
  }

  const s3 = p.spinner();
  s3.start("Checking spot USDC balance");
  let usdcAvailable: number;
  try {
    const spot = await fetchSpotClearinghouseState(accountAddress);
    const usdc = spot.balances.find((b) => b.coin === "USDC");
    usdcAvailable = usdc ? Number(usdc.total) - Number(usdc.hold) : 0;
    s3.stop(`${fmtNum(usdcAvailable)} USDC available in Spot`);
  } catch (err) {
    s3.stop("Failed to check spot balance");
    reportError(err);
    return;
  }
  if (usdcAvailable <= 0) {
    p.log.warn("No available USDC in Spot to move to Perps.");
    return;
  }

  // Hyperliquid's usdClassTransfer rejects an amount its own coarser USD
  // accounting reads as exceeding the balance, so floor to 6 decimals — always
  // <= usdcAvailable, which clears the "Insufficient balance" full-balance edge.
  const moveAmount = Math.floor(usdcAvailable * 1e6) / 1e6;
  const s4 = p.spinner();
  s4.start("Starting Spot -> Perps signing ceremony");
  try {
    await transferUsdClass(salt, walletClient, accountId, String(moveAmount), true, (joined, total) => s4.message(`Waiting for signers: ${joined}/${total} joined`));
    s4.stop(`Moved ${fmtNum(moveAmount)} USDC to Perps`);
  } catch (err) {
    s4.stop("Spot -> Perps transfer failed");
    reportError(err);
    return;
  }

  const s5 = p.spinner();
  s5.start("Confirming perp collateral");
  try {
    const perp = await fetchClearinghouseState(accountAddress);
    s5.stop(`Available perp collateral: ${fmtUsd(Number(perp.withdrawable))}`);
  } catch (err) {
    s5.stop("Funded, but couldn't re-check the resulting balance");
    reportError(err);
  }
}

/**
 * Sells `size` of `baseAsset` for USDC on HyperCore's own spot order book (an aggressive IOC
 * limit against the best bid, not Hyperliquid's own mid — the HYPE/USDC book was observed to
 * carry a wide spread on testnet, wide enough that a flat mid-based slippage tolerance like
 * {@link marketOrderLimitPrice} uses for perps could miss the book entirely). Returns whether the
 * sell was submitted without an outright rejection — doesn't itself verify how much filled; the
 * caller re-checks the resulting spot USDC balance instead of trusting the fill amount reported
 * here, since an IOC can partially fill.
 */
async function sellSpotForUsdc(salt: Salt, walletClient: SaltWalletClient, accountId: string, baseAsset: string, size: number): Promise<boolean> {
  const s = p.spinner();
  s.start(`Fetching ${baseAsset}/USDC market`);
  let pairIndex: number;
  let szDecimals: number;
  let bestBid: number;
  try {
    const spotMeta = await fetchSpotMeta();
    const resolved = findSpotPairAgainstUsdc(spotMeta, baseAsset);
    if (!resolved) throw new Error(`Couldn't resolve a ${baseAsset}/USDC spot market`);
    ({ pairIndex, szDecimals } = resolved);
    const book = await fetchL2Book(`@${pairIndex}`);
    const bestBidLevel = book.levels[0][0];
    if (!bestBidLevel) throw new Error(`No bids on the ${baseAsset}/USDC book right now — try again shortly`);
    bestBid = Number(bestBidLevel.px);
    s.stop(`${baseAsset}/USDC best bid: ${fmtNum(bestBid)}`);
  } catch (err) {
    s.stop("Failed to fetch market data");
    reportError(err);
    return false;
  }

  const signingChoice = await chooseOrderSigningMethod(accountId);
  if (!signingChoice) return false;

  // 2% below the best bid so a thin/wide-spread book (as observed on testnet) doesn't reject the
  // IOC outright the way a flat mid-based slippage tolerance could.
  const limitPx = roundSpotPrice(bestBid * 0.98, szDecimals);

  const s2 = p.spinner();
  s2.start(signingChoice.kind === "mpc" ? "Starting signing ceremony" : `Selling ${baseAsset} for USDC`);
  const signer =
    signingChoice.kind === "agent"
      ? signingChoice.signer
      : mpcCeremonySigner(salt, walletClient, accountId, (joined, total) => s2.message(`Waiting for signers: ${joined}/${total} joined`));
  try {
    const action = buildLimitOrderAction({ assetIndex: spotAssetId(pairIndex), isBuy: false, limitPx, size, tif: "Ioc" });
    const response = await signAndSubmitL1Action(signer, action);
    const errors = extractActionErrors(response);
    if (errors.length > 0) {
      s2.stop(`Sell rejected — ${errors.join("; ")}`);
      return false;
    }
    s2.stop(describeOrderStatus(response));
    return true;
  } catch (err) {
    s2.stop("Sell failed");
    reportError(err);
    return false;
  }
}

// --- Withdraw Trading Funds: Perps -> Spot -> HyperEVM, always as USDC --------

async function withdrawTradingFundsFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Withdraw trading funds for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const accountAddress = account.evmAddress as Address;

  const s = p.spinner();
  s.start("Checking available perp collateral");
  let withdrawable: number;
  try {
    const perp = await fetchClearinghouseState(accountAddress);
    withdrawable = Number(perp.withdrawable);
    s.stop(`Available collateral: ${fmtUsd(withdrawable)}`);
  } catch (err) {
    s.stop("Failed to check perp collateral");
    reportError(err);
    return;
  }
  if (withdrawable <= 0) {
    p.log.info("No withdrawable perp collateral on this account.");
    return;
  }

  const amountInput = await p.text({
    message: "Amount of USDC to withdraw from trading",
    validate: (v) => {
      if (!v) return "Amount is required";
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return "Enter a positive number";
      if (n > withdrawable) return `Exceeds available collateral (${fmtUsd(withdrawable)})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;

  const confirmed = await p.confirm({
    message: `Move ${amountInput} USDC from Perps to "${account.name}"'s HyperEVM address? Result is always USDC, regardless of what funded the position. Runs two MPC signing ceremonies.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s1 = p.spinner();
  s1.start("Starting Perps -> Spot signing ceremony");
  try {
    await transferUsdClass(salt, walletClient, accountId, amountInput, false, (joined, total) => s1.message(`Waiting for signers: ${joined}/${total} joined`));
    s1.stop("Moved to Spot");
  } catch (err) {
    s1.stop("Perps -> Spot transfer failed");
    reportError(err);
    return;
  }

  const s2 = p.spinner();
  s2.start("Starting Spot -> HyperEVM signing ceremony");
  try {
    await transferSpotToHyperEvm(salt, walletClient, accountId, "USDC", amountInput, (joined, total) => s2.message(`Waiting for signers: ${joined}/${total} joined`));
    s2.stop(`Withdrawn — ${amountInput} USDC is on its way to ${accountAddress} on HyperEVM`);
  } catch (err) {
    s2.stop("Spot -> HyperEVM transfer failed — funds are on Spot, not lost; retry the HyperEVM leg via Advanced.");
    reportError(err);
  }
}

// --- View Balances -------------------------------------------------------------

async function viewBalancesFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "View balances for which account?");
  if (!picked) return;
  const accountAddress = picked.account.evmAddress as Address;

  const s = p.spinner();
  s.start("Fetching balances");
  try {
    const publicClient = hyperEvmPublicClient();
    // USDC-on-HyperEVM is one of Hyperliquid's HyperCore-linked token contracts, and (confirmed
    // via raw eth_call, no viem involved) it reverts on balanceOf() for every caller — not a
    // gas/checksum issue, the contract just doesn't answer standard ERC20 reads via eth_call.
    // Read it separately from the native HYPE balance (a plain eth_getBalance, unaffected) so
    // that failure doesn't take down the whole view.
    const [hypeBal, usdcBal, spot, perp] = await Promise.all([
      publicClient.getBalance({ address: accountAddress }),
      publicClient
        .readContract({ address: USDC_HYPEREVM_ADDRESS, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [accountAddress] })
        .catch((): bigint | undefined => undefined),
      fetchSpotClearinghouseState(accountAddress),
      fetchClearinghouseState(accountAddress),
    ]);
    s.stop("Balances");

    p.log.message(
      "HyperEVM\n" +
        `  HYPE   ${fmtNum(Number(hypeBal) / 1e18)}\n` +
        `  USDC   ${usdcBal !== undefined ? fmtNum(Number(usdcBal) / 1e6) : "(can't be read here — try Advanced to move a specific amount anyway)"}`,
    );

    const held = spot.balances.filter((b) => Number(b.total) > 0);
    p.log.message(held.length > 0 ? "HyperCore Spot\n" + held.map((b) => `  ${b.coin}   ${fmtNum(b.total)}`).join("\n") : "HyperCore Spot\n  (empty)");

    p.log.message(`HyperCore Perps\n  Margin collateral   ${fmtUsd(Number(perp.marginSummary.accountValue))}\n  Withdrawable        ${fmtUsd(Number(perp.withdrawable))}`);
  } catch (err) {
    s.stop("Failed to fetch balances");
    reportError(err);
  }
}

// --- Advanced: raw transfers, no swap/margin routing ---------------------------

async function rawDepositFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Transfer to HyperCore from which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const accountAddress = account.evmAddress as Address;

  const asset = await select({
    message: "Transfer which asset?",
    options: [
      { value: "HYPE", label: "HYPE (native gas token)" },
      { value: "USDC", label: "USDC" },
    ],
  });
  if (p.isCancel(asset)) return;

  const decimals = FUNDING_ASSET_DECIMALS[asset];
  const amountInput = await p.text({
    message: `Amount of ${asset} to transfer`,
    validate: (v) => {
      if (!v) return "Amount is required";
      try {
        if (parseUnits(v, decimals) <= 0n) return "Amount must be greater than 0";
      } catch {
        return "Not a valid amount";
      }
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const amount = parseUnits(amountInput, decimals);

  const confirmed = await p.confirm({
    message: `Transfer ${amountInput} ${asset} from "${account.name}" (${accountAddress}) — HyperEVM -> HyperCore Spot?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Transferring to HyperCore");
  try {
    const hash = await transferHyperEvmToSpot(salt, walletClient, accountId, asset, amount, (msg) => s.message(`Transferring — ${msg}`));
    s.stop(`Transferred — tx hash: ${hash ?? "(pending)"}`);
  } catch (err) {
    s.stop("Transfer failed");
    reportError(err);
  }
}

async function rawWithdrawFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Transfer from HyperCore for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  const asset = await select({
    message: "Transfer which asset?",
    options: [
      { value: "HYPE", label: "HYPE" },
      { value: "USDC", label: "USDC" },
    ],
  });
  if (p.isCancel(asset)) return;

  const s = p.spinner();
  s.start("Checking spot balance");
  let available = "0";
  try {
    const spot = await fetchSpotClearinghouseState(userAddress);
    available = spot.balances.find((b) => b.coin === asset)?.total ?? "0";
    s.stop(`Available: ${available} ${asset} (spot)`);
  } catch (err) {
    s.stop("Couldn't check balance");
    reportError(err);
    return;
  }

  const amountInput = await p.text({
    message: `Amount of ${asset} to transfer to HyperEVM`,
    validate: (v) => {
      if (!v) return "Amount is required";
      const parsed = Number.parseFloat(v);
      if (!Number.isFinite(parsed) || parsed <= 0) return "Enter a positive number";
      if (parsed > Number.parseFloat(available)) return `Exceeds available balance (${available} ${asset})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;

  const confirmed = await p.confirm({
    message: `Transfer ${amountInput} ${asset} from HyperCore Spot back to "${account.name}"'s HyperEVM address? This runs an MPC signing ceremony.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s2 = p.spinner();
  s2.start("Starting signing ceremony");
  try {
    await transferSpotToHyperEvm(salt, walletClient, accountId, asset, amountInput, (joined, total) => s2.message(`Waiting for signers: ${joined}/${total} joined`));
    s2.stop(`Transferred — ${amountInput} ${asset} is on its way to ${userAddress} on HyperEVM`);
  } catch (err) {
    s2.stop("Transfer failed");
    reportError(err);
  }
}

/** HyperCore Spot <-> Perps: move USDC between the spot wallet and perp margin directly (the
 *  UsdClassTransfer hop, exposed on its own for when it needs running outside the Fund Trading
 *  routing — e.g. USDC already sitting on Spot). */
async function rawUsdClassFlow(salt: Salt, walletClient: SaltWalletClient, toPerp: boolean): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Move margin for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const accountAddress = account.evmAddress as Address;

  const s = p.spinner();
  s.start("Checking available USDC");
  let available: number;
  try {
    if (toPerp) {
      const spot = await fetchSpotClearinghouseState(accountAddress);
      const usdc = spot.balances.find((b) => b.coin === "USDC");
      available = usdc ? Number(usdc.total) - Number(usdc.hold) : 0;
      s.stop(`${fmtNum(available)} USDC available in Spot`);
    } else {
      const perp = await fetchClearinghouseState(accountAddress);
      available = Number(perp.withdrawable);
      s.stop(`${fmtNum(available)} USDC withdrawable from Perps`);
    }
  } catch (err) {
    s.stop("Couldn't check balance");
    reportError(err);
    return;
  }
  if (available <= 0) {
    p.log.warn(`No USDC available to move ${toPerp ? "to Perps" : "to Spot"}.`);
    return;
  }

  // Floor to 6 decimals so the request never exceeds Hyperliquid's coarser USD balance accounting.
  const maxMovable = Math.floor(available * 1e6) / 1e6;
  const amountInput = await p.text({
    message: `Amount of USDC to move ${toPerp ? "Spot -> Perps" : "Perps -> Spot"} (max ${fmtNum(maxMovable)})`,
    placeholder: String(maxMovable),
    validate: (v) => {
      if (!v) return "Amount is required";
      const parsed = Number.parseFloat(v);
      if (!Number.isFinite(parsed) || parsed <= 0) return "Enter a positive number";
      if (parsed > available) return `Exceeds available (${fmtNum(available)} USDC)`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const amount = Math.floor(Number.parseFloat(amountInput) * 1e6) / 1e6;

  const confirmed = await p.confirm({
    message: `Move ${fmtNum(amount)} USDC ${toPerp ? "Spot -> Perps" : "Perps -> Spot"} for "${account.name}"? This runs an MPC signing ceremony.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s2 = p.spinner();
  s2.start("Starting signing ceremony");
  try {
    await transferUsdClass(salt, walletClient, accountId, String(amount), toPerp, (joined, total) => s2.message(`Waiting for signers: ${joined}/${total} joined`));
    s2.stop(`Moved ${fmtNum(amount)} USDC ${toPerp ? "to Perps" : "to Spot"}`);
  } catch (err) {
    s2.stop("Transfer failed");
    reportError(err);
  }
}

async function advancedMoveFundsFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const choice = await select({
    message: "Advanced: raw transfer",
    options: [
      { value: "deposit", label: "Transfer HyperEVM -> HyperCore", hint: "lands in Spot, not margin" },
      { value: "withdraw", label: "Transfer HyperCore -> HyperEVM", hint: "from Spot" },
      { value: "toPerp", label: "Move USDC Spot -> Perps", hint: "into trading margin" },
      { value: "toSpot", label: "Move USDC Perps -> Spot", hint: "out of trading margin" },
    ],
  });
  if (p.isCancel(choice)) return;
  if (choice === "deposit") await rawDepositFlow(salt, walletClient);
  else if (choice === "withdraw") await rawWithdrawFlow(salt, walletClient);
  else if (choice === "toPerp") await rawUsdClassFlow(salt, walletClient, true);
  else await rawUsdClassFlow(salt, walletClient, false);
}

export async function hyperliquidMoveFundsFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const choice = await select({
    message: "Move funds",
    options: [
      { value: "fund", label: "Fund Trading", hint: "any supported asset -> perp margin" },
      { value: "withdraw", label: "Withdraw Trading Funds", hint: "perp margin -> HyperEVM, always USDC" },
      { value: "balances", label: "View Balances", hint: "HyperEVM + HyperCore Spot + Perps" },
      { value: "advanced", label: "Advanced ▸", hint: "raw asset transfers, no swap/margin routing" },
    ],
  });
  if (p.isCancel(choice)) return;
  if (choice === "fund") await fundTradingFlow(salt, walletClient);
  else if (choice === "withdraw") await withdrawTradingFundsFlow(salt, walletClient);
  else if (choice === "balances") await viewBalancesFlow(salt, walletClient);
  else await advancedMoveFundsFlow(salt, walletClient);
}

// --- Portfolio / Positions -----------------------------------------------------

export async function hyperliquidPortfolioFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Portfolio for which account?");
  if (!picked) return;
  const userAddress = picked.account.evmAddress as Address;

  const s = p.spinner();
  s.start("Fetching portfolio");
  try {
    const [perp, spot] = await Promise.all([fetchClearinghouseState(userAddress), fetchSpotClearinghouseState(userAddress)]);
    s.stop("Portfolio");

    const { marginSummary: perpSummary, crossMaintenanceMarginUsed, withdrawable, assetPositions } = perp;
    const accountValue = Number(perpSummary.accountValue);
    const marginUsed = Number(perpSummary.totalMarginUsed);
    const maintenanceMargin = Number(crossMaintenanceMarginUsed);
    const unrealizedPnl = assetPositions.reduce((sum, ap) => sum + Number(ap.position.unrealizedPnl), 0);
    // Funding P&L across open positions: + earned / − paid since each opened. cumFunding is
    // positive when funding was *paid* (Hyperliquid's convention), so negate for a trader-facing P&L.
    const fundingPnl = assetPositions.reduce((sum, ap) => sum - Number(ap.position.cumFunding.sinceOpen), 0);
    // Margin ratio: how much of account equity is tied up as margin — the standard "how close to a margin call" gauge on perp venues.
    const marginRatio = accountValue > 0 ? marginUsed / accountValue : 0;

    p.log.message(
      `Perpetuals\n` +
        `  Account equity        ${fmtUsd(accountValue)}\n` +
        `  Withdrawable           ${fmtUsd(Number(withdrawable))}\n` +
        `  Unrealized PnL         ${fmtSignedUsd(unrealizedPnl)}\n` +
        (assetPositions.length > 0 ? `  Funding P&L (open)     ${fmtSignedUsd(fundingPnl)}  (+ earned / − paid)\n` : "") +
        `  Margin used            ${fmtUsd(marginUsed)} (${(marginRatio * 100).toFixed(1)}% of equity)\n` +
        `  Maintenance margin     ${fmtUsd(maintenanceMargin)}\n` +
        `  Open positions          ${assetPositions.length}`,
    );

    const held = spot.balances.filter((b) => Number(b.total) > 0);
    if (held.length === 0) {
      p.log.info("Spot: no balances.");
    } else {
      const rows = held.map((b) => {
        const total = Number(b.total);
        const hold = Number(b.hold);
        return [b.coin, fmtNum(total), hold > 0 ? fmtNum(hold) : "-", fmtNum(total - hold)];
      });
      p.log.message(`Spot\n${renderTable(["Coin", "Total", "In orders", "Available"], rows)}`);
    }
  } catch (err) {
    s.stop("Failed to fetch portfolio");
    reportError(err);
  }
}

export async function hyperliquidPositionsFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Positions for which account?");
  if (!picked) return;
  const userAddress = picked.account.evmAddress as Address;

  const s = p.spinner();
  s.start("Fetching positions");
  try {
    const [state, openOrders, fills, mids, spotMeta, fundingRates] = await Promise.all([
      fetchClearinghouseState(userAddress),
      fetchOpenOrders(userAddress),
      fetchUserFills(userAddress),
      fetchAllMids(),
      fetchSpotMeta(),
      fetchFundingRates(),
    ]);
    s.stop("Positions");

    if (state.assetPositions.length === 0) {
      p.log.info("No open positions.");
    } else {
      const rows = state.assetPositions.map(({ position: pos }) => {
        const szi = Number(pos.szi);
        const side = szi >= 0 ? "Long " : "Short";
        const mark = mids[pos.coin];
        return [
          pos.coin,
          side,
          fmtNum(Math.abs(szi)),
          `${pos.leverage.value}x ${pos.leverage.type}`,
          fmtNum(pos.entryPx),
          mark ? fmtNum(mark) : "-",
          fmtUsd(Number(pos.positionValue)),
          `${fmtSignedUsd(Number(pos.unrealizedPnl))} (${fmtPct(Number(pos.returnOnEquity))})`,
          pos.liquidationPx ? fmtNum(pos.liquidationPx) : "-",
          fmtUsd(Number(pos.marginUsed)),
          fundingCell(szi, Number(pos.cumFunding.sinceOpen), fundingRates.get(pos.coin)),
        ];
      });
      p.log.message(
        "Open positions\n" +
          renderTable(
            ["Coin", "Side", "Size", "Leverage", "Entry", "Mark", "Notional", "Unrealized PnL", "Liq. price", "Margin", "Funding (P&L · rate)"],
            rows,
          ) +
          "\n(Funding P&L: + earned / − paid, since the position opened. Rate: current hourly rate; " +
          "'pay' = this side pays it, 'earn' = this side receives it. Funding settles hourly on notional.)",
      );
    }

    if (openOrders.length === 0) {
      p.log.info("No open orders.");
    } else {
      const rows = openOrders
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((o: OpenOrder) => [
          resolveSpotCoin(o.coin, spotMeta),
          fmtSide(o.side),
          fmtNum(o.limitPx),
          fmtNum(o.sz),
          fmtUsd(Number(o.limitPx) * Number(o.sz)),
          timeAgo(o.timestamp),
        ]);
      p.log.message(`Open orders\n${renderTable(["Coin", "Side", "Price", "Size", "Value", "Placed"], rows)}`);
    }

    if (fills.length === 0) {
      p.log.info("No recent fills.");
    } else {
      const rows = fills
        .sort((a, b) => b.time - a.time)
        .slice(0, 15)
        .map((f: UserFill) => [
          resolveSpotCoin(f.coin, spotMeta),
          fmtSide(f.side),
          f.dir,
          fmtNum(f.px),
          fmtNum(f.sz),
          Number(f.closedPnl) !== 0 ? fmtSignedUsd(Number(f.closedPnl)) : "-",
          `${fmtNum(f.fee, 4)} ${f.feeToken}`,
          timeAgo(f.time),
        ]);
      p.log.message(`Recent fills (last ${rows.length})\n${renderTable(["Coin", "Side", "Type", "Price", "Size", "Closed PnL", "Fee", "When"], rows)}`);
    }
  } catch (err) {
    s.stop("Failed to fetch positions");
    reportError(err);
  }
}

// --- Trade -------------------------------------------------------------------

/** Reads the first order status out of an `/exchange` order response and renders it for the confirmation line. */
function describeOrderStatus(response: ExchangeActionResponse): string {
  const errors = extractActionErrors(response);
  if (errors.length > 0) return `Rejected — ${errors.join("; ")}`;
  const status = response.response?.data?.statuses?.[0] as
    | { resting?: { oid: number }; filled?: { oid: number; totalSz: string; avgPx: string } }
    | undefined;
  if (status?.filled) return `Filled — ${fmtNum(status.filled.totalSz)} @ ${fmtNum(status.filled.avgPx)} (order #${status.filled.oid})`;
  if (status?.resting) return `Resting on the book (order #${status.resting.oid})`;
  return "Submitted";
}

async function placeOrderFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Place an order for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  // --- Account state (always shown first) + guards -----------------------------
  const s = p.spinner();
  s.start("Loading account state");
  let perp: ClearinghouseState;
  let openOrders: OpenOrder[];
  try {
    [perp, openOrders] = await Promise.all([fetchClearinghouseState(userAddress), fetchOpenOrders(userAddress)]);
    s.stop("Account state loaded");
  } catch (err) {
    s.stop("Failed to load account state");
    reportError(err);
    return;
  }

  const equity = Number(perp.marginSummary.accountValue);
  const marginUsed = Number(perp.marginSummary.totalMarginUsed);
  const availableMargin = Number(perp.withdrawable);
  const unrealizedPnl = perp.assetPositions.reduce((sum, ap) => sum + Number(ap.position.unrealizedPnl), 0);

  p.log.message(
    "Account\n" +
      `  Equity              ${fmtUsd(equity)}\n` +
      `  Available margin    ${fmtUsd(availableMargin)}\n` +
      `  Margin in use        ${fmtUsd(marginUsed)}\n` +
      `  Unrealized PnL       ${fmtSignedUsd(unrealizedPnl)}\n` +
      `  Open positions        ${perp.assetPositions.length}\n` +
      `  Open orders           ${openOrders.length}`,
  );

  if (availableMargin <= 0) {
    p.log.error('No available perp collateral to trade with. Fund your account first — Move Funds -> "Fund Trading".');
    return;
  }

  // No verified-agent gate: an order can be signed by the account via a Salt MPC ceremony without
  // an approved agent (same as the spot sell), and chooseOrderSigningMethod below offers the fast
  // agent-key path only when one exists. `agentMeta` may be undefined — handled in the preview and
  // the signer choice.
  const agentMeta = getAgentMetadata(accountId);

  // --- Market --------------------------------------------------------------------
  const s2 = p.spinner();
  s2.start("Fetching markets");
  let meta: PerpMeta;
  try {
    meta = await fetchMeta();
    s2.stop(`${meta.universe.length} perp market(s) available`);
  } catch (err) {
    s2.stop("Failed to fetch markets");
    reportError(err);
    return;
  }

  const assetIndex = await p.autocomplete({
    message: "Market (perp)",
    placeholder: "Start typing a symbol, e.g. BTC",
    maxItems: 8,
    options: meta.universe.map((a, index) => ({ value: index, label: a.name, hint: `max ${a.maxLeverage}x` })),
  });
  if (p.isCancel(assetIndex)) return;
  const asset = meta.universe[assetIndex];

  const s3 = p.spinner();
  s3.start(`Fetching ${asset.name} price`);
  let mark: number;
  try {
    const mids = await fetchAllMids();
    const midStr = mids[asset.name];
    if (!midStr) throw new Error(`No live price available for ${asset.name}`);
    mark = Number(midStr);
    s3.stop(`Mark price: ${fmtNum(mark)}`);
  } catch (err) {
    s3.stop("Failed to fetch price");
    reportError(err);
    return;
  }

  const existingPosition = perp.assetPositions.find((ap) => ap.position.coin === asset.name);
  const marketInfoLines = [`Mark price          ${fmtNum(mark)}`, `Max leverage         ${asset.maxLeverage}x`, `Available margin    ${fmtUsd(availableMargin)}`];
  if (existingPosition) {
    const pos = existingPosition.position;
    const posSide = Number(pos.szi) >= 0 ? "Long" : "Short";
    marketInfoLines.push(`Existing position    ${posSide} ${fmtNum(Math.abs(Number(pos.szi)))} ${asset.name} @ ${fmtNum(pos.entryPx)}`);
  }
  p.log.message(`${asset.name}\n  ${marketInfoLines.join("\n  ")}`);

  // --- Direction -------------------------------------------------------------------
  const direction = await select({
    message: `${asset.name} — direction`,
    options: [
      { value: true, label: "Long", hint: "Buy" },
      { value: false, label: "Short", hint: "Sell" },
    ],
  });
  if (p.isCancel(direction)) return;
  const isBuy = direction;

  // --- Margin --------------------------------------------------------------------
  const marginInput = await p.text({
    message: `Margin to allocate (available: ${fmtUsd(availableMargin)})`,
    validate: (v) => (v ? validateMargin({ margin: Number(v), availableMargin }) : "Amount is required"),
  });
  if (p.isCancel(marginInput)) return;
  const margin = Number(marginInput);

  // --- Leverage --------------------------------------------------------------------
  const leverageOptions = computeLeverageOptions(asset.maxLeverage);
  const leverage = await select({
    message: `Leverage (margin: ${fmtUsd(margin)})`,
    options: leverageOptions.map((l) => ({ value: l, label: `${l}x`, hint: `${fmtUsd(margin * l)} position` })),
  });
  if (p.isCancel(leverage)) return;

  // --- Order type --------------------------------------------------------------------
  const orderType = await select({
    message: "Order type",
    options: [
      { value: "market", label: "Market", hint: `aggressive IOC, ~${(MARKET_ORDER_SLIPPAGE * 100).toFixed(0)}% slippage tolerance` },
      { value: "limit", label: "Limit", hint: "rests on the book at your price" },
    ],
  });
  if (p.isCancel(orderType)) return;

  let submitPrice: number;
  let tif: "Gtc" | "Ioc";
  if (orderType === "market") {
    submitPrice = marketOrderLimitPrice(mark, isBuy, asset.szDecimals);
    tif = "Ioc";
  } else {
    const priceInput = await p.text({
      message: `Limit price (mark: ${fmtNum(mark)})`,
      validate: (v) => {
        if (!v) return "Price is required";
        const n = Number(v);
        return !Number.isFinite(n) || n <= 0 ? "Enter a positive number" : undefined;
      },
    });
    if (p.isCancel(priceInput)) return;
    submitPrice = roundPerpPrice(Number(priceInput), asset.szDecimals);
    tif = "Gtc";
  }
  // Sizing is based on the price the order will actually be evaluated at: the limit price for a
  // limit order, or the current mark for a market order (not the slippage-padded IOC limit, which
  // is only a worst-case cap, not the expected fill price).
  const sizingPrice = orderType === "limit" ? submitPrice : mark;
  const { notional, size } = computeOrderSizing({ margin, leverage, executionPrice: sizingPrice, szDecimals: asset.szDecimals });
  if (size <= 0) {
    p.log.error("That margin/leverage combination rounds to zero size at this market's precision — increase margin or leverage.");
    return;
  }

  // --- Trade preview --------------------------------------------------------------------
  const impact = computeAccountImpact({ availableMargin, thisTradeMargin: margin });
  const liqPrice = estimateIsolatedLiquidationPrice({ entryPrice: sizingPrice, isBuy, margin, size, maxLeverage: asset.maxLeverage });

  const previewLines = [
    `${asset.name} ${isBuy ? "LONG" : "SHORT"}`,
    "",
    `Order:              ${orderType === "market" ? "Market" : "Limit"}`,
    "Margin mode:        Isolated",
    `Margin:             ${fmtUsd(margin)}`,
    `Leverage:           ${leverage}x`,
    `Position value:     ~${fmtUsd(notional)}`,
    `Size:               ~${fmtNum(size)} ${asset.name}`,
    "",
    `Mark:               ${fmtNum(mark)}`,
    orderType === "market"
      ? `Estimated entry:    ${fmtNum(submitPrice)}`
      : `Limit price:        ${fmtNum(submitPrice)} (${(((submitPrice - mark) / mark) * 100).toFixed(2)}% from mark)`,
  ];
  if (orderType === "market") previewLines.push(`Max slippage:       ${(MARKET_ORDER_SLIPPAGE * 100).toFixed(1)}%`);
  if (liqPrice !== undefined) previewLines.push(`Liquidation (est.): ${fmtNum(liqPrice)}`);
  previewLines.push(
    "",
    "ACCOUNT IMPACT",
    `Equity:             ${fmtUsd(equity)}`,
    `Existing margin:    ${fmtUsd(marginUsed)}`,
    `This trade:         ${fmtUsd(margin)}`,
    `Remaining margin:   ~${fmtUsd(impact.remainingMargin)}`,
    "",
    `Signing:            ${agentMeta?.lastVerified ? `agent "${agentMeta.agentName}" or Salt MPC` : "Salt MPC ceremony"}`,
  );
  p.note(previewLines.join("\n"), "Trade preview");

  const confirmed = await p.confirm({ message: "Place order?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  // --- Execute --------------------------------------------------------------------
  // Offer the same choice the other order paths do: the approved agent's key (fast, no ceremony)
  // or a Salt MPC ceremony (no local key). Prompts run before the spinner starts.
  const signingChoice = await chooseOrderSigningMethod(accountId);
  if (!signingChoice) {
    p.log.warn("No signing method chosen — order not sent.");
    return;
  }

  const s4 = p.spinner();
  s4.start(signingChoice.kind === "mpc" ? "Starting signing ceremony" : "Setting leverage");
  const signer =
    signingChoice.kind === "agent"
      ? signingChoice.signer
      : mpcCeremonySigner(salt, walletClient, accountId, (joined, total) => s4.message(`Waiting for signers: ${joined}/${total} joined`));
  try {
    const leverageAction = buildUpdateLeverageAction({ assetIndex, leverage, isCross: false });
    await signAndSubmitL1Action(signer, leverageAction);

    s4.message("Placing order");
    const orderAction = buildLimitOrderAction({ assetIndex, isBuy, limitPx: submitPrice, size, reduceOnly: false, tif });
    const response = await signAndSubmitL1Action(signer, orderAction);
    s4.stop(describeOrderStatus(response));
  } catch (err) {
    s4.stop("Order failed");
    reportError(err);
  }
}

/**
 * Only perp orders are cancellable here — spot orders carry an `@{index}` coin id that this
 * flow doesn't resolve to a spot asset id (order placement above is perp-only too), so they're
 * filtered out with an explanatory note rather than silently mishandled.
 */
async function cancelOrderFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Cancel an order for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  const s = p.spinner();
  s.start("Fetching open orders");
  let openOrders: OpenOrder[];
  let meta: PerpMeta;
  try {
    [openOrders, meta] = await Promise.all([fetchOpenOrders(userAddress), fetchMeta()]);
    s.stop(`${openOrders.length} open order(s)`);
  } catch (err) {
    s.stop("Failed to fetch open orders");
    reportError(err);
    return;
  }

  const perpOrders = openOrders.filter((o) => !o.coin.startsWith("@"));
  if (perpOrders.length === 0) {
    p.log.info(
      openOrders.length > 0
        ? "No cancellable perp orders — this account's open orders are all spot, which this flow doesn't support cancelling yet."
        : "No open orders.",
    );
    return;
  }

  const oid = await select({
    message: "Cancel which order?",
    options: perpOrders.map((o) => ({ value: o.oid, label: `${o.coin}  ${fmtSide(o.side)}  ${fmtNum(o.sz)} @ ${fmtNum(o.limitPx)}` })),
  });
  if (p.isCancel(oid)) return;
  const order = perpOrders.find((o) => o.oid === oid)!;
  const assetIndex = meta.universe.findIndex((a) => a.name === order.coin);
  if (assetIndex === -1) {
    p.log.error(`Couldn't resolve "${order.coin}" to a perp market — not cancelling.`);
    return;
  }

  const confirmed = await p.confirm({ message: `Cancel ${order.coin} ${fmtSide(order.side)} ${fmtNum(order.sz)} @ ${fmtNum(order.limitPx)}?` });
  if (p.isCancel(confirmed) || !confirmed) return;

  const signingChoice = await chooseOrderSigningMethod(accountId);
  if (!signingChoice) return;

  const s2 = p.spinner();
  s2.start(signingChoice.kind === "mpc" ? "Starting signing ceremony" : "Cancelling order");
  const signer =
    signingChoice.kind === "agent"
      ? signingChoice.signer
      : mpcCeremonySigner(salt, walletClient, accountId, (joined, total) => s2.message(`Waiting for signers: ${joined}/${total} joined`));

  try {
    const action = buildCancelOrderAction({ assetIndex, orderId: order.oid });
    const response = await signAndSubmitL1Action(signer, action);
    const errors = extractActionErrors(response);
    s2.stop(errors.length > 0 ? `Cancel rejected — ${errors.join("; ")}` : "Order cancelled");
  } catch (err) {
    s2.stop("Cancel failed");
    reportError(err);
  }
}

/**
 * Closes an open perp position with a reduce-only aggressive-IOC market order sized to the exact
 * position (`reduceOnly` so it flattens rather than risking a flip to the other side). Signs via
 * the agent key or a Salt MPC ceremony, same as order placement — and since it doesn't need a
 * verified agent (MPC always works), it's the counterpart the Trade menu was missing.
 */
async function closePositionFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Close a position for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  const s = p.spinner();
  s.start("Loading positions");
  let perp: Awaited<ReturnType<typeof fetchClearinghouseState>>;
  let meta: PerpMeta;
  try {
    [perp, meta] = await Promise.all([fetchClearinghouseState(userAddress), fetchMeta()]);
    s.stop("Positions loaded");
  } catch (err) {
    s.stop("Failed to load positions");
    reportError(err);
    return;
  }

  const open = perp.assetPositions.filter((ap) => Number(ap.position.szi) !== 0);
  if (open.length === 0) {
    p.log.info("No open positions to close.");
    return;
  }

  const coin = await select({
    message: "Close which position?",
    options: open.map((ap) => {
      const pos = ap.position;
      const side = Number(pos.szi) >= 0 ? "Long" : "Short";
      return {
        value: pos.coin,
        label: `${pos.coin} ${side} ${fmtNum(Math.abs(Number(pos.szi)))}`,
        hint: `entry ${fmtNum(pos.entryPx)} · uPnL ${fmtSignedUsd(Number(pos.unrealizedPnl))}`,
      };
    }),
  });
  if (p.isCancel(coin)) return;

  const chosen = open.find((ap) => ap.position.coin === coin)!.position;
  const assetIndex = meta.universe.findIndex((a) => a.name === coin);
  if (assetIndex < 0) {
    p.log.error(`Couldn't resolve ${coin} in the perp universe.`);
    return;
  }
  const szDecimals = meta.universe[assetIndex].szDecimals;
  const fullSize = Math.abs(Number(chosen.szi));
  const closeIsBuy = Number(chosen.szi) < 0; // long -> sell to close, short -> buy to close

  // Partial close: default to the whole position, accept any size up to it.
  const sizeInput = await p.text({
    message: `Size to close (max ${fmtNum(fullSize, szDecimals)} ${coin})`,
    placeholder: String(fullSize),
    initialValue: String(fullSize),
    validate: (v) => {
      if (!v) return "Size is required";
      const parsed = Number.parseFloat(v);
      if (!Number.isFinite(parsed) || parsed <= 0) return "Enter a positive size";
      if (parsed > fullSize) return `Exceeds position size (${fmtNum(fullSize, szDecimals)} ${coin})`;
      return undefined;
    },
  });
  if (p.isCancel(sizeInput)) return;
  // Round to the market's size precision; cap at the position so rounding can't overshoot it.
  const size = Math.min(fullSize, Number(Number.parseFloat(sizeInput).toFixed(szDecimals)));
  if (size <= 0) {
    p.log.error("That size rounds to zero at this market's precision.");
    return;
  }

  const s2 = p.spinner();
  s2.start(`Fetching ${coin} price`);
  let mark: number;
  try {
    const mids = await fetchAllMids();
    const midStr = mids[coin];
    if (!midStr) throw new Error(`No live price for ${coin}`);
    mark = Number(midStr);
    s2.stop(`Mark price: ${fmtNum(mark)}`);
  } catch (err) {
    s2.stop("Failed to fetch price");
    reportError(err);
    return;
  }

  const side = Number(chosen.szi) >= 0 ? "Long" : "Short";
  const isPartial = size < fullSize;
  p.note(
    [
      `Close ${side} ${fmtNum(size)} ${coin}${isPartial ? ` (partial — ${fmtNum(fullSize - size)} left open)` : " (full)"}`,
      `Order:            reduce-only market (aggressive IOC)`,
      `Mark:             ${fmtNum(mark)}`,
      `Unrealized PnL:   ${fmtSignedUsd(Number(chosen.unrealizedPnl))} (on the full position)`,
    ].join("\n"),
    "Close preview",
  );
  const confirmed = await p.confirm({ message: "Close this position?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  const signingChoice = await chooseOrderSigningMethod(accountId);
  if (!signingChoice) {
    p.log.warn("No signing method chosen — position not closed.");
    return;
  }

  const s3 = p.spinner();
  s3.start(signingChoice.kind === "mpc" ? "Starting signing ceremony" : "Closing position");
  const signer =
    signingChoice.kind === "agent"
      ? signingChoice.signer
      : mpcCeremonySigner(salt, walletClient, accountId, (joined, total) => s3.message(`Waiting for signers: ${joined}/${total} joined`));
  try {
    const limitPx = marketOrderLimitPrice(mark, closeIsBuy, szDecimals);
    const action = buildLimitOrderAction({ assetIndex, isBuy: closeIsBuy, limitPx, size, reduceOnly: true, tif: "Ioc" });
    const response = await signAndSubmitL1Action(signer, action);
    const errors = extractActionErrors(response);
    if (errors.length > 0) {
      s3.stop(`Close rejected — ${errors.join("; ")}`);
      return;
    }
    s3.stop(describeOrderStatus(response));
  } catch (err) {
    s3.stop("Close failed");
    reportError(err);
  }
}

export async function hyperliquidTradeFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const choice = await select({
    message: "Trade",
    options: [
      { value: "place", label: "Place order", hint: "limit or market, perp only" },
      { value: "close", label: "Close position", hint: "reduce-only market, exact size" },
      { value: "cancel", label: "Cancel order" },
    ],
  });
  if (p.isCancel(choice)) return;
  if (choice === "place") await placeOrderFlow(salt, walletClient);
  else if (choice === "close") await closePositionFlow(salt, walletClient);
  else await cancelOrderFlow(salt, walletClient);
}
