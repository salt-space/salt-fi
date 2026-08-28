/**
 * Pure "where should this shortfall come from" planning — no I/O, no CLI dependency. Given what
 * a trade/strategy still needs in a specific bucket (spot USDC, perp margin) and what's already
 * sitting idle across every bucket this app knows about, computes the cheapest chain of existing
 * fund-movement hops (see src/margin-router.ts / commands/hyperliquid.ts for the primitives
 * themselves) that would cover it — so Trade and Delta Neutral can offer "move it for me?" instead
 * of hard-erroring the moment one specific bucket alone is insufficient.
 *
 * Every balance here is in **USD-equivalent value**, including HYPE holdings — the caller
 * (margin-router.ts) converts token quantities to an estimated USD value once, at aggregation
 * time, using a live price. That keeps this module's arithmetic in one unit throughout (no
 * mid-algorithm price lookups needed), at the cost of the executor re-pricing HYPE back to a
 * token quantity right before actually selling/transferring it — which is more accurate anyway,
 * since that happens closer to when the order is actually placed.
 */

export interface MarginSources {
  hyperEvm: {
    /** Estimated USD value of native HYPE held on HyperEVM. */
    nativeHypeUsd: number;
    /** `undefined` when the read failed — USDC's HyperEVM contract reverts on `balanceOf()` for every caller, a confirmed Hyperliquid limitation (see margin-router.ts). Treated as "unknown", not zero. */
    usdc: number | undefined;
  };
  spot: {
    usdc: number;
    /** Estimated USD value of HYPE held on HyperCore Spot. */
    hypeUsd: number;
  };
  perp: {
    withdrawable: number;
  };
}

export interface FundingRequirement {
  spotUsdc?: number;
  perpMargin?: number;
}

export type FundingStep =
  | { kind: "hyperEvmToSpot"; asset: "HYPE" | "USDC"; amountUsd: number }
  | { kind: "sellSpotHype"; amountUsd: number }
  | { kind: "spotToPerp"; amount: number };

export interface FundingPlan {
  steps: FundingStep[];
  /** Still short after routing everything available — 0 when fully covered. */
  unresolvedSpotUsdc: number;
  unresolvedPerpMargin: number;
}

/**
 * Greedy, cheapest-hop-first allocator — not globally optimal (e.g. it never considers moving
 * perp margin back to cover a spot shortfall), but correct and easy to reason about: each source
 * is counted toward at most one requirement, so the plan never double-spends the same dollar
 * across both a spot and a perp ask in the same call.
 */
export function planFunding({ sources, requirement }: { sources: MarginSources; requirement: FundingRequirement }): FundingPlan {
  const steps: FundingStep[] = [];

  // Track remaining idle value as we allocate it, so the perp-margin pass can't reuse
  // HyperEVM/spot value the spot-USDC pass already claimed.
  let hyperEvmUsdc = sources.hyperEvm.usdc ?? 0;
  let hyperEvmHypeUsd = sources.hyperEvm.nativeHypeUsd;
  let spotUsdc = sources.spot.usdc;
  let spotHypeUsd = sources.spot.hypeUsd;

  // --- Spot USDC shortfall: HyperEVM USDC (1 hop) -> HyperEVM HYPE, sold after arrival (2 hops).
  // Deliberately never pulls from perp margin here — using perp collateral to fund the spot leg
  // would just create a perp shortfall the second pass then has to re-solve.
  let unresolvedSpotUsdc = Math.max(0, (requirement.spotUsdc ?? 0) - spotUsdc);
  if (unresolvedSpotUsdc > 0 && hyperEvmUsdc > 0) {
    const take = Math.min(unresolvedSpotUsdc, hyperEvmUsdc);
    steps.push({ kind: "hyperEvmToSpot", asset: "USDC", amountUsd: take });
    hyperEvmUsdc -= take;
    unresolvedSpotUsdc -= take;
  }
  if (unresolvedSpotUsdc > 0 && hyperEvmHypeUsd > 0) {
    const take = Math.min(unresolvedSpotUsdc, hyperEvmHypeUsd);
    // HYPE lands on Spot as HYPE, not USDC — a spot-USDC requirement needs it sold too, same as
    // the equivalent last-resort hop under the perp-margin pass below.
    steps.push({ kind: "hyperEvmToSpot", asset: "HYPE", amountUsd: take });
    steps.push({ kind: "sellSpotHype", amountUsd: take });
    hyperEvmHypeUsd -= take;
    unresolvedSpotUsdc -= take;
  }

  // The spot-USDC requirement is satisfied first out of idle spot USDC (that's why the shortfall
  // above nets it out: unresolvedSpotUsdc = requirement.spotUsdc - spotUsdc). Remove that reserved
  // portion now, so the perp-margin pass below can't respend the same dollars — otherwise the plan
  // reports "funded" while actually leaving the spot leg short.
  spotUsdc = Math.max(0, spotUsdc - (requirement.spotUsdc ?? 0));

  // --- Perp margin shortfall: idle spot USDC (1 hop) -> spot HYPE sold first (2 hops) ->
  // HyperEVM USDC (2 hops) -> HyperEVM HYPE (3 hops).
  let unresolvedPerpMargin = Math.max(0, (requirement.perpMargin ?? 0) - sources.perp.withdrawable);
  if (unresolvedPerpMargin > 0 && spotUsdc > 0) {
    const take = Math.min(unresolvedPerpMargin, spotUsdc);
    steps.push({ kind: "spotToPerp", amount: take });
    spotUsdc -= take;
    unresolvedPerpMargin -= take;
  }
  if (unresolvedPerpMargin > 0 && spotHypeUsd > 0) {
    const take = Math.min(unresolvedPerpMargin, spotHypeUsd);
    steps.push({ kind: "sellSpotHype", amountUsd: take });
    steps.push({ kind: "spotToPerp", amount: take });
    spotHypeUsd -= take;
    unresolvedPerpMargin -= take;
  }
  if (unresolvedPerpMargin > 0 && hyperEvmUsdc > 0) {
    const take = Math.min(unresolvedPerpMargin, hyperEvmUsdc);
    steps.push({ kind: "hyperEvmToSpot", asset: "USDC", amountUsd: take });
    steps.push({ kind: "spotToPerp", amount: take });
    hyperEvmUsdc -= take;
    unresolvedPerpMargin -= take;
  }
  if (unresolvedPerpMargin > 0 && hyperEvmHypeUsd > 0) {
    const take = Math.min(unresolvedPerpMargin, hyperEvmHypeUsd);
    steps.push({ kind: "hyperEvmToSpot", asset: "HYPE", amountUsd: take });
    steps.push({ kind: "sellSpotHype", amountUsd: take });
    steps.push({ kind: "spotToPerp", amount: take });
    hyperEvmHypeUsd -= take;
    unresolvedPerpMargin -= take;
  }

  return { steps, unresolvedSpotUsdc: Math.max(0, unresolvedSpotUsdc), unresolvedPerpMargin: Math.max(0, unresolvedPerpMargin) };
}

/** True when `requirement` is already fully covered by `sources` alone — the caller should skip the whole routing flow (and any prompt) entirely in this case. */
export function isAlreadyFunded(sources: MarginSources, requirement: FundingRequirement): boolean {
  const spotOk = (requirement.spotUsdc ?? 0) <= sources.spot.usdc;
  const perpOk = (requirement.perpMargin ?? 0) <= sources.perp.withdrawable;
  return spotOk && perpOk;
}

/** A spot-sell hop only clears Hyperliquid's real order-book minimum if there's at least that much value to sell — a cheap early check before ever quoting a live price for it. */
export function sellHopMeetsMinimum(amountUsd: number, spotMinOrderUsd: number): boolean {
  return amountUsd >= spotMinOrderUsd;
}
