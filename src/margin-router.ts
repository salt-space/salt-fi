/**
 * Aggregates "what does this account actually have, everywhere" — HyperEVM native HYPE, HyperEVM
 * USDC, HyperCore Spot, HyperCore Perps margin — into the shape `margin-router-math.ts`'s planner
 * consumes. I/O only, no prompts; mirrors delta-neutral.ts's split between data-fetching and pure
 * planning. The execution side (turning a plan into real transfers/sells) lives in
 * `commands/hyperliquid.ts`'s `ensureFunded`, alongside the fund-movement primitives it reuses.
 */

import { createPublicClient, http, parseAbi, type Address } from "viem";
import { hyperEvmTestnet } from "./chains.js";
import {
  fetchAllMids,
  fetchClearinghouseState,
  fetchSpotClearinghouseState,
  HYPEREVM_RPC_URL,
  USDC_HYPEREVM_ADDRESS,
} from "./hyperliquid.js";
import type { MarginSources } from "./margin-router-math.js";

function hyperEvmPublicClient() {
  return createPublicClient({ chain: hyperEvmTestnet, transport: http(HYPEREVM_RPC_URL) });
}

export interface HyperEvmBalances {
  nativeHype: number;
  /** `undefined` when the read failed — USDC's HyperEVM contract reverts on `balanceOf()` for every caller, confirmed live (same limitation `viewBalancesFlow` already works around). */
  usdc: number | undefined;
}

/** The same HyperEVM balance reads `viewBalancesFlow` already does, generalized so other callers don't need to duplicate the viem client setup or the USDC-revert workaround. */
export async function fetchHyperEvmBalances(userAddress: Address): Promise<HyperEvmBalances> {
  const publicClient = hyperEvmPublicClient();
  const [hypeBal, usdcBal] = await Promise.all([
    publicClient.getBalance({ address: userAddress }),
    publicClient
      .readContract({
        address: USDC_HYPEREVM_ADDRESS,
        abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
        functionName: "balanceOf",
        args: [userAddress],
      })
      .catch((): bigint | undefined => undefined),
  ]);
  return { nativeHype: Number(hypeBal) / 1e18, usdc: usdcBal !== undefined ? Number(usdcBal) / 1e6 : undefined };
}

/**
 * Aggregates every bucket into one `MarginSources` view. HYPE holdings (HyperEVM native + Spot)
 * are converted to an estimated USD value using Hyperliquid's live HYPE perp mid price — the
 * cheapest already-proven price source in this app (`fetchAllMids`, used for every mark-price
 * read elsewhere). This is a planning-time estimate only; `ensureFunded` re-prices with a fresh
 * quote right before actually transferring/selling anything, since that's closer to when it
 * matters and this estimate can go slightly stale between aggregation and execution.
 */
export async function aggregateMarginSources(userAddress: Address): Promise<MarginSources> {
  const [hyperEvm, spot, perp, mids] = await Promise.all([
    fetchHyperEvmBalances(userAddress),
    fetchSpotClearinghouseState(userAddress),
    fetchClearinghouseState(userAddress),
    fetchAllMids(),
  ]);

  const hypePrice = Number(mids.HYPE ?? 0);
  const spotUsdc = spot.balances.find((b) => b.coin === "USDC");
  const spotHype = spot.balances.find((b) => b.coin === "HYPE");
  const spotHypeQty = spotHype ? Number(spotHype.total) - Number(spotHype.hold) : 0;

  return {
    hyperEvm: {
      nativeHypeUsd: hypePrice > 0 ? hyperEvm.nativeHype * hypePrice : 0,
      usdc: hyperEvm.usdc,
    },
    spot: {
      usdc: spotUsdc ? Number(spotUsdc.total) - Number(spotUsdc.hold) : 0,
      hypeUsd: hypePrice > 0 ? spotHypeQty * hypePrice : 0,
    },
    perp: {
      withdrawable: Number(perp.withdrawable),
    },
  };
}
