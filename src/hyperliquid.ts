import "dotenv/config";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import type { SaltTypedData } from "salt-sdk";
import { hexToBytes, hexToSignature, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { network } from "./env.js";

/**
 * Per-environment Hyperliquid config, selected from `SALT_ENV` (via `network.saltEnv`). HyperEVM
 * testnet (998) and mainnet (999) are distinct chains with distinct HyperCore token identities,
 * spot markets and API hosts — every value below differs by network, so don't conflate them.
 * Testnet values were confirmed against the live testnet API; mainnet token ids / evmContract /
 * HYPE-USDC pair index were read from live mainnet `/info` `spotMeta`.
 */
interface HyperliquidEnv {
  apiUrl: string;
  chainId: number;
  /** Value Hyperliquid's `hyperliquidChain` typed-data field expects. */
  chainLabel: "Testnet" | "Mainnet";
  /** L1-action phantom-agent `source`: "b" on testnet, "a" on mainnet. */
  phantomAgentSource: "a" | "b";
  /** USDC's HyperEVM ERC-20 — spotMeta token 0 `evmContract.address`. */
  usdcHyperEvmAddress: Address;
  usdcCoreTokenId: string;
  hypeCoreTokenId: string;
  /** HYPE/USDC spot pair index in spotMeta.universe. Spot order asset ids are `10000 + this`. */
  hypeUsdcSpotPairIndex: number;
}

const HYPERLIQUID_ENV: Record<typeof network.saltEnv, HyperliquidEnv> = {
  testnet: {
    apiUrl: "https://api.hyperliquid-testnet.xyz",
    chainId: 998,
    chainLabel: "Testnet",
    phantomAgentSource: "b",
    usdcHyperEvmAddress: "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206",
    usdcCoreTokenId: "0xeb62eee3685fc4c43992febcd9e75443",
    hypeCoreTokenId: "0x7317beb7cceed72ef0b346074cc8e7ab",
    hypeUsdcSpotPairIndex: 1035,
  },
  mainnet: {
    apiUrl: "https://api.hyperliquid.xyz",
    chainId: 999,
    chainLabel: "Mainnet",
    phantomAgentSource: "a",
    usdcHyperEvmAddress: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24",
    usdcCoreTokenId: "0x6d1e7cde53ba9467b783cb7c530ce054",
    hypeCoreTokenId: "0x0d01dc56dcaaca66ad901c959b4011ec",
    hypeUsdcSpotPairIndex: 107,
  },
};

const hlEnv = HYPERLIQUID_ENV[network.saltEnv];

export const HYPERLIQUID_API_URL = hlEnv.apiUrl;
export const HYPEREVM_CHAIN_ID = hlEnv.chainId;
/**
 * HyperEVM RPC — used for both reads and the on-chain broadcast in Move Funds. The public
 * endpoint is rate-limited (100 req/min) and can be flaky, so prefer a dedicated node: an Alchemy
 * HyperEVM URL for the active network is derived automatically from `ALCHEMY_API_KEY`, or set
 * `HYPEREVM_RPC_URL` for a full custom URL (which takes precedence).
 */
export const HYPEREVM_RPC_URL =
  process.env.HYPEREVM_RPC_URL ??
  (process.env.ALCHEMY_API_KEY
    ? `https://hyperliquid-${network.saltEnv}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : network.saltEnv === "mainnet"
      ? "https://rpc.hyperliquid.xyz/evm"
      : "https://rpc.hyperliquid-testnet.xyz/evm");
/** Value Hyperliquid's `hyperliquidChain` typed-data field expects for the active network. */
export const HYPERLIQUID_CHAIN_LABEL = hlEnv.chainLabel;

export const USDC_HYPEREVM_ADDRESS: Address = hlEnv.usdcHyperEvmAddress;
export const USDC_CORE_TOKEN_INDEX = 0;
export const USDC_CORE_TOKEN_ID = hlEnv.usdcCoreTokenId;
export const HYPE_CORE_TOKEN_ID = hlEnv.hypeCoreTokenId;
/** HyperEVM's fixed system address for native HYPE deposits/withdrawals (unlike ERC-20s, which key off {@link coreSystemAddress}). */
export const HYPE_CORE_SYSTEM_ADDRESS: Address = "0x2222222222222222222222222222222222222222";
/** HYPE/USDC's spot pair index in spotMeta.universe. Spot order asset ids are `10000 + this`. */
export const HYPE_USDC_SPOT_PAIR_INDEX = hlEnv.hypeUsdcSpotPairIndex;

/**
 * Hyperliquid's native deposit bridge on Arbitrum. Send **native Arbitrum USDC**
 * here and HyperCore credits the SENDING address's perp balance (~1 min after the
 * Arbitrum tx confirms). It's a plain ERC-20 transfer — no Hyperliquid-specific
 * signing scheme — so Salt's normal transaction ceremony signs it.
 *
 * Mainnet only: the `Bridge2` contract + native-USDC addresses are verified
 * on-chain (the contract custodies all HL deposits) and against Hyperliquid's
 * docs. On **testnet** HyperCore is funded by the faucet (mock USDC lands
 * directly), so there's no Arbitrum-bridge deposit — this is `null` and the flow
 * points users at the faucet instead.
 *
 * ⚠ The bridge accepts ONLY native USDC (`0xaf88…5831`) and enforces a
 * {@link HL_MIN_DEPOSIT_USDC} minimum — a smaller deposit is NOT credited.
 */
export const HL_ARBITRUM_DEPOSIT: { bridge: Address; usdc: Address; chainId: string } | null =
  network.saltEnv === "mainnet"
    ? {
        bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
        usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        chainId: "42161",
      }
    : null;

/** Hyperliquid's minimum Arbitrum deposit, in USDC — below this the funds are NOT credited. */
export const HL_MIN_DEPOSIT_USDC = 5;

/**
 * Hyperliquid's **HLP** (Hyperliquidity Provider) protocol vault — deposit USDC
 * to earn a share of its market-making + liquidation revenue. Deposits pull from
 * the account's HyperCore **perp** balance and are **LOCKED** for
 * {@link HLP_LOCKUP_DAYS} days after the most recent deposit; returns are variable
 * and CAN be negative (it's market-making, not a savings account).
 *
 * Mainnet only: the address is verified against `app.hyperliquid.xyz/vaults` and
 * the live `/info` `vaultDetails` (name "Hyperliquidity Provider (HLP)"). On
 * testnet this is `null` and the flow says so.
 */
export const HLP_VAULT_ADDRESS: Address | null =
  network.saltEnv === "mainnet" ? "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303" : null;
/** HLP's post-deposit lock-up, in days — you can't withdraw until it elapses. */
export const HLP_LOCKUP_DAYS = 4;
/** Hyperliquid's minimum vault deposit, in USD. */
export const VAULT_MIN_DEPOSIT_USD = 20;

/**
 * The HyperEVM deposit destination for a given HyperCore spot token: `0x20`
 * followed by zero-padding, with the token's Core index in the trailing bytes
 * (big-endian). An ERC-20 `transfer()` of that token to this address on
 * HyperEVM credits the same wallet's HyperCore balance.
 */
export function coreSystemAddress(tokenIndex: number): Address {
  const hex = tokenIndex.toString(16).padStart(38, "0");
  return `0x20${hex}` as Address;
}

/**
 * The EIP-712 domain shared by every `HyperliquidTransaction:*` user-signed
 * action (ApproveAgent, SendAsset, UsdClassTransfer, ...) — not to be confused
 * with the separate, compressed signing scheme L1 actions (orders/cancels)
 * use, which is fixed at chainId 1337 regardless of network.
 *
 * `chainId` here is HyperEVM's own chain id ({@link HYPEREVM_CHAIN_ID}: 998 testnet, 999
 * mainnet) — empirically confirmed working for ApproveAgent against live *testnet* (ceremony
 * succeeded, agent verified afterward). ⚠️ The mainnet value (999) is NOT yet verified against
 * the mainnet backend — if a `HyperliquidTransaction:*` action fails *signature verification* on
 * mainnet (as opposed to a business-logic rejection like insufficient funds), this is the first
 * thing to try swapping. Worth flagging: Hyperliquid's own Python SDK instead hard-codes
 * `0x66eee` (421614, Arbitrum Sepolia) for this domain on *every* network, which doesn't match
 * either HyperEVM chain id — so if 999 is rejected, 42161 (Arbitrum One) / 421614 are the
 * candidates to try.
 */
function hyperliquidSignDomain() {
  return {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: HYPEREVM_CHAIN_ID,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  } as const;
}

export interface ApproveAgentParams {
  agentAddress: Address;
  agentName: string;
  nonce: number;
}

export function buildApproveAgentTypedData({ agentAddress, agentName, nonce }: ApproveAgentParams): SaltTypedData {
  return {
    domain: hyperliquidSignDomain(),
    types: {
      "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: {
      hyperliquidChain: HYPERLIQUID_CHAIN_LABEL,
      agentAddress,
      agentName,
      nonce,
    },
  };
}

/**
 * SendAsset (HyperCore -> HyperEVM withdrawal) params. Field list and types
 * confirmed against Hyperliquid's official Python SDK (signing.py's
 * `SEND_ASSET_SIGN_TYPES`); `token`, `sourceDex`/`destinationDex` confirmed
 * empirically against live testnet (moving a spot balance out to HyperEVM):
 * - `token`: `"<symbol>:<tokenId>"`, e.g. `HYPE_CORE_TOKEN_ID` /
 *   `USDC_CORE_TOKEN_ID` above — a bare symbol gets rejected as "Invalid token".
 * - `sourceDex` / `destinationDex`: both `"spot"` for a spot-balance
 *   withdrawal (the docs' "empty string for perp / "spot" for spot" note
 *   turned out to describe only `sourceDex` for other actions — for
 *   SendAsset specifically both sides need to say `"spot"`).
 */
export interface SendAssetParams {
  destination: Address;
  token: string;
  amount: string;
  sourceDex: string;
  destinationDex: string;
  fromSubAccount: string;
  nonce: number;
}

export function buildSendAssetTypedData(params: SendAssetParams): SaltTypedData {
  return {
    domain: hyperliquidSignDomain(),
    types: {
      "HyperliquidTransaction:SendAsset": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "sourceDex", type: "string" },
        { name: "destinationDex", type: "string" },
        { name: "token", type: "string" },
        { name: "amount", type: "string" },
        { name: "fromSubAccount", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:SendAsset",
    message: {
      hyperliquidChain: HYPERLIQUID_CHAIN_LABEL,
      destination: params.destination,
      sourceDex: params.sourceDex,
      destinationDex: params.destinationDex,
      token: params.token,
      amount: params.amount,
      fromSubAccount: params.fromSubAccount,
      nonce: params.nonce,
    },
  };
}

/**
 * UsdClassTransfer moves USDC between HyperCore's spot wallet and its perp
 * wallet — separate balances within HyperCore itself, distinct from the
 * HyperEVM<->HyperCore bridge above. Perp trading margin only comes from the
 * perp wallet, so a spot-acquired USDC balance (e.g. from a spot trade) has
 * to pass through here before it can back a perp order. Field list and types
 * confirmed against Hyperliquid's official Python SDK (`USD_CLASS_TRANSFER_SIGN_TYPES`).
 */
export interface UsdClassTransferParams {
  amount: string;
  toPerp: boolean;
  nonce: number;
}

export function buildUsdClassTransferTypedData(params: UsdClassTransferParams): SaltTypedData {
  return {
    domain: hyperliquidSignDomain(),
    types: {
      "HyperliquidTransaction:UsdClassTransfer": [
        { name: "hyperliquidChain", type: "string" },
        { name: "amount", type: "string" },
        { name: "toPerp", type: "bool" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:UsdClassTransfer",
    message: {
      hyperliquidChain: HYPERLIQUID_CHAIN_LABEL,
      amount: params.amount,
      toPerp: params.toPerp,
      nonce: params.nonce,
    },
  };
}

export function submitUsdClassTransfer(params: UsdClassTransferParams, signature: HyperliquidSignature): Promise<unknown> {
  return postJson("/exchange", {
    action: {
      type: "usdClassTransfer",
      hyperliquidChain: HYPERLIQUID_CHAIN_LABEL,
      signatureChainId: `0x${HYPEREVM_CHAIN_ID.toString(16)}`,
      amount: params.amount,
      toPerp: params.toPerp,
      nonce: params.nonce,
    },
    signature,
    nonce: params.nonce,
  });
}

export interface HyperliquidSignature {
  r: Hex;
  s: Hex;
  v: number;
}

// --- L1 actions (orders, cancels, leverage) ------------------------------------
//
// A *different* scheme from ApproveAgent/SendAsset above: the action is
// msgpack-encoded and keccak-hashed into a "connectionId", wrapped in a fixed
// "phantom agent" EIP-712 struct (domain chainId 1337, unrelated to HyperEVM's
// 998), and *that* is what gets signed. This is what lets the agent wallet
// sign trades locally with no gas and no Salt/MPC involvement — confirmed
// against Hyperliquid's official Python SDK (hyperliquid-dex/hyperliquid-python-sdk,
// utils/signing.py), not guessed, given this is executable signing logic.

/** L1-action phantom-agent `source`: "b" on testnet, "a" on mainnet (see {@link HYPERLIQUID_ENV}). */
const L1_PHANTOM_AGENT_SOURCE = hlEnv.phantomAgentSource;

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function nonceToBytes(nonce: number): Uint8Array {
  const out = new Uint8Array(8);
  let n = BigInt(nonce);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Rounds to 8 decimals and strips trailing zeros, matching the Python SDK's `float_to_wire`. */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number.parseFloat(rounded) - x) >= 1e-12) {
    throw new Error(`floatToWire: ${x} doesn't round-trip through 8 decimals`);
  }
  let normalized = rounded === "-0.00000000" ? "0" : rounded;
  if (normalized.includes(".")) {
    normalized = normalized.replace(/0+$/, "").replace(/\.$/, "");
  }
  return normalized;
}

function l1ActionHash(action: unknown, nonce: number, vaultAddress: Address | null): Hex {
  const actionBytes = msgpackEncode(action);
  const nonceBytes = nonceToBytes(nonce);
  const vaultBytes = vaultAddress ? concatBytes(new Uint8Array([1]), hexToBytes(vaultAddress)) : new Uint8Array([0]);
  return keccak256(concatBytes(actionBytes, nonceBytes, vaultBytes));
}

export interface LimitOrderParams {
  assetIndex: number;
  isBuy: boolean;
  limitPx: number;
  size: number;
  reduceOnly?: boolean;
  tif?: "Gtc" | "Ioc" | "Alo";
}

/** Builds a single-order `{type: "order", ...}` L1 action. Field order within each order matters for the msgpack hash — don't reorder. */
export function buildLimitOrderAction(order: LimitOrderParams): Record<string, unknown> {
  return {
    type: "order",
    orders: [
      {
        a: order.assetIndex,
        b: order.isBuy,
        p: floatToWire(order.limitPx),
        s: floatToWire(order.size),
        r: order.reduceOnly ?? false,
        t: { limit: { tif: order.tif ?? "Gtc" } },
      },
    ],
    grouping: "na",
  };
}

export interface CancelOrderParams {
  assetIndex: number;
  orderId: number;
}

/** Builds a single-cancel `{type: "cancel", ...}` L1 action. */
export function buildCancelOrderAction({ assetIndex, orderId }: CancelOrderParams): Record<string, unknown> {
  return { type: "cancel", cancels: [{ a: assetIndex, o: orderId }] };
}

export interface UpdateLeverageParams {
  assetIndex: number;
  leverage: number;
  /** Isolated (false) vs cross (true) margin mode for this asset going forward. */
  isCross: boolean;
}

/**
 * Builds an `{type: "updateLeverage", ...}` L1 action. Leverage and margin mode aren't fields on
 * an order itself — Hyperliquid requires setting them via this separate action first, and it then
 * applies to whatever position that asset's next order opens or adds to. Field names match
 * Hyperliquid's official Python SDK (`update_leverage`).
 */
export function buildUpdateLeverageAction({ assetIndex, leverage, isCross }: UpdateLeverageParams): Record<string, unknown> {
  return { type: "updateLeverage", asset: assetIndex, isCross, leverage };
}

/**
 * Hyperliquid price-tick rules, per Hyperliquid's published API docs: at most 5 significant
 * figures, and no more than `maxDecimals - szDecimals` decimal places, where `maxDecimals` is 6
 * for perps and 8 for spot (spot tokens can sit at much smaller-denomination prices). Unlike most
 * of this file's other constants, this hasn't been independently re-verified live (no funded,
 * order-placing testnet account was available while building this) — if a limit/market order is
 * ever rejected with a tick-size/decimals error, check this first.
 */
function roundHyperliquidPrice(price: number, szDecimals: number, maxDecimals: number): number {
  const allowedDecimals = Math.max(0, maxDecimals - szDecimals);
  const sigFigRounded = Number(price.toPrecision(5));
  return Number(sigFigRounded.toFixed(allowedDecimals));
}

const PERP_MAX_PRICE_DECIMALS = 6;
const SPOT_MAX_PRICE_DECIMALS = 8;

export function roundPerpPrice(price: number, szDecimals: number): number {
  return roundHyperliquidPrice(price, szDecimals, PERP_MAX_PRICE_DECIMALS);
}

export function roundSpotPrice(price: number, szDecimals: number): number {
  return roundHyperliquidPrice(price, szDecimals, SPOT_MAX_PRICE_DECIMALS);
}

/**
 * Builds a `{type: "vaultTransfer", ...}` L1 action — deposit into (or withdraw
 * from) a Hyperliquid vault. `usd` on the wire is **micro-USD** (actual USD ×
 * 1e6, an integer), matching Hyperliquid's Python SDK `vault_usd_transfer`.
 * Deposits move USDC from the account's perp balance into the vault; withdrawals
 * return it to the perp balance (subject to the vault's lock-up).
 */
export function buildVaultTransferAction(vaultAddress: Address, isDeposit: boolean, usd: number): Record<string, unknown> {
  return { type: "vaultTransfer", vaultAddress, isDeposit, usd: Math.round(usd * 1_000_000) };
}

/** Hyperliquid's own Python SDK default slippage for its `market_open`/`market_close` helpers. */
export const MARKET_ORDER_SLIPPAGE = 0.05;

/**
 * Hyperliquid has no literal "market order" type — a market order is an
 * aggressive IOC limit priced past the current mid by `slippage`, exactly
 * like the official Python SDK's `market_open` does it.
 */
export function marketOrderLimitPrice(mid: number, isBuy: boolean, szDecimals: number, slippage = MARKET_ORDER_SLIPPAGE): number {
  const raw = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
  return roundPerpPrice(raw, szDecimals);
}

/**
 * Spot order/cancel asset ids are `10000 + universe index` — Hyperliquid's own convention for
 * disambiguating spot markets from perp asset indices, which otherwise share the same numeric `a`
 * field in L1 actions.
 */
export function spotAssetId(spotIndex: number): number {
  return 10_000 + spotIndex;
}

export interface L2BookLevel {
  px: string;
  sz: string;
  n: number;
}

/** `levels` is `[bids, asks]`, each sorted best-first (best bid highest, best ask lowest). */
export interface L2Book {
  coin: string;
  time: number;
  levels: [L2BookLevel[], L2BookLevel[]];
}

/** Live order-book snapshot for a coin (perp symbol or spot `@{index}`). */
export function fetchL2Book(coin: string): Promise<L2Book> {
  return fetchInfo({ type: "l2Book", coin });
}

/**
 * Signs the fixed "phantom agent" EIP-712 struct (`Agent { source, connectionId }`, domain
 * `Exchange`/chainId 1337) that every L1 action's `connectionId` gets wrapped in, and returns the
 * resulting r/s/v directly — this is the one piece two very different signers both need to
 * implement: a local agent-wallet key (fast, no ceremony) or a Salt MPC ceremony (slower, no local
 * key at all). See `commands/hyperliquid.ts` for both implementations.
 */
export interface L1ActionSigner {
  signAgent(args: { domain: unknown; types: unknown; primaryType: string; message: unknown }): Promise<HyperliquidSignature>;
}

/** Wraps a raw agent-wallet private key (held only in memory by the caller) as an {@link L1ActionSigner}. */
export function agentKeySigner(privateKey: Hex): L1ActionSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    async signAgent(args) {
      const signatureHex = await account.signTypedData(
        args as Parameters<typeof account.signTypedData>[0],
      );
      const { r, s, v } = hexToSignature(signatureHex);
      return { r, s, v: Number(v) };
    },
  };
}

export interface OrderStatusResting {
  resting: { oid: number };
}
export interface OrderStatusFilled {
  filled: { oid: number; totalSz: string; avgPx: string };
}
export interface OrderStatusErrorEntry {
  error: string;
}
export type OrderStatus = OrderStatusResting | OrderStatusFilled | OrderStatusErrorEntry;

export interface ExchangeActionResponse {
  status: string;
  response: { type: string; data?: { statuses?: unknown[] } };
}

/**
 * Per Hyperliquid's documented `/exchange` response shape, the top-level `status` is `"ok"` even
 * when an individual order/cancel inside `statuses` failed — that failure shows up as `{ error:
 * "..." }` at the per-item level instead, and `postJson`'s top-level-only check doesn't catch it.
 * Pulls those out so a rejected order/cancel doesn't get reported as a success. Documented
 * behavior, not independently re-verified live (see {@link PERP_MAX_PRICE_DECIMALS}) — the first
 * thing to check if a rejected order is ever reported here as having succeeded.
 */
export function extractActionErrors(response: ExchangeActionResponse): string[] {
  const statuses = response.response?.data?.statuses ?? [];
  return statuses
    .map((entry) => (typeof entry === "object" && entry !== null && "error" in entry ? String((entry as OrderStatusErrorEntry).error) : null))
    .filter((e): e is string => e !== null);
}

/**
 * Signs an L1 action via the given {@link L1ActionSigner} and submits it to `/exchange`.
 * Deliberately signer-agnostic: with an {@link agentKeySigner} this needs no gas and no Salt/MPC
 * involvement (the "agent trades without a ceremony" path); with an MPC-ceremony-backed signer it
 * costs a full ceremony per call instead, same as every other signed action in this app.
 */
export async function signAndSubmitL1Action(
  signer: L1ActionSigner,
  action: Record<string, unknown>,
  vaultAddress: Address | null = null,
): Promise<ExchangeActionResponse> {
  const nonce = Date.now();
  const connectionId = l1ActionHash(action, nonce, vaultAddress);
  const signature = await signer.signAgent({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: L1_PHANTOM_AGENT_SOURCE, connectionId },
  });
  return postJson("/exchange", { action, nonce, signature, vaultAddress });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HYPERLIQUID_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => undefined);
  const err = (json as { response?: unknown } | undefined)?.response;
  if (!res.ok || (json as { status?: string } | undefined)?.status === "err") {
    throw new Error(typeof err === "string" ? err : `Hyperliquid ${path} request failed (HTTP ${res.status})`);
  }
  return json as T;
}

/** Submits a signed `approveAgent` action to Hyperliquid's exchange endpoint. */
export function submitApproveAgent(
  params: ApproveAgentParams,
  signature: HyperliquidSignature,
): Promise<unknown> {
  return postJson("/exchange", {
    action: {
      type: "approveAgent",
      hyperliquidChain: HYPERLIQUID_CHAIN_LABEL,
      signatureChainId: `0x${HYPEREVM_CHAIN_ID.toString(16)}`,
      agentAddress: params.agentAddress,
      agentName: params.agentName,
      nonce: params.nonce,
    },
    signature,
    nonce: params.nonce,
  });
}

/** Submits a signed `sendAsset` (HyperCore -> HyperEVM withdrawal) action. */
export function submitSendAsset(params: SendAssetParams, signature: HyperliquidSignature): Promise<unknown> {
  return postJson("/exchange", {
    action: {
      type: "sendAsset",
      hyperliquidChain: HYPERLIQUID_CHAIN_LABEL,
      signatureChainId: `0x${HYPEREVM_CHAIN_ID.toString(16)}`,
      destination: params.destination,
      sourceDex: params.sourceDex,
      destinationDex: params.destinationDex,
      token: params.token,
      amount: params.amount,
      fromSubAccount: params.fromSubAccount,
      nonce: params.nonce,
    },
    signature,
    nonce: params.nonce,
  });
}

function fetchInfo<T>(body: Record<string, unknown>): Promise<T> {
  return postJson("/info", body);
}

export interface ExtraAgent {
  address: Address;
  name: string;
  validUntil: number;
}

/** The agents currently approved to trade on `user`'s behalf — the source of truth for verifying an approval. */
export function fetchExtraAgents(user: Address): Promise<ExtraAgent[]> {
  return fetchInfo({ type: "extraAgents", user });
}

/** Shape shared by `marginSummary` and `crossMarginSummary` in `clearinghouseState`. All fields are decimal strings. */
export interface MarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

/**
 * A single open perp position. Field list confirmed live against testnet
 * `clearinghouseState` and cross-checked against Hyperliquid's official
 * Python SDK types (`AssetPosition`/`PerpPosition` in `types.py`).
 * `liquidationPx` is `null` when the position can't be liquidated at any
 * price (e.g. fully isolated-margined with no additional risk).
 */
export interface AssetPosition {
  position: {
    coin: string;
    szi: string;
    leverage: { type: "cross" | "isolated"; value: number };
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    liquidationPx: string | null;
    marginUsed: string;
    maxLeverage: number;
    cumFunding: { allTime: string; sinceOpen: string; sinceChange: string };
  };
  type: string;
}

export interface ClearinghouseState {
  marginSummary: MarginSummary;
  crossMarginSummary: MarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: AssetPosition[];
  time: number;
}

/** Perp account summary: margin, account value, positions. Shape is Hyperliquid's own `clearinghouseState`, confirmed live against testnet. */
export function fetchClearinghouseState(user: Address): Promise<ClearinghouseState> {
  return fetchInfo({ type: "clearinghouseState", user });
}

/** A depositor's position in a vault (`followerState`), from `vaultDetails`. All amounts are decimal USD strings; `lockupUntil` is an epoch-ms timestamp. */
export interface VaultFollowerState {
  vaultEquity: string;
  pnl: string;
  allTimePnl: string;
  lockupUntil: number;
}

/** Live vault info from `/info` `vaultDetails`. `apr` is a fraction (0.07 = 7%). `followerState` is the queried user's position, or null if they haven't deposited. */
export interface VaultDetails {
  name: string;
  vaultAddress: string;
  apr: number;
  allowDeposits: boolean;
  isClosed: boolean;
  followerState: VaultFollowerState | null;
}

/** Vault details, optionally including `user`'s own position (`followerState`). Shape confirmed live against mainnet HLP. */
export function fetchVaultDetails(vaultAddress: string, user?: string): Promise<VaultDetails> {
  return fetchInfo(user ? { type: "vaultDetails", vaultAddress, user } : { type: "vaultDetails", vaultAddress });
}

export interface PerpMetaAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface PerpMeta {
  universe: PerpMetaAsset[];
}

/**
 * Perp market metadata (confirmed shape live against testnet). Each entry's position in
 * `universe` *is* its asset index for order/cancel L1 actions — unlike spot, whose asset ids are
 * `10000 + spotIndex` (see {@link HYPE_USDC_SPOT_PAIR_INDEX} above).
 */
export function fetchMeta(): Promise<PerpMeta> {
  return fetchInfo({ type: "meta" });
}

/**
 * Per-asset live context from `metaAndAssetCtxs`, index-aligned with the meta
 * `universe`. `funding` is the current **hourly** funding rate as a decimal
 * string (e.g. "0.0000125" = 0.00125%/hr); a positive rate means longs pay
 * shorts. `markPx`/`oraclePx` are the perp mark and spot-oracle prices.
 */
export interface AssetCtx {
  funding: string;
  markPx: string;
  oraclePx: string;
  openInterest: string;
  premium: string | null;
}

/** `[meta, assetCtxs]` where `assetCtxs[i]` corresponds to `meta.universe[i]`. Shape confirmed live against mainnet. */
export function fetchMetaAndAssetCtxs(): Promise<[PerpMeta, AssetCtx[]]> {
  return fetchInfo({ type: "metaAndAssetCtxs" });
}

/** coin → current hourly funding rate (as a number), from `metaAndAssetCtxs`. Positive = longs pay shorts. */
export async function fetchFundingRates(): Promise<Map<string, number>> {
  const [meta, ctxs] = await fetchMetaAndAssetCtxs();
  const out = new Map<string, number>();
  meta.universe.forEach((asset, i) => {
    const funding = ctxs[i]?.funding;
    if (funding !== undefined) out.set(asset.name, Number(funding));
  });
  return out;
}

export interface SpotBalance {
  coin: string;
  token: number;
  /** Total held, decimal string. */
  total: string;
  /** Portion of `total` locked in open orders. */
  hold: string;
  entryNtl: string;
}

export interface SpotClearinghouseState {
  balances: SpotBalance[];
}

/** Spot token balances. Shape is Hyperliquid's own `spotClearinghouseState`. */
export function fetchSpotClearinghouseState(user: Address): Promise<SpotClearinghouseState> {
  return fetchInfo({ type: "spotClearinghouseState", user });
}

/** `"B"` (bid/buy) or `"A"` (ask/sell) — Hyperliquid's own side encoding across orders and fills. */
export type OrderSide = "B" | "A";

export interface OpenOrder {
  coin: string;
  side: OrderSide;
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
}

/** Currently-open orders across all markets. */
export function fetchOpenOrders(user: Address): Promise<OpenOrder[]> {
  return fetchInfo({ type: "openOrders", user });
}

export interface UserFill {
  coin: string;
  side: OrderSide;
  px: string;
  sz: string;
  time: number;
  /** Human-readable fill classification, e.g. "Open Long", "Close Short". */
  dir: string;
  closedPnl: string;
  fee: string;
  feeToken: string;
  oid: number;
}

/** Recent fills (trade history). */
export function fetchUserFills(user: Address): Promise<UserFill[]> {
  return fetchInfo({ type: "userFills", user });
}

/** Current mid price for every actively-traded coin, keyed by coin symbol (e.g. `"BTC"`, `"ETH"`). Used to show mark price / live notional on positions not otherwise carrying a fresh price. */
export function fetchAllMids(): Promise<Record<string, string>> {
  return fetchInfo({ type: "allMids" });
}

export interface SpotMetaUniverseEntry {
  /** `[baseTokenIndex, quoteTokenIndex]` into `tokens` below. */
  tokens: [number, number];
  name: string;
  index: number;
  isCanonical: boolean;
}

export interface SpotMetaToken {
  name: string;
  index: number;
  szDecimals: number;
}

export interface SpotMeta {
  universe: SpotMetaUniverseEntry[];
  tokens: SpotMetaToken[];
}

/** Spot market metadata — token list and trading-pair universe. Needed to resolve `@{index}` coin identifiers (see {@link resolveSpotCoin}) back to human-readable pair names. */
export function fetchSpotMeta(): Promise<SpotMeta> {
  return fetchInfo({ type: "spotMeta" });
}

/**
 * Hyperliquid's `coin` field on orders/fills is the plain symbol for perps
 * (e.g. `"BTC"`) but `@{index}` — an index into `spotMeta.universe` — for
 * most spot markets, since only `isCanonical` pairs (like `PURR/USDC`) get a
 * real name from the API itself; everything else's `universe[i].name` is
 * just `"@{i}"` too, so the universe entry alone doesn't help. Confirmed
 * live against testnet: `@1035` -> `universe[1035].tokens = [1105, 0]` ->
 * `tokens[1105].name` / `tokens[0].name` = `HYPE` / `USDC`. Falls back to
 * the raw string (including a bare `@N`) if the lookup fails, rather than
 * throwing on an unmapped/delisted pair.
 */
export function resolveSpotCoin(coin: string, spotMeta: SpotMeta): string {
  if (!coin.startsWith("@")) return coin;
  const index = Number(coin.slice(1));
  const pair = spotMeta.universe.find((u) => u.index === index);
  if (!pair) return coin;
  const [baseIndex, quoteIndex] = pair.tokens;
  const base = spotMeta.tokens.find((t) => t.index === baseIndex)?.name;
  const quote = spotMeta.tokens.find((t) => t.index === quoteIndex)?.name;
  return base && quote ? `${base}/${quote}` : coin;
}

/**
 * Finds the spot market trading `baseTokenSymbol` directly against USDC (base token first, USDC
 * quote — matches how every such pair has been observed, e.g. HYPE/USDC), and returns its
 * universe index (for {@link spotAssetId}) plus the base token's `szDecimals` (which also governs
 * that market's price-tick rounding — see {@link roundSpotPrice}). Returns `undefined` if either
 * token or the pair itself can't be found.
 */
export function findSpotPairAgainstUsdc(spotMeta: SpotMeta, baseTokenSymbol: string): { pairIndex: number; szDecimals: number } | undefined {
  const baseToken = spotMeta.tokens.find((t) => t.name === baseTokenSymbol);
  const usdcToken = spotMeta.tokens.find((t) => t.name === "USDC");
  if (!baseToken || !usdcToken) return undefined;
  const pair = spotMeta.universe.find((u) => u.tokens[0] === baseToken.index && u.tokens[1] === usdcToken.index);
  return pair ? { pairIndex: pair.index, szDecimals: baseToken.szDecimals } : undefined;
}

// --- Local, non-secret agent metadata ---------------------------------------
//
// Unlike a generated agent key, the agent address here is user-supplied and
// never held by salt-fi, so nothing below is a secret — plaintext local
// storage (matching session.ts's existing pattern for auth tokens) is fine.

import fs from "node:fs";
import path from "node:path";

const AGENTS_FILE = path.resolve(process.cwd(), ".hyperliquid-agents.json");

export interface AgentMetadata {
  agentAddress: Address;
  agentName: string;
  approvedAt: number;
  lastVerified?: number;
}

type AgentStore = Record<string, AgentMetadata>;

function readAgentStore(): AgentStore {
  try {
    return JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8")) as AgentStore;
  } catch {
    return {};
  }
}

function writeAgentStore(store: AgentStore): void {
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(store, null, 2));
}

export function getAgentMetadata(accountId: string): AgentMetadata | undefined {
  return readAgentStore()[accountId];
}

export function saveAgentMetadata(accountId: string, metadata: AgentMetadata): void {
  const store = readAgentStore();
  store[accountId] = metadata;
  writeAgentStore(store);
}

export function touchAgentVerified(accountId: string, lastVerified: number): void {
  const store = readAgentStore();
  const existing = store[accountId];
  if (!existing) return;
  store[accountId] = { ...existing, lastVerified };
  writeAgentStore(store);
}
