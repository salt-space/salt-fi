import { describe, expect, it } from "vitest";
import {
  computeDeltaNeutralAllocation,
  computeNetExposure,
  estimateFundingSufficiency,
  isUnbalanced,
} from "../src/delta-neutral-math.js";

describe("computeDeltaNeutralAllocation", () => {
  it("matches the spec's worked example with no fee buffer", () => {
    const result = computeDeltaNeutralAllocation({
      capital: 5000,
      perpLeverage: 4,
      spotPrice: 1,
      perpMark: 1,
      spotSzDecimals: 8,
      perpSzDecimals: 8,
      feeBufferBps: 0,
    });
    expect(result.spotAllocation).toBeCloseTo(4000, 6);
    expect(result.perpMargin).toBeCloseTo(1000, 6);
    expect(result.spotNotional).toBeCloseTo(4000, 6);
    expect(result.perpNotional).toBeCloseTo(4000, 6);
    expect(result.grossExposure).toBeCloseTo(8000, 6);
    expect(result.targetNetExposure).toBeCloseTo(0, 6);
  });

  it("reserves a fee buffer by default, using less than the full capital", () => {
    const result = computeDeltaNeutralAllocation({
      capital: 5000,
      perpLeverage: 4,
      spotPrice: 1,
      perpMark: 1,
      spotSzDecimals: 8,
      perpSzDecimals: 8,
    });
    expect(result.usableCapital).toBeLessThan(5000);
    expect(result.spotAllocation + result.perpMargin).toBeCloseTo(result.usableCapital, 6);
  });

  it("floors quantities to size precision instead of rounding up", () => {
    const result = computeDeltaNeutralAllocation({
      capital: 100,
      perpLeverage: 2,
      spotPrice: 3,
      perpMark: 3,
      spotSzDecimals: 0,
      perpSzDecimals: 0,
      feeBufferBps: 0,
    });
    // spotAllocation = 100/3 = 33.33..., spotQty at 0 decimals must floor to 11, never round to 33/3=11.11 -> 12
    expect(result.spotQty).toBeLessThanOrEqual(Math.floor(result.spotAllocation / 3));
    expect(Number.isInteger(result.spotQty)).toBe(true);
  });

  it("returns an all-zero result for non-positive inputs rather than NaN/negative sizes", () => {
    const result = computeDeltaNeutralAllocation({
      capital: 0,
      perpLeverage: 4,
      spotPrice: 1,
      perpMark: 1,
      spotSzDecimals: 8,
      perpSzDecimals: 8,
    });
    expect(result.spotQty).toBe(0);
    expect(result.perpQty).toBe(0);
  });
});

describe("computeNetExposure", () => {
  it("is ~0% imbalance for equal spot/perp quantities at equal prices", () => {
    const result = computeNetExposure({ spotQty: 1, perpQty: 1, spotPrice: 100, perpMark: 100 });
    expect(result.netExposure).toBeCloseTo(0, 8);
    expect(result.imbalancePct).toBeCloseTo(0, 8);
  });

  it("flags imbalance when spot outweighs the perp short", () => {
    const result = computeNetExposure({ spotQty: 0.0412, perpQty: 0.0398, spotPrice: 100_000, perpMark: 100_000 });
    expect(result.netExposure).toBeGreaterThan(0);
    expect(isUnbalanced(result.imbalancePct)).toBe(true);
  });

  it("stays within the 1% threshold for a near-matched pair", () => {
    const result = computeNetExposure({ spotQty: 0.0412, perpQty: 0.0411, spotPrice: 100_000, perpMark: 100_000 });
    expect(isUnbalanced(result.imbalancePct)).toBe(false);
  });

  it("returns 0 imbalance rather than dividing by zero when gross exposure is 0", () => {
    const result = computeNetExposure({ spotQty: 0, perpQty: 0, spotPrice: 100, perpMark: 100 });
    expect(result.imbalancePct).toBe(0);
  });
});

describe("estimateFundingSufficiency", () => {
  it("is insufficient when the funding rate is non-positive", () => {
    const result = estimateFundingSufficiency({ fundingRatePerHour: -0.0001, perpNotional: 4000, roundTripCostEstimate: 10 });
    expect(result.sufficient).toBe(false);
  });

  it("is insufficient when funding income over the horizon doesn't clear round-trip costs", () => {
    const result = estimateFundingSufficiency({ fundingRatePerHour: 0.0000001, perpNotional: 4000, roundTripCostEstimate: 50 });
    expect(result.netOfCosts).toBeLessThan(0);
    expect(result.sufficient).toBe(false);
  });

  it("is sufficient when funding income over the horizon clearly covers round-trip costs", () => {
    const result = estimateFundingSufficiency({ fundingRatePerHour: 0.0001, perpNotional: 4000, roundTripCostEstimate: 5 });
    expect(result.estimatedFundingIncome).toBeGreaterThan(5);
    expect(result.sufficient).toBe(true);
  });
});
