/**
 * Pure sizing/exposure/funding math for the BTC delta-neutral strategy (long spot, short perp,
 * equal quantity) — no I/O, no CLI dependency. Mirrors hyperliquid-risk.ts's shape (single-purpose
 * pure functions a CLI flow or a future non-interactive caller can both use), but every function
 * here reasons about a *pair* of legs instead of one.
 */

export interface DeltaNeutralAllocationInput {
  capital: number;
  perpLeverage: number;
  spotPrice: number;
  perpMark: number;
  spotSzDecimals: number;
  perpSzDecimals: number;
  /** Reserved off the top for round-trip fees/slippage, in basis points of capital. Default 150 (1.5%) — deliberately not 0, since consuming 100% of capital on the target legs alone leaves nothing for costs. */
  feeBufferBps?: number;
}

export interface DeltaNeutralAllocationResult {
  usableCapital: number;
  spotAllocation: number;
  perpMargin: number;
  spotQty: number;
  perpQty: number;
  spotNotional: number;
  perpNotional: number;
  grossExposure: number;
  targetNetExposure: number;
}

const DEFAULT_FEE_BUFFER_BPS = 150;

const ZERO_ALLOCATION: DeltaNeutralAllocationResult = {
  usableCapital: 0,
  spotAllocation: 0,
  perpMargin: 0,
  spotQty: 0,
  perpQty: 0,
  spotNotional: 0,
  perpNotional: 0,
  grossExposure: 0,
  targetNetExposure: 0,
};

/**
 * Splits `capital` into a spot allocation and a perp margin such that perp notional
 * (`margin * leverage`) matches spot notional by construction — i.e. equal-dollar legs, target net
 * exposure ~0 before rounding. Solving `margin * (leverage + 1) = usableCapital` gives that split
 * directly: `margin = usableCapital / (leverage + 1)`, `spotAllocation = usableCapital - margin`.
 * Both resulting quantities are floored (never rounded up) to their market's size precision, so
 * neither leg can round up past its allocated dollars — same convention Fund Trading uses for USD
 * transfers elsewhere in this app.
 */
export function computeDeltaNeutralAllocation({
  capital,
  perpLeverage,
  spotPrice,
  perpMark,
  spotSzDecimals,
  perpSzDecimals,
  feeBufferBps = DEFAULT_FEE_BUFFER_BPS,
}: DeltaNeutralAllocationInput): DeltaNeutralAllocationResult {
  if (capital <= 0 || perpLeverage <= 0 || spotPrice <= 0 || perpMark <= 0) return ZERO_ALLOCATION;

  const usableCapital = capital * (1 - feeBufferBps / 10_000);
  const perpMargin = usableCapital / (perpLeverage + 1);
  const spotAllocation = usableCapital - perpMargin;

  const spotQty = Math.floor((spotAllocation / spotPrice) * 10 ** spotSzDecimals) / 10 ** spotSzDecimals;
  const perpQty = Math.floor(((perpMargin * perpLeverage) / perpMark) * 10 ** perpSzDecimals) / 10 ** perpSzDecimals;

  const spotNotional = spotQty * spotPrice;
  const perpNotional = perpQty * perpMark;

  return {
    usableCapital,
    spotAllocation,
    perpMargin,
    spotQty,
    perpQty,
    spotNotional,
    perpNotional,
    grossExposure: spotNotional + perpNotional,
    targetNetExposure: spotNotional - perpNotional,
  };
}

export interface NetExposureInput {
  /** BTC quantity long on spot. */
  spotQty: number;
  /** BTC quantity short on perp — pass as a positive magnitude; this function applies the short sign itself. */
  perpQty: number;
  spotPrice: number;
  perpMark: number;
}

export interface NetExposureResult {
  spotExposure: number;
  perpExposure: number;
  grossExposure: number;
  /** `spotExposure - perpExposure` — positive means net long (too much spot relative to the short), negative means net short. */
  netExposure: number;
  /** `|netExposure| / grossExposure`, 0 when gross exposure is 0. */
  imbalancePct: number;
}

export function computeNetExposure({ spotQty, perpQty, spotPrice, perpMark }: NetExposureInput): NetExposureResult {
  const spotExposure = spotQty * spotPrice;
  const perpExposure = perpQty * perpMark;
  const grossExposure = spotExposure + perpExposure;
  const netExposure = spotExposure - perpExposure;
  return {
    spotExposure,
    perpExposure,
    grossExposure,
    netExposure,
    imbalancePct: grossExposure > 0 ? Math.abs(netExposure) / grossExposure : 0,
  };
}

export const UNBALANCED_THRESHOLD_PCT = 0.01;

export function isUnbalanced(imbalancePct: number, threshold = UNBALANCED_THRESHOLD_PCT): boolean {
  return imbalancePct > threshold;
}

export interface FundingSufficiencyInput {
  /** Current hourly funding rate as a decimal fraction — see {@link "./hyperliquid.js".AssetCtx.funding}'s sign-convention caveat. */
  fundingRatePerHour: number;
  perpNotional: number;
  /** Total of estimated entry + exit fees and slippage, both legs. */
  roundTripCostEstimate: number;
  horizonHours?: number;
}

export interface FundingSufficiencyResult {
  estimatedFundingIncome: number;
  netOfCosts: number;
  sufficient: boolean;
}

export const DEFAULT_FUNDING_HORIZON_HOURS = 24;

/**
 * Conservative funding income over a fixed horizon vs. total round-trip cost — drives the
 * pre-trade warning when funding looks non-positive or insufficient. Funding is inherently
 * variable; this is a snapshot estimate at the current rate, never a guarantee, and callers must
 * present it that way (per product requirement: never show funding APR as guaranteed).
 */
export function estimateFundingSufficiency({
  fundingRatePerHour,
  perpNotional,
  roundTripCostEstimate,
  horizonHours = DEFAULT_FUNDING_HORIZON_HOURS,
}: FundingSufficiencyInput): FundingSufficiencyResult {
  const estimatedFundingIncome = fundingRatePerHour * perpNotional * horizonHours;
  const netOfCosts = estimatedFundingIncome - roundTripCostEstimate;
  return { estimatedFundingIncome, netOfCosts, sufficient: fundingRatePerHour > 0 && netOfCosts > 0 };
}
