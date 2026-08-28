import type { Chain } from "viem";
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  optimism,
  polygon,
  polygonAmoy,
  sepolia,
} from "viem/chains";
import { network } from "./env.js";
import { HYPEREVM_CHAIN_ID, HYPEREVM_RPC_URL } from "./hyperliquid.js";

// Chain IDs are globally unique, so testnet and mainnet chains coexist in one map —
// the active set for "Send"/balances is chosen per environment below.

/**
 * The HyperEVM chain object other Hyperliquid code needs for a `publicClient`. Registered in the
 * chain maps below (not in SEND_NETWORK_IDS — Send/Balances don't enumerate it) so chain-id-keyed
 * lookups like `CHAIN_NAME_BY_ID` can name it instead of falling back to a bare number.
 */
/** "HyperEVM" on mainnet, "HyperEVM Testnet" otherwise — `HYPEREVM_CHAIN_ID`/`HYPEREVM_RPC_URL` are
 * already env-aware, so this is just the human label kept honest across environments. */
const HYPEREVM_LABEL = network.saltEnv === "mainnet" ? "HyperEVM" : "HyperEVM Testnet";
export const hyperEvmChain: Chain = {
  id: HYPEREVM_CHAIN_ID,
  name: HYPEREVM_LABEL,
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [HYPEREVM_RPC_URL] } },
};
export const CHAIN_BY_ID: Record<string, Chain> = {
  // Testnets
  "11155111": sepolia,
  "421614": arbitrumSepolia,
  "80002": polygonAmoy,
  "84532": baseSepolia,
  // Mainnets
  "1": mainnet,
  "42161": arbitrum,
  "10": optimism,
  "137": polygon,
  "8453": base,
  // HyperEVM
  [String(HYPEREVM_CHAIN_ID)]: hyperEvmChain,
};

export const CHAIN_NAME_BY_ID: Record<string, string> = {
  "11155111": "Sepolia",
  "421614": "Arbitrum Sepolia",
  "80002": "Polygon Amoy",
  "84532": "Base Sepolia",
  "1": "Ethereum",
  "42161": "Arbitrum One",
  "10": "Optimism",
  "137": "Polygon",
  "8453": "Base",
  [String(HYPEREVM_CHAIN_ID)]: HYPEREVM_LABEL,
};

/** The chains "Send"/balances scan, per environment. */
const SEND_NETWORK_IDS_BY_ENV: Record<typeof network.saltEnv, string[]> = {
  testnet: ["11155111", "421614", "80002", "84532"],
  mainnet: ["1", "42161", "10", "137", "8453"],
};

/** Networks "Send" checks for assets on, for the active environment. */
export const SEND_NETWORK_IDS = SEND_NETWORK_IDS_BY_ENV[network.saltEnv];

/**
 * Curated keyless public RPC per chain. viem's built-in defaults mostly work, but
 * some intermittently reject requests — notably Ethereum's default `eth.merkle.io`,
 * which fails outright and silently drops ETH balances on mainnet. We pin known-good
 * `publicnode` endpoints here so the public app is reliable without an API key.
 * Override any chain with env `SALT_RPC_<chainId>` (e.g. `SALT_RPC_1=https://…` for
 * your own node or an Alchemy URL). Falls back to viem's built-in if unmapped.
 */
const DEFAULT_RPC_BY_ID: Record<string, string> = {
  "1": "https://ethereum-rpc.publicnode.com",
  // Arbitrum's publicnode endpoint now gates eth_getTransactionReceipt as a paid
  // "archive" request, which makes a successful send look failed. The official
  // Arbitrum public RPC serves receipts fine.
  "42161": "https://arb1.arbitrum.io/rpc",
  "10": "https://optimism-rpc.publicnode.com",
  "137": "https://polygon-bor-rpc.publicnode.com",
  "8453": "https://base-rpc.publicnode.com",
  "11155111": "https://ethereum-sepolia-rpc.publicnode.com",
  "421614": "https://arbitrum-sepolia-rpc.publicnode.com",
  "80002": "https://polygon-amoy-bor-rpc.publicnode.com",
  "84532": "https://base-sepolia-rpc.publicnode.com",
};

/** Preferred RPC URL for a chain: env override → curated default → viem built-in (undefined). */
export function rpcUrl(chainId: string): string | undefined {
  return process.env[`SALT_RPC_${chainId}`] ?? DEFAULT_RPC_BY_ID[chainId];
}

/**
 * Block-explorer URL for a transaction on the given chain, or `undefined` if
 * the chain has no known explorer. Uses viem's built-in `blockExplorers`, so
 * there's no per-chain URL list to maintain here.
 */
export function explorerTxUrl(chainId: string, txHash: string): string | undefined {
  const explorerBase = CHAIN_BY_ID[chainId]?.blockExplorers?.default?.url;
  return explorerBase ? `${explorerBase}/tx/${txHash}` : undefined;
}
