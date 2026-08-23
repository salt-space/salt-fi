/**
 * Pure trading/risk calculations for Hyperliquid perp orders — margin validation, leverage
 * presets, order sizing, account impact, and liquidation estimation. No CLI/prompt dependency:
 * commands/hyperliquid.ts's interactive Trade flow calls these, but so could a non-interactive
 * strategy submitting order intents directly, without going through any CLI prompt.
 */

export interface MarginValidationInput {
  margin: number;
  availableMargin: number;
}

/** Returns a validation error message, or `undefined` if `margin` is usable. */
export function validateMargin({ margin, availableMargin }: MarginValidationInput): string | undefined {
  if (!Number.isFinite(margin) || margin <= 0) return "Enter a positive amount";
  if (margin > availableMargin) return `Exceeds available margin ($${availableMargin.toFixed(2)})`;
  return undefined;
}

/** Returns a validation error message, or `undefined` if `leverage` is usable for this market. */
export function validateLeverage(leverage: number, maxLeverage: number): string | undefined {
  if (!Number.isFinite(leverage) || leverage <= 0) return "Leverage must be positive";
  if (leverage > maxLeverage) return `Exceeds this market's max leverage (${maxLeverage}x)`;
  return undefined;
}

/**
 * "Nice number" leverage presets, matching the buttons a trading UI would show — capped at and
 * deduped against the market's actual max leverage, which is always included so the true ceiling
 * stays reachable even when it doesn't land on a preset value (e.g. a 15x-max market).
 */
const LEVERAGE_PRESETS = [1, 2, 3, 5, 10, 20, 25, 50, 100];

export function computeLeverageOptions(maxLeverage: number): number[] {
  const options = LEVERAGE_PRESETS.filter((l) => l <= maxLeverage);
  if (options[options.length - 1] !== maxLeverage) options.push(maxLeverage);
  return options;
}

export interface OrderSizingInput {
  margin: number;
  leverage: number;
  /** The price sizing is based on: a limit order's own price, or the current mark for a market order. */
  executionPrice: number;
  szDecimals: number;
}

export interface OrderSizingResult {
  notional: number;
  /** Normalized to the market's szDecimals, matching what buildLimitOrderAction/floatToWire expects. */
  size: number;
}

export function computeOrderSizing({ margin, leverage, executionPrice, szDecimals }: OrderSizingInput): OrderSizingResult {
  const notional = margin * leverage;
  const size = Number((notional / executionPrice).toFixed(szDecimals));
  return { notional, size };
}

export interface AccountImpactInput {
  availableMargin: number;
  thisTradeMargin: number;
}

export interface AccountImpactResult {
  remainingMargin: number;
}

export function computeAccountImpact({ availableMargin, thisTradeMargin }: AccountImpactInput): AccountImpactResult {
  return { remainingMargin: availableMargin - thisTradeMargin };
}

export interface LiquidationPriceInput {
  entryPrice: number;
  isBuy: boolean;
  margin: number;
  size: number;
  maxLeverage: number;
}

/**
 * Isolated-margin liquidation price estimate. Formula and the maintenance-margin-rate
 * relationship (`1/(2*maxLeverage)`) are Hyperliquid's own, confirmed against their docs
 * (hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations): the docs' stated range —
 * 1.25% maintenance at 40x max leverage, 16.7% at 3x — matches `1/(2*maxLeverage)` exactly at
 * both ends, so this isn't a guessed approximation. Reliable for the base margin tier (typical
 * position sizes); Hyperliquid's tiered margin table for very large positions (max leverage steps
 * down at higher notional) isn't accounted for, so this can be optimistic for outsized positions.
 * Returns `undefined` for degenerate inputs (including a position that would already be under
 * maintenance margin at entry) rather than surface a number that isn't a real estimate.
 */
export function estimateIsolatedLiquidationPrice({ entryPrice, isBuy, margin, size, maxLeverage }: LiquidationPriceInput): number | undefined {
  if (size <= 0 || entryPrice <= 0 || maxLeverage <= 0) return undefined;
  const side = isBuy ? 1 : -1;
  const maintenanceMarginRate = 1 / (2 * maxLeverage);
  const maintenanceMarginRequired = size * entryPrice * maintenanceMarginRate;
  const marginAvailable = margin - maintenanceMarginRequired;
  const denominator = 1 - maintenanceMarginRate * side;
  if (denominator === 0) return undefined;
  const liqPrice = entryPrice - (side * marginAvailable) / size / denominator;
  return liqPrice > 0 ? liqPrice : undefined;
}
