import { decodeFunctionData, erc20Abi, formatEther, formatUnits, type Hex } from "viem";
import type {
  ContractParamRestriction,
  LimitEntry,
  Policy,
  PolicyType,
  RecipientEntry,
  Salt,
  TransactionObjectParams,
} from "salt-sdk";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID } from "./chains.js";
import { describeRestriction, evaluateRestriction } from "./contract-restrictions.js";
import { LIFI_DIAMOND } from "./lifi.js";
import { PERMIT2_ADDRESS } from "./turbine.js";
import { KNOWN_TOKENS_BY_CHAIN, UNISWAP_V3_BY_CHAIN } from "./uniswap.js";

export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Fixed gas limit used only to satisfy runPoliciesCheck's required payload shape (see below). */
const POLICY_CHECK_GAS_LIMIT = "500000";

type GasFields = Pick<TransactionObjectParams, "gas" | "maxFeePerGas" | "maxPriorityFeePerGas">;

/**
 * Gas/fee fields for a {@link Salt.runPoliciesCheck} payload.
 *
 * salt-sdk 0.0.42 made `gas` / `maxFeePerGas` / `maxPriorityFeePerGas` (decimal-string wei)
 * REQUIRED on `TransactionObjectParams` — including the read-only policy pre-flight, which
 * evaluates policies but never signs or submits. Our policies are recipient / transaction-limit
 * based and don't evaluate gas, so the check's outcome doesn't depend on these values; we fill
 * the fees from the live network price (`salt.getGasPrice`) and a generous fixed gas limit.
 *
 * Best-effort: if the fee read fails the check still runs (a zero fee is a valid EIP-1559 value,
 * and this is advisory — not the transaction that eventually gets signed).
 */
export async function policyCheckGasFields(salt: Salt, chainId: number): Promise<GasFields> {
  try {
    const g = await salt.getGasPrice(chainId);
    return {
      gas: POLICY_CHECK_GAS_LIMIT,
      maxFeePerGas: g.maxFeePerGas.toString(),
      maxPriorityFeePerGas: g.maxPriorityFeePerGas.toString(),
    };
  } catch {
    return { gas: POLICY_CHECK_GAS_LIMIT, maxFeePerGas: "0", maxPriorityFeePerGas: "0" };
  }
}

/** A proposed transaction, as the policy engine evaluates it. */
export interface PolicyCall {
  /** Chain ID, as a string. */
  chainId: string;
  to: string;
  /** Native value in wei. */
  value: bigint;
  data: string;
}

/**
 * The {@link Salt.runPoliciesCheck} payload for a call, filled the way `submitTx`
 * fills the transaction record it creates — so a pre-flight evaluates exactly
 * what the Robo Guardians will. Two fields are easy to get wrong:
 * - `from` is the Salt account's own address, not the signer's.
 * - `amount` is the call's native value. Native per-transaction limits read it,
 *   so a zero here hides them.
 */
export function policyCheckParams(call: PolicyCall, from: string, nonce: number, gas: GasFields): TransactionObjectParams {
  return { nonce, amount: call.value.toString(), from, to: call.to, network: call.chainId, data: call.data, ...gas };
}

/** Fallback name lookup for addresses with no nickname stored on the policy itself. */
export type ResolveLabel = (address: string) => string | undefined;

/**
 * Builds a fallback label lookup for policy addresses: an unlabeled whitelist
 * entry is often another account in the org, or a collaborator's own signing
 * address, so show the name rather than a bare hex string.
 */
export function buildResolveLabel(
  accounts: { evmAddress?: string; name: string }[],
  members: { address: string; name?: string | null }[],
): ResolveLabel {
  const byAddress = new Map<string, string>();
  for (const account of accounts) if (account.evmAddress) byAddress.set(account.evmAddress.toLowerCase(), account.name);
  for (const member of members) if (member.name) byAddress.set(member.address.toLowerCase(), member.name);
  return (address) => byAddress.get(address.toLowerCase());
}

/**
 * Names for addresses this app itself works with — its curated tokens, and the
 * contracts its swap, bridge and Turbine flows approve — so a policy reads
 * "USDC" rather than a bare hex string. `chain` narrows the lookup to one
 * chain; `"*"` searches them all.
 */
export function knownAddressLabel(address: string, chain = "*"): string | undefined {
  const a = address.toLowerCase();
  if (a === LIFI_DIAMOND.toLowerCase()) return "LI.FI Diamond";
  if (a === PERMIT2_ADDRESS.toLowerCase()) return "Permit2";
  const chains = chain === "*" ? [...new Set([...Object.keys(KNOWN_TOKENS_BY_CHAIN), ...Object.keys(UNISWAP_V3_BY_CHAIN)])] : [chain];
  for (const id of chains) {
    const token = KNOWN_TOKENS_BY_CHAIN[id]?.find((t) => t.address.toLowerCase() === a);
    if (token) return token.symbol;
    if (UNISWAP_V3_BY_CHAIN[id]?.swapRouter02.toLowerCase() === a) return "Uniswap SwapRouter02";
  }
  return undefined;
}

/** Org names first (accounts, collaborators), then addresses the app knows. */
function labeller(chain: string, resolveLabel?: ResolveLabel): ResolveLabel {
  return (address) => resolveLabel?.(address) ?? knownAddressLabel(address, chain);
}

export const POLICY_TYPE_LABEL: Record<PolicyType, string> = {
  allowed_recipients: "Allowed recipients (whitelist)",
  denied_recipients: "Denied recipients (blocklist)",
  denied_proposers: "Denied proposers",
  transaction_limit_token_denominated: "Per-transaction limit",
  contract_param_restriction: "Contract call restriction",
  nominated_approvers: "Nominated approvers",
};

/** Policy types this app can create (nominated_approvers is not creatable in Salt). */
export const CREATABLE_POLICY_TYPES: { value: Exclude<PolicyType, "nominated_approvers">; label: string; hint: string }[] = [
  { value: "allowed_recipients", label: POLICY_TYPE_LABEL.allowed_recipients, hint: "only these addresses may receive funds" },
  { value: "denied_recipients", label: POLICY_TYPE_LABEL.denied_recipients, hint: "these addresses may not receive funds" },
  { value: "denied_proposers", label: POLICY_TYPE_LABEL.denied_proposers, hint: "these signers may not initiate transfers" },
  {
    value: "transaction_limit_token_denominated",
    label: POLICY_TYPE_LABEL.transaction_limit_token_denominated,
    hint: "cap the size of a single transfer, per token",
  },
  {
    value: "contract_param_restriction",
    label: POLICY_TYPE_LABEL.contract_param_restriction,
    hint: "restrict arguments of a contract call",
  },
];

/** Types whose params are a `{ recipients: [...] }` array. */
export const RECIPIENT_TYPES: PolicyType[] = ["allowed_recipients", "denied_recipients", "denied_proposers"];

export function policyChainOptions(): { value: string; label: string }[] {
  return [
    { value: "*", label: "All chains (*)" },
    ...Object.entries(CHAIN_NAME_BY_ID).map(([id, name]) => ({ value: id, label: `${name} (${id})` })),
  ];
}

export function chainLabel(chain: string): string {
  if (chain === "*") return "all chains";
  return CHAIN_NAME_BY_ID[chain] ? `${CHAIN_NAME_BY_ID[chain]} (${chain})` : chain;
}

/** `Per-transaction limit · Arbitrum One (42161)` — a policy in one line, without its entries. */
export function policyHeadline(policy: Pick<Policy, "type" | "chain">): string {
  return `${POLICY_TYPE_LABEL[policy.type] ?? policy.type} · ${chainLabel(policy.chain)}`;
}

/** The params member holding a policy's entries — `PolicyParams` has exactly one. */
export type PolicyEntryKey = "recipients" | "approvers" | "limits" | "restrictions";

export function policyEntryKey(params: object): PolicyEntryKey | undefined {
  const record = params as Record<string, unknown>;
  return (["recipients", "approvers", "limits", "restrictions"] as const).find((key) => Array.isArray(record[key]));
}

function nativeSymbol(chain: string): string {
  return CHAIN_BY_ID[chain]?.nativeCurrency.symbol ?? "native currency";
}

/**
 * One line for a single entry of a policy's params — a recipient, an approver,
 * a limit or a contract restriction. `chain` is the policy's chain, used to
 * name tokens and the native asset.
 */
export function describeEntry(
  key: PolicyEntryKey,
  entry: Record<string, unknown>,
  chain: string,
  resolveLabel?: ResolveLabel,
): string {
  const label = labeller(chain, resolveLabel);
  if (key === "recipients" || key === "approvers") {
    const { address, nickname } = entry as RecipientEntry;
    const name = nickname || label(address);
    return `${name ? `${name} — ` : ""}${address}`;
  }
  if (key === "limits") {
    const { address, amount } = entry as LimitEntry;
    const frozen = amount === "0" ? " — frozen: any transfer of it is blocked" : "";
    if (address.toLowerCase() === NATIVE_ADDRESS) {
      let human = amount;
      try {
        human = formatEther(BigInt(amount));
      } catch {
        // Show it raw.
      }
      return `${human} ${nativeSymbol(chain)} per transaction (raw ${amount})${frozen}`;
    }
    const token = label(address);
    return `${amount} base units of ${token ? `${token} (${address})` : `token ${address}`} per transaction${frozen}`;
  }
  return describeRestriction(entry as ContractParamRestriction, label);
}

/**
 * Human-readable multi-line description of a policy, for lists and
 * confirmations. `resolveLabel` is an optional fallback name lookup (by
 * address) for entries with no explicit nickname stored on the policy — e.g.
 * a known org collaborator or another account in the org.
 */
export function describePolicy(policy: Policy, resolveLabel?: ResolveLabel): string {
  const header =
    `${POLICY_TYPE_LABEL[policy.type] ?? policy.type}  •  ${chainLabel(policy.chain)}` +
    (policy.type === "nominated_approvers" ? "  (not enforced by Salt yet)" : "");
  const key = policyEntryKey(policy.params);
  const entries = key ? ((policy.params as Record<string, unknown>)[key] as Record<string, unknown>[]) : [];
  const lines = entries.map((entry) => `  ${describeEntry(key!, entry, policy.chain, resolveLabel)}`);
  return lines.length > 0 ? `${header}\n${lines.join("\n")}` : header;
}

/** Format a base-unit amount for display alongside the raw value. */
export function formatLimitAmount(amount: string, decimals: number): string {
  try {
    return `${formatUnits(BigInt(amount), decimals)} (raw ${amount})`;
  } catch {
    return `raw ${amount}`;
  }
}

function decodeErc20Transfer(data: string): { to: string; amount: bigint } | undefined {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: data as Hex });
    if (decoded.functionName === "transfer") return { to: decoded.args[0], amount: decoded.args[1] };
  } catch {
    // Not an ERC-20 transfer.
  }
  return undefined;
}

/**
 * Why `policy` rejects `call`, worked out locally from the policy's params, so
 * a breach can be explained rather than just named. The server is the
 * authority: this returns `[]` when it can't reproduce a rejection, and the
 * caller falls back to naming the policy. `proposer` is the signer proposing
 * the call (for denied proposers).
 */
export function explainBreach(
  policy: Policy,
  call: PolicyCall,
  opts: { proposer?: string; resolveLabel?: ResolveLabel } = {},
): string[] {
  const label = labeller(call.chainId, opts.resolveLabel);
  const named = (address: string) => {
    const name = label(address);
    return name ? `${name} (${address})` : address;
  };
  const params = policy.params as Record<string, unknown>;
  const listed = new Set(((params.recipients as RecipientEntry[] | undefined) ?? []).map((r) => r.address.toLowerCase()));
  const transfer = decodeErc20Transfer(call.data);
  const counterparties = transfer ? [call.to, transfer.to] : [call.to];

  switch (policy.type) {
    case "allowed_recipients":
      return counterparties.filter((a) => !listed.has(a.toLowerCase())).map((a) => `${named(a)} isn't on the whitelist`);
    case "denied_recipients":
      return counterparties.filter((a) => listed.has(a.toLowerCase())).map((a) => `${named(a)} is on the blocklist`);
    case "denied_proposers":
      return opts.proposer && listed.has(opts.proposer.toLowerCase())
        ? [`${named(opts.proposer)} may not propose transactions from this account`]
        : [];
    case "transaction_limit_token_denominated": {
      const reasons: string[] = [];
      for (const limit of (params.limits as LimitEntry[] | undefined) ?? []) {
        let max: bigint;
        try {
          max = BigInt(limit.amount);
        } catch {
          continue;
        }
        if (limit.address.toLowerCase() === NATIVE_ADDRESS && call.value > max) {
          const symbol = nativeSymbol(call.chainId);
          reasons.push(`sends ${formatEther(call.value)} ${symbol}; the limit is ${formatEther(max)} ${symbol} per transaction`);
        } else if (transfer && limit.address.toLowerCase() === call.to.toLowerCase() && transfer.amount > max) {
          reasons.push(`transfers ${transfer.amount} base units of ${named(call.to)}; the limit is ${max} per transaction`);
        }
      }
      return reasons;
    }
    case "contract_param_restriction": {
      const reasons: string[] = [];
      for (const r of (params.restrictions as ContractParamRestriction[] | undefined) ?? []) {
        const outcome = evaluateRestriction(r, call);
        if (outcome.applies && !outcome.passed) reasons.push(`${r.functionSignature} on ${named(r.contractAddress)}: ${outcome.detail}`);
      }
      return reasons;
    }
    default:
      return [];
  }
}

/**
 * Why a policy on a transaction's chain wasn't evaluated for an operation —
 * which means it doesn't constrain it, something that's easy to assume
 * otherwise (a token limit, say, next to a swap of that token).
 */
export function explainNotEvaluated(policy: Policy, operation: string): string {
  const key = policyEntryKey(policy.params);
  const entries = key ? ((policy.params as Record<string, unknown>)[key] as unknown[]) : [];
  if (entries.length === 0) return "it has no entries, so it constrains nothing";
  switch (policy.type) {
    case "transaction_limit_token_denominated":
      return (
        "limits cap native value and direct transfer() calls only; tokens a contract pulls\n" +
        "after an approve() aren't limited. To bound those, cap approve() amounts with a\n" +
        'Contract call restriction ("ERC-20 approve — cap the allowance").'
      );
    case "contract_param_restriction":
      return `none of its restrictions match the calls this ${operation} makes`;
    case "nominated_approvers":
      return "approvals aren't enforced by Salt yet";
    default:
      return `it doesn't apply to this ${operation}`;
  }
}
