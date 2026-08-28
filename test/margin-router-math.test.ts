import { describe, expect, it } from "vitest";
import { isAlreadyFunded, planFunding, sellHopMeetsMinimum, type MarginSources } from "../src/margin-router-math.js";

function sources(overrides: Partial<MarginSources> = {}): MarginSources {
  return {
    hyperEvm: { nativeHypeUsd: 0, usdc: 0 },
    spot: { usdc: 0, hypeUsd: 0 },
    perp: { withdrawable: 0 },
    ...overrides,
  };
}

describe("isAlreadyFunded", () => {
  it("is true when every requirement is already covered", () => {
    const s = sources({ spot: { usdc: 100, hypeUsd: 0 }, perp: { withdrawable: 200 } });
    expect(isAlreadyFunded(s, { spotUsdc: 100, perpMargin: 200 })).toBe(true);
  });

  it("is false when any single requirement is short", () => {
    const s = sources({ spot: { usdc: 50, hypeUsd: 0 }, perp: { withdrawable: 200 } });
    expect(isAlreadyFunded(s, { spotUsdc: 100, perpMargin: 200 })).toBe(false);
  });
});

describe("planFunding", () => {
  it("plans nothing when there's no shortfall", () => {
    const s = sources({ perp: { withdrawable: 500 } });
    const plan = planFunding({ sources: s, requirement: { perpMargin: 100 } });
    expect(plan.steps).toEqual([]);
    expect(plan.unresolvedPerpMargin).toBe(0);
  });

  it("covers a perp shortfall with idle spot USDC in a single hop", () => {
    const s = sources({ spot: { usdc: 1000, hypeUsd: 0 }, perp: { withdrawable: 0 } });
    const plan = planFunding({ sources: s, requirement: { perpMargin: 400 } });
    expect(plan.steps).toEqual([{ kind: "spotToPerp", amount: 400 }]);
    expect(plan.unresolvedPerpMargin).toBe(0);
  });

  it("covers a perp shortfall from spot HYPE via sell-then-transfer", () => {
    const s = sources({ spot: { usdc: 0, hypeUsd: 500 }, perp: { withdrawable: 0 } });
    const plan = planFunding({ sources: s, requirement: { perpMargin: 300 } });
    expect(plan.steps).toEqual([
      { kind: "sellSpotHype", amountUsd: 300 },
      { kind: "spotToPerp", amount: 300 },
    ]);
  });

  it("reaches all the way to HyperEVM native HYPE for a perp shortfall when nothing closer covers it", () => {
    const s = sources({ hyperEvm: { nativeHypeUsd: 1000, usdc: 0 }, perp: { withdrawable: 0 } });
    const plan = planFunding({ sources: s, requirement: { perpMargin: 250 } });
    expect(plan.steps).toEqual([
      { kind: "hyperEvmToSpot", asset: "HYPE", amountUsd: 250 },
      { kind: "sellSpotHype", amountUsd: 250 },
      { kind: "spotToPerp", amount: 250 },
    ]);
    expect(plan.unresolvedPerpMargin).toBe(0);
  });

  it("covers a spot-USDC shortfall from HyperEVM USDC in a single hop", () => {
    const s = sources({ hyperEvm: { nativeHypeUsd: 0, usdc: 1000 } });
    const plan = planFunding({ sources: s, requirement: { spotUsdc: 400 } });
    expect(plan.steps).toEqual([{ kind: "hyperEvmToSpot", asset: "USDC", amountUsd: 400 }]);
  });

  it("covers a spot-USDC shortfall from HyperEVM HYPE by transferring then selling it", () => {
    const s = sources({ hyperEvm: { nativeHypeUsd: 500, usdc: 0 } });
    const plan = planFunding({ sources: s, requirement: { spotUsdc: 200 } });
    expect(plan.steps).toEqual([
      { kind: "hyperEvmToSpot", asset: "HYPE", amountUsd: 200 },
      { kind: "sellSpotHype", amountUsd: 200 },
    ]);
  });

  it("never double-counts one source across both a spot and a perp requirement in the same call", () => {
    const s = sources({ hyperEvm: { nativeHypeUsd: 0, usdc: 300 } });
    const plan = planFunding({ sources: s, requirement: { spotUsdc: 200, perpMargin: 200 } });
    // Only 300 exists; spot claims 200 of it, leaving 100 for the perp pass — not 200 for each.
    expect(plan.steps).toEqual([
      { kind: "hyperEvmToSpot", asset: "USDC", amountUsd: 200 },
      { kind: "hyperEvmToSpot", asset: "USDC", amountUsd: 100 },
      { kind: "spotToPerp", amount: 100 },
    ]);
    expect(plan.unresolvedSpotUsdc).toBe(0);
    expect(plan.unresolvedPerpMargin).toBe(100);
  });

  it("reports what's still unresolved when nothing anywhere covers the full gap", () => {
    const s = sources({ spot: { usdc: 50, hypeUsd: 0 } });
    const plan = planFunding({ sources: s, requirement: { perpMargin: 500 } });
    expect(plan.unresolvedPerpMargin).toBe(450);
  });

  it("prefers idle spot USDC before touching HyperEVM at all", () => {
    const s = sources({ spot: { usdc: 1000, hypeUsd: 0 }, hyperEvm: { nativeHypeUsd: 1000, usdc: 1000 } });
    const plan = planFunding({ sources: s, requirement: { perpMargin: 100 } });
    expect(plan.steps).toEqual([{ kind: "spotToPerp", amount: 100 }]);
  });
});

describe("sellHopMeetsMinimum", () => {
  it("rejects a sell hop below Hyperliquid's real spot order minimum", () => {
    expect(sellHopMeetsMinimum(5, 10)).toBe(false);
    expect(sellHopMeetsMinimum(10, 10)).toBe(true);
    expect(sellHopMeetsMinimum(15, 10)).toBe(true);
  });
});
