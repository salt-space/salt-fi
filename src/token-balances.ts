import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { CHAIN_BY_ID, rpcUrl } from "./chains.js";
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

/**
 * Format a raw balance as a human-readable amount, with its USD value in
 * brackets when a positive price is known — e.g. `0.005  (~$12.39)`. Used for
 * the asset-picker hints in the Send / Swap / Bridge flows. Falls back to just
 * the amount when unpriced.
 */
export function formatBalanceHint(balance: bigint, decimals: number, priceUsd?: number): string {
  const amount = formatUnits(balance, decimals);
  if (!priceUsd || priceUsd <= 0) return amount;
  const value = priceUsd * Number(amount);
  return `${amount}  (~$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
}

export interface FetchTokensOptions {
  /** Chain IDs to read balances on (e.g. SEND_NETWORK_IDS). */
  networks: string[];
  /** When true, `balance` is a raw bigint; otherwise a decimal-adjusted string. */
  raw?: boolean;
  /**
   * Called once per chain whose balance read fails (unreachable/slow/rate-limited
   * RPC). Such a chain contributes no tokens, so without this the caller can't
   * tell "no funds here" from "couldn't read here". Lets a UI surface a warning
   * rather than silently dropping the chain.
   */
  onChainError?: (chainId: string, err: unknown) => void;
}

// --- Alchemy auto-discovery (any held ERC-20, not just the curated list) -----------

/** Alchemy per-chain subdomains for the chains the app enumerates. */
const ALCHEMY_SUBDOMAIN: Record<string, string> = {
  "1": "eth-mainnet",
  "42161": "arb-mainnet",
  "10": "opt-mainnet",
  "137": "polygon-mainnet",
  "8453": "base-mainnet",
  "11155111": "eth-sepolia",
  "421614": "arb-sepolia",
  "80002": "polygon-amoy",
  "84532": "base-sepolia",
};

/**
 * An Alchemy JSON-RPC URL for `chainId` if one is available — built from a standalone
 * `ALCHEMY_API_KEY`, or reused directly from `SALT_RPC_<chainId>` when that's already an Alchemy
 * endpoint. Returns undefined otherwise (→ the curated-list path).
 */
function alchemyUrlFor(chainId: string): string | undefined {
  const key = process.env.ALCHEMY_API_KEY;
  if (key && ALCHEMY_SUBDOMAIN[chainId]) return `https://${ALCHEMY_SUBDOMAIN[chainId]}.g.alchemy.com/v2/${key}`;
  const url = rpcUrl(chainId);
  return url && url.includes(".g.alchemy.com") ? url : undefined;
}

interface DiscoveredToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
}

async function alchemyRpc<T>(url: string, method: string, params: unknown[], timeout: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "alchemy rpc error");
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every ERC-20 the account holds a non-zero balance of on this chain, with metadata, via Alchemy's
 * `alchemy_getTokenBalances` + `alchemy_getTokenMetadata`. Skips zero balances and tokens without
 * usable metadata (filters most airdrop spam), capped at 100. Throws if the endpoint doesn't
 * support the methods (e.g. the chain isn't enabled on the Alchemy app) so the caller can fall back.
 */
async function discoverTokensViaAlchemy(url: string, account: Address, timeout: number): Promise<DiscoveredToken[]> {
  const balances = await alchemyRpc<{ tokenBalances: { contractAddress: Address; tokenBalance: string | null }[] }>(
    url,
    "alchemy_getTokenBalances",
    [account, "erc20"],
    timeout,
  );
  const held = (balances.tokenBalances ?? []).filter((t) => t.tokenBalance && BigInt(t.tokenBalance) > 0n).slice(0, 100);
  const out = await Promise.all(
    held.map(async (t): Promise<DiscoveredToken | null> => {
      try {
        const meta = await alchemyRpc<{ symbol?: string; name?: string; decimals?: number }>(
          url,
          "alchemy_getTokenMetadata",
          [t.contractAddress],
          timeout,
        );
        if (!meta.symbol || meta.decimals == null) return null;
        return {
          address: t.contractAddress,
          symbol: meta.symbol,
          name: meta.name ?? meta.symbol,
          decimals: meta.decimals,
          balance: BigInt(t.tokenBalance as string),
        };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((x): x is DiscoveredToken => x !== null);
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
  { networks, raw = false, onChainError }: FetchTokensOptions,
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

  // Read every chain CONCURRENTLY with a short per-request timeout + a single retry,
  // so one slow/rate-limited public RPC can't stall the whole fetch — it just gets
  // skipped. Previously this ran sequentially on viem's default public RPCs with no
  // timeout and 3 retries, so a couple of slow chains looked like a hang (worst on
  // mainnet — 5 chains). Override the timeout with SALT_BALANCE_TIMEOUT_MS.
  const timeout = Number(process.env.SALT_BALANCE_TIMEOUT_MS ?? 6000);

  const perChain = await Promise.all(
    networks.map(async (chainId): Promise<(TokenBalance | RawTokenBalance)[]> => {
      const chain = CHAIN_BY_ID[chainId];
      if (!chain) return [];
      const client = createPublicClient({ chain, transport: http(rpcUrl(chainId), { timeout, retryCount: 1 }) });
      const chainOut: (TokenBalance | RawTokenBalance)[] = [];
      try {
        const nativeBal = await client.getBalance({ address: account });
        const nc = chain.nativeCurrency;
        chainOut.push(entry(NATIVE_ADDRESS, nc.symbol, nc.name, nc.decimals, nativeBal, chainId));

        // Auto-discover held ERC-20s via Alchemy when an Alchemy endpoint is available for this
        // chain — so ANY token the account holds shows up, not just the curated shortlist. Falls
        // back to the curated list when Alchemy isn't configured or the chain isn't enabled on it.
        const alchemy = alchemyUrlFor(chainId);
        if (alchemy) {
          try {
            for (const d of await discoverTokensViaAlchemy(alchemy, account, timeout)) {
              chainOut.push(entry(d.address, d.symbol, d.name, d.decimals, d.balance, chainId));
            }
            return chainOut;
          } catch {
            // Alchemy method unsupported / chain not enabled on the app — fall through to curated.
          }
        }

        const reads = (KNOWN_TOKENS_BY_CHAIN[chainId] ?? []).map(async (t) => {
          try {
            const [bal, decimals] = await Promise.all([
              client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
              client.readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" }),
            ]);
            return entry(t.address, t.symbol, t.symbol, Number(decimals), bal, chainId);
          } catch {
            return null; // skip a token whose contract read fails
          }
        });
        for (const r of await Promise.all(reads)) if (r) chainOut.push(r);
      } catch (err) {
        // The chain's RPC is unreachable or timed out: it contributes no tokens.
        // Report it so the caller can distinguish this from a genuinely empty
        // chain, rather than silently dropping it.
        onChainError?.(chainId, err);
      }
      return chainOut;
    }),
  );
  for (const c of perChain) out.push(...c);
  return out;
}
