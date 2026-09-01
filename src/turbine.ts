import { type Address, type Hex, maxUint160, type PublicClient } from "viem";
import type { SaltTypedData } from "salt-sdk";

/**
 * Turbine client — PropellerHeads' intent-based execution protocol (Ethereum
 * mainnet). You submit a signed `OrderIntent` (a patient order with a spread
 * curve that decays the acceptable price over its window) and solvers fill it;
 * this is the app's "Slow swap (Turbine)".
 *
 * Non-custodial: the account keeps custody and authorises the settler to pull
 * the sell token via **Permit2**. Turbine's whole API surface is EIP-712 — the
 * order, the per-request auth envelope, and the Permit2 permit are all typed-data
 * signatures — so a Salt MPC account signs everything via `salt.signTypedData`;
 * no local key, and no API key (the signed envelope *is* the auth).
 *
 * The EIP-712 type definitions, the wire envelope shape, and the Permit2
 * AllowanceTransfer flow are reproduced verbatim from `propeller-heads/turbine-sdk`
 * (`src/eip712.ts`, `src/permit2.ts`, `src/turbineClient.ts`) rather than pulled
 * as a dependency — the SDK isn't published to npm, and reproducing lets us route
 * signing through MPC instead of its local-key `walletClient`. Re-verify against
 * the SDK on any Turbine version bump.
 */

/** Turbine mainnet API. Overridable for a Tenderly/testnet backend. */
export const TURBINE_API = process.env.TURBINE_API_URL ?? "https://api.turbine.exchange/api";
/** Canonical Uniswap Permit2 (same on every chain). */
export const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const NULL_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// --- EIP-712 type definitions (verbatim from turbine-sdk/src/eip712.ts) -----------

const ORDER_INTENT_TYPES = {
  OrderIntent: [
    { name: "owner", type: "address" },
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "minBuyAmount", type: "uint256" },
    { name: "startDeltaBps", type: "int32" },
    { name: "endDeltaBps", type: "int32" },
    { name: "points", type: "SpreadCurvePoint[]" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "partialFill", type: "bool" },
    { name: "callData", type: "bytes" },
    { name: "callDataTarget", type: "address" },
    { name: "salt", type: "bytes32" },
  ],
  SpreadCurvePoint: [
    { name: "timeSecs", type: "uint64" },
    { name: "deltaBps", type: "int32" },
  ],
} as const;

const ADD_ORDER_TYPES = {
  AddOrder: [
    { name: "order", type: "OrderIntent" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
  ...ORDER_INTENT_TYPES,
} as const;

// Permit2 AllowanceTransfer `PermitSingle` (Uniswap Permit2 standard).
const PERMIT2_ALLOWANCE_TYPES = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
} as const;

// --- Config -----------------------------------------------------------------------

export interface TurbineEip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
  /** Turbine's domain carries a salt (unlike most EIP-712 domains). */
  salt: Hex;
}

export interface TurbineToken {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface TurbineConfig {
  turbineSettlerAddress: Address;
  siweDomain: string;
  /** USDC-denominated (6dp) minimum trade size, as a decimal string. */
  minTradeSizeUsdc: string;
  eip712Domain: TurbineEip712Domain;
  /** Max lifetime (seconds) of an auth signature. */
  maxSignatureLifetimeS: number;
  tokens: TurbineToken[];
}

/** Fetch Turbine's live config — the EIP-712 domain (incl. the settler `verifyingContract`), token list, and limits. */
export async function fetchTurbineConfig(): Promise<TurbineConfig> {
  const res = await fetch(`${TURBINE_API}/config`);
  if (!res.ok) throw new Error(`Turbine /config failed (HTTP ${res.status})`);
  return (await res.json()) as TurbineConfig;
}

// --- Order + spread-curve model ---------------------------------------------------

export interface SpreadCurvePoint {
  /** 0 = order start … 10_000 = order end. */
  windowBps: number;
  deltaBps: number;
}
export interface SpreadCurve {
  startDeltaBps: number;
  endDeltaBps: number;
  points: SpreadCurvePoint[];
}

export interface OrderIntent {
  owner: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  minBuyAmount: bigint;
  spreadCurve: SpreadCurve;
  startTime: bigint;
  endTime: bigint;
  partialFill: boolean;
  callData: Hex;
  callDataTarget: Address;
  salt: Hex;
}

/** A flat spread of `deltaBps` hundredths-of-a-percent for the whole window (turbine-sdk `spreads.constant`). */
export function constantSpread(deltaBps: number): SpreadCurve {
  return { startDeltaBps: deltaBps, endDeltaBps: deltaBps, points: [] };
}

/** Random bytes32 salt (order uniqueness). */
export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** Random u64 nonce as a decimal string (the backend parses it as a decimal string to keep >2^53 precision). */
export function randomNonce(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n.toString(10);
}

/** now + maxLifetime − 5s margin (backend allows zero clock skew). */
export function authDeadline(maxSignatureLifetimeS: number): number {
  return Math.floor(Date.now() / 1000) + maxSignatureLifetimeS - 5;
}

/**
 * Resolve a spread curve's `windowBps` knots to absolute unix timestamps, exactly
 * as turbine-sdk does: `timeSecs = start + windowBps*(end-start)/10_000`, floored.
 */
function resolveSpreadPoints(startTime: bigint, endTime: bigint, curve: SpreadCurve) {
  const duration = endTime - startTime;
  return curve.points.map((p) => ({
    timeSecs: startTime + (BigInt(p.windowBps) * duration) / 10_000n,
    deltaBps: p.deltaBps,
  }));
}

/** The signed form of an order: inline spread curve replaced by start/end deltas + resolved-timestamp knots. */
function signedOrderMessage(intent: OrderIntent) {
  return {
    owner: intent.owner,
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: intent.sellAmount,
    minBuyAmount: intent.minBuyAmount,
    startDeltaBps: intent.spreadCurve.startDeltaBps,
    endDeltaBps: intent.spreadCurve.endDeltaBps,
    points: resolveSpreadPoints(intent.startTime, intent.endTime, intent.spreadCurve),
    startTime: intent.startTime,
    endTime: intent.endTime,
    partialFill: intent.partialFill,
    callData: intent.callData,
    callDataTarget: intent.callDataTarget,
    salt: intent.salt,
  };
}

// --- Typed-data builders (to sign via salt.signTypedData) --------------------------

/** EIP-712 typed data for the `AddOrder` auth envelope. Sign this; the signature authorises the submit. */
export function buildAddOrderTypedData(
  intent: OrderIntent,
  nonce: string,
  deadline: number,
  domain: TurbineEip712Domain,
): SaltTypedData {
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
      salt: domain.salt,
    },
    types: ADD_ORDER_TYPES as unknown as SaltTypedData["types"],
    primaryType: "AddOrder",
    message: { order: signedOrderMessage(intent), nonce: BigInt(nonce), deadline: BigInt(deadline) } as unknown as SaltTypedData["message"],
  };
}

export interface Permit2Details {
  token: Address;
  /** uint160 — big, goes on the wire as hex. */
  amount: bigint;
  /** uint48 — a plain JS number (the backend wants a `u64`, not a hex string). */
  expiration: number;
  /** uint48 — a plain JS number. */
  nonce: number;
}
export interface Permit2PermitSingle {
  details: Permit2Details;
  spender: Address;
  /** uint256 — hex on the wire. */
  sigDeadline: bigint;
}

/** Build a Permit2 AllowanceTransfer `PermitSingle` (infinite `amount`, expiry = order end) + its typed data. */
export function buildPermit2Permit(params: {
  token: Address;
  spender: Address;
  /** Permit2 AllowanceTransfer nonce (uint48). */
  nonce: number;
  /** Order end time (seconds); used for both the permit's uint48 `expiration` and its uint256 `sigDeadline`. */
  deadline: bigint;
  chainId: number;
}): { permit: Permit2PermitSingle; typedData: SaltTypedData } {
  const permit: Permit2PermitSingle = {
    // uint48 fields as numbers; uint160/uint256 as bigints — matches the SDK's on-wire types.
    details: { token: params.token, amount: maxUint160, expiration: Number(params.deadline), nonce: params.nonce },
    spender: params.spender,
    sigDeadline: params.deadline,
  };
  const typedData: SaltTypedData = {
    // Permit2 AllowanceTransfer domain: {name, chainId, verifyingContract} — no version.
    domain: { name: "Permit2", chainId: params.chainId, verifyingContract: PERMIT2_ADDRESS },
    types: PERMIT2_ALLOWANCE_TYPES as unknown as SaltTypedData["types"],
    primaryType: "PermitSingle",
    message: permit as unknown as SaltTypedData["message"],
  };
  return { permit, typedData };
}

/** Permit2's current AllowanceTransfer nonce for (owner, token, spender) — the nonce a new permit must use. */
export async function readPermit2Nonce(
  publicClient: PublicClient,
  owner: Address,
  token: Address,
  spender: Address,
): Promise<number> {
  const res = (await publicClient.readContract({
    address: PERMIT2_ADDRESS,
    abi: [
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
          { name: "", type: "address" },
          { name: "", type: "address" },
          { name: "", type: "address" },
        ],
        outputs: [
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
    ],
    functionName: "allowance",
    args: [owner, token, spender],
  })) as [bigint, number, number];
  return res[2]; // uint48 nonce, as a number
}

// --- Submission -------------------------------------------------------------------

/** Turbine's structured signature form. */
export interface PrimitiveSignature {
  r: bigint;
  s: bigint;
  yParity: boolean;
}

/** Convert a Salt MPC `EvmSignature` (`{r, s, v}`, v = 27/28) to Turbine's `{r, s, yParity}`. */
export function toPrimitiveSignature(sig: { r: Hex; s: Hex; v: bigint }): PrimitiveSignature {
  const v = Number(sig.v);
  const parity = v >= 27 ? v - 27 : v; // tolerate 27/28 or 0/1
  return { r: BigInt(sig.r), s: BigInt(sig.s), yParity: parity === 1 };
}

export interface Eip712AuthBlock {
  signer: Address;
  nonce: string;
  deadline: number;
  signature: PrimitiveSignature;
}

/**
 * POST `/api/eip712/add_order`. `order` is the intent MINUS its spreadCurve (which
 * rides alongside at the payload level), plus the signed Permit2 permit. Returns
 * the order hash.
 */
export async function submitAddOrder(params: {
  intent: OrderIntent;
  signedPermit: { signature: PrimitiveSignature; permit: Permit2PermitSingle };
  auth: Eip712AuthBlock;
}): Promise<string> {
  const { spreadCurve, ...order } = params.intent;
  const body = {
    payload: { order, spreadCurve, signedPermit: params.signedPermit },
    auth: params.auth,
  };
  const res = await fetch(`${TURBINE_API}/eip712/add_order`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The backend expects bigints as 0x-HEX strings (matches the SDK's `bigIntReplacer`);
    // the auth `nonce` is deliberately a plain decimal string, so it's left untouched here.
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)),
  });
  if (!res.ok) {
    let msg = `Turbine add_order failed (HTTP ${res.status})`;
    try {
      const text = await res.text();
      try {
        const b = JSON.parse(text) as { message?: string; error?: string };
        msg = b.message ?? b.error ?? `${msg}: ${text.slice(0, 300)}`;
      } catch {
        if (text) msg = `${msg}: ${text.slice(0, 300)}`;
      }
    } catch {
      // keep status-based message
    }
    throw new Error(msg);
  }
  const out = (await res.json()) as { orderHash?: string };
  if (!out.orderHash) throw new Error("Turbine accepted the request but returned no orderHash.");
  return out.orderHash;
}

export { NULL_ADDRESS };
