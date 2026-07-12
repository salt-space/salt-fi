import type { Chain } from "viem";
import { arbitrumSepolia, baseSepolia, polygonAmoy, sepolia } from "viem/chains";

/** Testnets "Send" checks for assets on — overrides getAccountTokens' own 2-chain default. */
export const SEND_NETWORK_IDS = ["11155111", "421614", "80002", "84532"];

export const CHAIN_BY_ID: Record<string, Chain> = {
  "11155111": sepolia,
  "421614": arbitrumSepolia,
  "80002": polygonAmoy,
  "84532": baseSepolia,
};

export const CHAIN_NAME_BY_ID: Record<string, string> = {
  "11155111": "Sepolia",
  "421614": "Arbitrum Sepolia",
  "80002": "Polygon Amoy",
  "84532": "Base Sepolia",
};
