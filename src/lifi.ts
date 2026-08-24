import type { Address } from "viem";

/**
 * LI.FI aggregator client — cross-chain bridge + swap quotes and status.
 *
 * A single GET /v1/quote returns a ready-to-sign `transactionRequest` (to, data,
 * value) that we submit on the SOURCE chain via a Salt MPC ceremony; LI.FI's
 * chosen bridge then delivers the destination token (and, optionally, a slice of
 * native gas) to the account on the destination chain. GET /v1/status tracks the
 * cross-chain leg to completion.
 *
 * Verified live against li.quest/v1 (2026-08): endpoints, param names, and the
 * `transactionRequest`/`estimate` response shape. `fromAmountForGas` is a SUBSET
 * of `fromAmount` (the tx `value` stays equal to `fromAmount`) — set `fromAmount`
 * to the total you want to spend and carve the gas slice out of it.
 */

export const LIFI_API = "https://li.quest/v1";
/** Canonical LI.FI Diamond — the `to` (and `approvalAddress`) every quote returns. */
export const LIFI_DIAMOND: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
/** LI.FI's native-asset sentinel (same zero address the app uses elsewhere). */
export const LIFI_NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";
/** Identifies this integration to LI.FI (analytics only — not a fee). */
const INTEGRATOR = "salt-fi";

export interface LifiToken {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
  name?: string;
  priceUSD?: string;
}

export interface QuoteRequest {
  fromChain: number;
  toChain: number;
  /** Token address (use {@link LIFI_NATIVE_TOKEN} for native) or symbol. */
  fromToken: string;
  toToken: string;
  /** Amount to spend, in the source token's smallest unit. */
  fromAmount: bigint;
  fromAddress: string;
  /** Recipient on the destination chain; defaults to `fromAddress`. */
  toAddress?: string;
  /** Max slippage as a decimal (0.005 = 0.5%). */
  slippage?: number;
  /** Portion of `fromAmount` to deliver as native gas on the destination chain. */
  fromAmountForGas?: bigint;
}

export interface LifiFeeCost {
  name: string;
  amount?: string;
  amountUSD?: string;
  included?: boolean;
  token?: LifiToken;
}
export interface LifiGasCost {
  type: string;
  amount?: string;
  amountUSD?: string;
  token?: LifiToken;
}

export interface LifiQuote {
  id: string;
  type: string;
  /** The bridge/tool LI.FI chose (pass to {@link getStatus} to speed it up). */
  tool: string;
  toolDetails?: { key: string; name: string };
  action: { fromToken: LifiToken; toToken: LifiToken; fromChainId: number; toChainId: number };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress: string;
    executionDuration: number;
    feeCosts?: LifiFeeCost[];
    gasCosts?: LifiGasCost[];
  };
  transactionRequest: {
    from: string;
    to: Address;
    chainId: number;
    data: `0x${string}`;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
  };
}

async function lifiError(res: Response, fallback: string): Promise<Error> {
  let msg = `${fallback} (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) msg = body.message;
  } catch {
    // non-JSON body — keep the status-based message
  }
  return new Error(msg);
}

/** Fetch a bridge/swap quote. Throws with LI.FI's message if no route is available. */
export async function getQuote(req: QuoteRequest): Promise<LifiQuote> {
  const params = new URLSearchParams({
    fromChain: String(req.fromChain),
    toChain: String(req.toChain),
    fromToken: req.fromToken,
    toToken: req.toToken,
    fromAmount: req.fromAmount.toString(),
    fromAddress: req.fromAddress,
    integrator: INTEGRATOR,
  });
  if (req.toAddress) params.set("toAddress", req.toAddress);
  if (req.slippage != null) params.set("slippage", String(req.slippage));
  if (req.fromAmountForGas && req.fromAmountForGas > 0n) {
    params.set("fromAmountForGas", req.fromAmountForGas.toString());
  }

  const res = await fetch(`${LIFI_API}/quote?${params.toString()}`);
  if (!res.ok) throw await lifiError(res, "LI.FI could not find a route");
  return (await res.json()) as LifiQuote;
}

export type LifiStatusValue = "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";

export interface LifiTxInfo {
  txHash?: string;
  txLink?: string;
  amount?: string;
  token?: LifiToken;
  chainId?: number;
}

export interface LifiStatus {
  status: LifiStatusValue;
  substatus?: string;
  substatusMessage?: string;
  sending?: LifiTxInfo;
  receiving?: LifiTxInfo;
  lifiExplorerLink?: string;
}

/**
 * Poll the cross-chain status of a source-chain tx. Returns 200 even when the
 * tx isn't indexed yet (status `NOT_FOUND`/`PENDING`), so callers poll until
 * `DONE` or `FAILED`.
 */
export async function getStatus(params: {
  txHash: string;
  fromChain?: number;
  toChain?: number;
  bridge?: string;
}): Promise<LifiStatus> {
  const q = new URLSearchParams({ txHash: params.txHash });
  if (params.fromChain) q.set("fromChain", String(params.fromChain));
  if (params.toChain) q.set("toChain", String(params.toChain));
  if (params.bridge) q.set("bridge", params.bridge);

  const res = await fetch(`${LIFI_API}/status?${q.toString()}`);
  if (!res.ok) throw await lifiError(res, "LI.FI status check failed");
  return (await res.json()) as LifiStatus;
}

const priceKey = (chainId: string, address: string) => `${chainId}:${address.toLowerCase()}`;

/**
 * Current USD price of a token from LI.FI's `/v1/token`, or `null` if
 * unavailable. Works uniformly for native ({@link LIFI_NATIVE_TOKEN}) and ERC-20
 * addresses, keyless. Never throws — pricing is best-effort decoration.
 */
export async function getTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number | null> {
  const q = new URLSearchParams({ chain: String(chainId), token: tokenAddress });
  try {
    const res = await fetch(`${LIFI_API}/token?${q.toString()}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { priceUSD?: string };
    const price = Number(body?.priceUSD);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Fetch USD prices for a set of (chain, token) pairs concurrently, returning a
 * map keyed by `"<chainId>:<lowercased address>"`. Deduplicates inputs; omits
 * any token LI.FI couldn't price. Best-effort — a failed lookup is simply absent.
 */
export async function fetchTokenPricesUsd(
  items: { chainId: string; address: string }[],
): Promise<Map<string, number>> {
  const unique = [...new Map(items.map((i) => [priceKey(i.chainId, i.address), i])).values()];
  const out = new Map<string, number>();
  await Promise.all(
    unique.map(async (i) => {
      const price = await getTokenPriceUsd(Number(i.chainId), i.address);
      if (price != null) out.set(priceKey(i.chainId, i.address), price);
    }),
  );
  return out;
}

/** Key for a {@link fetchTokenPricesUsd} result: `"<chainId>:<lowercased address>"`. */
export function tokenPriceKey(chainId: string, address: string): string {
  return priceKey(chainId, address);
}
