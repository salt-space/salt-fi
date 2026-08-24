import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { CHAIN_NAME_BY_ID, SEND_NETWORK_IDS } from "../chains.js";
import { reportError } from "../errors.js";
import { pickOrganisation, select } from "../prompts.js";
import { fetchAccountTokens, type TokenBalance } from "../token-balances.js";

const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A token's fiat value, or null when there's no usable price (testnet prices are often 0/bogus). */
function fiatValue(token: TokenBalance): number | null {
  const price = Number(token.price);
  const amount = Number(token.balance);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount)) return null;
  return price * amount;
}

/** Trim a decimal-adjusted balance string to something readable, with thousands separators. */
function formatAmount(balance: string): string {
  const n = Number(balance);
  if (!Number.isFinite(n)) return balance;
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatUsd(value: number): string {
  return `~$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Render an account's non-zero token balances, grouped by chain, into a single
 * note body. Chains are listed in `SEND_NETWORK_IDS` order; within a chain,
 * native currency first then by descending fiat value (unpriced tokens last).
 */
function renderBalances(tokens: TokenBalance[]): { body: string; total: number; anyPriced: boolean } {
  const lines: string[] = [];
  let total = 0;
  let anyPriced = false;

  // Column widths so symbol/amount align across every chain group.
  const symbolWidth = Math.max(...tokens.map((t) => t.symbol.length), 6);
  const amountWidth = Math.max(...tokens.map((t) => formatAmount(t.balance).length), 8);

  const chainIds = SEND_NETWORK_IDS.filter((id) => tokens.some((t) => t.chainId === id));
  for (const chainId of chainIds) {
    const onChain = tokens
      .filter((t) => t.chainId === chainId)
      .sort((a, b) => {
        const aNative = a.address.toLowerCase() === NATIVE_ADDRESS;
        const bNative = b.address.toLowerCase() === NATIVE_ADDRESS;
        if (aNative !== bNative) return aNative ? -1 : 1;
        return (fiatValue(b) ?? 0) - (fiatValue(a) ?? 0);
      });

    lines.push(CHAIN_NAME_BY_ID[chainId] ?? chainId);
    for (const token of onChain) {
      const value = fiatValue(token);
      if (value !== null) {
        total += value;
        anyPriced = true;
      }
      const symbol = token.symbol.padEnd(symbolWidth);
      const amount = formatAmount(token.balance).padStart(amountWidth);
      lines.push(`  ${symbol}  ${amount}${value !== null ? `  ${formatUsd(value)}` : ""}`);
    }
  }

  return { body: lines.join("\n"), total, anyPriced };
}

export async function accountBalancesFlow(salt: Salt): Promise<void> {
  const organisationId = await pickOrganisation(salt, "View balances in which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return;
  }

  // Only fully-set-up accounts have an on-chain address to hold a balance.
  const usableAccounts = accounts.filter((account) => Boolean(account.evmAddress));
  if (usableAccounts.length === 0) {
    p.log.info("No fully-set-up accounts in this organisation to show balances for.");
    return;
  }

  const accountId = await select({
    message: "View balances for which account?",
    options: usableAccounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: account.evmAddress,
    })),
  });
  if (p.isCancel(accountId)) return;
  const account = usableAccounts.find((a) => a.id === accountId);
  if (!account?.evmAddress) return;

  const s = p.spinner();
  s.start("Fetching balances");
  // Chains whose RPC read failed contribute no tokens; collect them so we can
  // warn instead of silently omitting them (an unreadable chain looks identical
  // to an empty one otherwise).
  const failedChains: string[] = [];
  let tokens: TokenBalance[];
  try {
    tokens = await fetchAccountTokens(account.evmAddress, {
      networks: SEND_NETWORK_IDS,
      onChainError: (chainId) => failedChains.push(chainId),
    });
    s.stop("Balances fetched");
  } catch (err) {
    s.stop("Failed to fetch balances");
    reportError(err);
    return;
  }

  if (failedChains.length > 0) {
    const names = failedChains.map((id) => CHAIN_NAME_BY_ID[id] ?? id).join(", ");
    p.log.warn(
      `Couldn't read ${names} (RPC error or timeout) — any balance there is NOT shown below.\n` +
        `Point that chain at a reliable RPC with SALT_RPC_<chainId>, or raise SALT_BALANCE_TIMEOUT_MS.`,
    );
  }

  const held = tokens.filter((token) => Number(token.balance) > 0);
  if (held.length === 0) {
    const readable = SEND_NETWORK_IDS.filter((id) => !failedChains.includes(id)).map(
      (id) => CHAIN_NAME_BY_ID[id] ?? id,
    );
    p.log.info(
      readable.length > 0
        ? `${account?.name} holds no balances across ${readable.join(", ")}.`
        : `Couldn't read any chain for ${account?.name} — no balances to show.`,
    );
    return;
  }

  const { body, total, anyPriced } = renderBalances(held);
  const totalText = total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const footer = anyPriced ? `\n\nTotal ≈ $${totalText}` : "";
  p.note(`${body}${footer}`, `${account?.name}  •  ${account?.evmAddress}`);
}
