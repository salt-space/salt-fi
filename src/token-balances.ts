import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { CHAIN_BY_ID } from "./chains.js";
import { KNOWN_TOKENS_BY_CHAIN } from "./uniswap.js";

const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Replacement for the SDK's removed `TokenBalance` type. `balance` is
 * decimal-adjusted (human-readable); {@link RawTokenBalance} carries it as a
 * bigint in the token's smallest unit.
 */
export interface TokenBalance {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;
  price: number;
  chainId: string;
}
export type RawTokenBalance = Omit<TokenBalance, "balance"> & { balance: bigint };

export interface FetchTokensOptions {
  /** Chain IDs to read balances on (e.g. SEND_NETWORK_IDS). */
  networks: string[];
  /** When true, `balance` is a raw bigint; otherwise a decimal-adjusted string. */
  raw?: boolean;
}

/**
 * External balance provider — replaces `salt.getAccountTokens`, which was
 * removed in salt-sdk 0.0.35 (Salt's direction: token balances come from
 * external providers, not the SDK). Reads the account's native balance plus its
 * curated ERC-20 balances directly on-chain via viem, in the same shape the old
 * SDK call returned, so the Balances / Send / Swap flows are unchanged.
 *
 * `price` is always 0 — viem has no fiat feed, the UI already treats a
 * non-positive price as "unpriced" (hides fiat), and testnet prices were
 * unreliable anyway. Wire a price source in here if real fiat is ever needed.
 *
 * Per-chain and per-token reads are isolated: an unreachable RPC or a failing
 * token contract is skipped rather than failing the whole fetch.
 */
export function fetchAccountTokens(
  address: string,
  options: FetchTokensOptions & { raw: true },
): Promise<RawTokenBalance[]>;
export function fetchAccountTokens(
  address: string,
  options: FetchTokensOptions & { raw?: false },
): Promise<TokenBalance[]>;
export async function fetchAccountTokens(
  address: string,
  { networks, raw = false }: FetchTokensOptions,
): Promise<(TokenBalance | RawTokenBalance)[]> {
  const account = address as Address;
  const out: (TokenBalance | RawTokenBalance)[] = [];

  const entry = (addr: string, symbol: string, name: string, decimals: number, bal: bigint, chainId: string) =>
    ({
      address: addr,
      symbol,
      name,
      decimals,
      price: 0,
      chainId,
      balance: raw ? bal : formatUnits(bal, decimals),
    }) as TokenBalance | RawTokenBalance;

  for (const chainId of networks) {
    const chain = CHAIN_BY_ID[chainId];
    if (!chain) continue;
    const client = createPublicClient({ chain, transport: http() });
    try {
      const nativeBal = await client.getBalance({ address: account });
      const nc = chain.nativeCurrency;
      out.push(entry(NATIVE_ADDRESS, nc.symbol, nc.name, nc.decimals, nativeBal, chainId));

      for (const t of KNOWN_TOKENS_BY_CHAIN[chainId] ?? []) {
        try {
          const [bal, decimals] = await Promise.all([
            client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
            client.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" }),
          ]);
          out.push(entry(t.address, t.symbol, t.symbol, Number(decimals), bal, chainId));
        } catch {
          /* skip a token whose contract read fails */
        }
      }
    } catch {
      /* skip a chain whose RPC is unreachable */
    }
  }
  return out;
}
