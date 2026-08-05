import { encode as msgpackEncode } from "@msgpack/msgpack";
import type { SaltTypedData } from "salt-sdk";
import { hexToBytes, hexToSignature, keccak256, type Address, type Hex } from "viem";

/**
 * Hyperliquid testnet only — this app is testnet-only throughout (see
 * CLAUDE.md). HyperEVM testnet's chain id (998) is a different chain from
 * both Salt's orchestration chain (Arbitrum Sepolia, 421614) and HyperEVM
 * *mainnet* (999) — don't conflate them the way the old CloudFormation
 * template conflated Salt's testnet/mainnet.
 */
export const HYPERLIQUID_API_URL = "https://api.hyperliquid-testnet.xyz";
export const HYPEREVM_CHAIN_ID = 998;
export const HYPEREVM_RPC_URL = "https://rpc.hyperliquid-testnet.xyz/evm";
/** Value Hyperliquid's `hyperliquidChain` typed-data field expects for testnet actions. */
export const HYPERLIQUID_CHAIN_LABEL = "Testnet";

/**
 * USDC on HyperEVM testnet and its HyperCore spot token index. Confirmed live
 * against Hyperliquid testnet's own `/info` `spotMeta` response (token index
 * 0, `evmContract.address` below) — not a docs/search guess like the
 * previous placeholder here was.
 */
export const USDC_HYPEREVM_ADDRESS: Address = "0x0b80659A4076e9e93c7dBe0F10675a16a3E5c206";
export const USDC_CORE_TOKEN_INDEX = 0;
export const USDC_CORE_TOKEN_ID = "0xeb62eee3685fc4c43992febcd9e75443";
export const HYPE_CORE_TOKEN_ID = "0x7317beb7cceed72ef0b346074cc8e7ab";
/** HyperEVM's fixed system address for native HYPE deposits/withdrawals (unlike ERC-20s, which key off {@link coreSystemAddress}). */
export const HYPE_CORE_SYSTEM_ADDRESS: Address = "0x2222222222222222222222222222222222222222";
/** HYPE/USDC's spot pair index (1035) in spotMeta.universe, confirmed live. Spot order asset ids are `10000 + this`. */
export const HYPE_USDC_SPOT_PAIR_INDEX = 1035;

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
 * `chainId` here is HyperEVM's own chain id — empirically confirmed working
 * for ApproveAgent against live testnet (ceremony succeeded, agent verified
 * afterward). Worth flagging: Hyperliquid's own Python SDK instead hard-codes
 * `0x66eee` (421614, Arbitrum Sepolia) for this domain on *every* network,
 * mainnet included, which doesn't match either HyperEVM chain id. Since our
 * value is proven against the real backend, keep it — but if a new
 * `HyperliquidTransaction:*` action ever fails signature verification here
 * (as opposed to a business-logic rejection like insufficient funds), this
 * mismatch is the first thing to try swapping.
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

/** "b" on testnet, "a" on mainnet — this app is testnet-only, so this is fixed. */
const L1_PHANTOM_AGENT_SOURCE = "b";

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

/**
 * Signs an L1 action with a plain signer (an agent's local viem account, or
 * anything else exposing `signTypedData`) and submits it to `/exchange`.
 * Deliberately takes no Salt/MPC dependency — this is the "agent trades
 * without a ceremony" path.
 */
export async function signAndSubmitL1Action(
  signer: { signTypedData: (args: { domain: unknown; types: unknown; primaryType: string; message: unknown }) => Promise<Hex> },
  action: Record<string, unknown>,
  vaultAddress: Address | null = null,
): Promise<unknown> {
  const nonce = Date.now();
  const connectionId = l1ActionHash(action, nonce, vaultAddress);
  const signatureHex = await signer.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: L1_PHANTOM_AGENT_SOURCE, connectionId },
  });
  const { r, s, v } = hexToSignature(signatureHex);
  return postJson("/exchange", { action, nonce, signature: { r, s, v: Number(v) }, vaultAddress });
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

/** Perp account summary: margin, account value, positions. Shape is Hyperliquid's own `clearinghouseState`. */
export function fetchClearinghouseState(user: Address): Promise<Record<string, unknown>> {
  return fetchInfo({ type: "clearinghouseState", user });
}

/** Spot token balances. Shape is Hyperliquid's own `spotClearinghouseState`. */
export function fetchSpotClearinghouseState(user: Address): Promise<Record<string, unknown>> {
  return fetchInfo({ type: "spotClearinghouseState", user });
}

/** Currently-open orders across all markets. */
export function fetchOpenOrders(user: Address): Promise<unknown[]> {
  return fetchInfo({ type: "openOrders", user });
}

/** Recent fills (trade history). */
export function fetchUserFills(user: Address): Promise<unknown[]> {
  return fetchInfo({ type: "userFills", user });
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
