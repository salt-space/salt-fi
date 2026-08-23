import { type Address, encodeFunctionData, type PublicClient, parseAbi } from "viem";

/** Uniswap v3 deployment for a chain. Addresses verified on-chain before adding a chain here. */
export interface UniswapV3Deployment {
  factory: Address;
  swapRouter02: Address;
  quoterV2: Address;
  weth: Address;
}

// Sepolia (11155111) — verified on-chain (contracts have bytecode; WETH/USDC
// pools have liquidity across all three fee tiers). Add more chains only after
// the same check; mainnet + other testnets are in Uniswap's deployment docs.
export const UNISWAP_V3_BY_CHAIN: Record<string, UniswapV3Deployment> = {
  "11155111": {
    factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    weth: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
  },
  // Mainnets — verified on-chain (factory/router/quoter have bytecode; the
  // canonical WETH/USDC pool exists across all three fee tiers). Ethereum,
  // Arbitrum, Optimism and Polygon share Uniswap's universal deployment
  // addresses; Base has its own. `weth` is each chain's wrapped native.
  "1": {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  "42161": {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
  "10": {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    weth: "0x4200000000000000000000000000000000000006",
  },
  "137": {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    // Wrapped native POL (symbol WPOL — formerly WMATIC).
    weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  },
  "8453": {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    weth: "0x4200000000000000000000000000000000000006",
  },
};

/** Standard Uniswap v3 fee tiers, in hundredths of a bip (500 = 0.05%). */
export const FEE_TIERS = [500, 3000, 10000] as const;

/** Curated buy-side tokens per chain — a shortcut so the common path is a pick, not an address paste. */
export const KNOWN_TOKENS_BY_CHAIN: Record<string, { symbol: string; address: Address }[]> = {
  "11155111": [
    { symbol: "WETH", address: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" },
    { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  ],
  // Mainnets — wrapped native + canonical/native USDC, both verified on-chain
  // (symbol + a live WETH/USDC pool). Extend per chain as needed.
  "1": [
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  ],
  "42161": [
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" },
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  ],
  "10": [
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
    { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  ],
  "137": [
    { symbol: "WPOL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  ],
  "8453": [
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  ],
};

const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// SwapRouter02's ExactInputSingleParams has no `deadline` field (unlike v1's SwapRouter).
const SWAP_ROUTER_02_ABI = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export interface FeeQuote {
  fee: number;
  amountOut: bigint;
}

/**
 * Quote `amountIn` of `tokenIn` -> `tokenOut` across all fee tiers via QuoterV2
 * and return the tier with the best output. `quoteExactInputSingle` is
 * nonpayable but callable through `eth_call`, so we drive it with
 * `simulateContract`. Tiers without a pool/liquidity revert and are skipped.
 * Returns `undefined` if no tier can be quoted.
 */
export async function quoteBestFee(
  publicClient: PublicClient,
  quoterV2: Address,
  params: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
): Promise<FeeQuote | undefined> {
  let best: FeeQuote | undefined;
  for (const fee of FEE_TIERS) {
    try {
      const { result } = await publicClient.simulateContract({
        address: quoterV2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
      const amountOut = result[0];
      if (amountOut > 0n && (best === undefined || amountOut > best.amountOut)) {
        best = { fee, amountOut };
      }
    } catch {
      // No pool at this fee tier, or no liquidity — skip it.
    }
  }
  return best;
}

export function encodeApprove(spender: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] });
}

export function encodeExactInputSingle(params: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): `0x${string}` {
  return encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "exactInputSingle",
    args: [{ ...params, sqrtPriceLimitX96: 0n }],
  });
}
