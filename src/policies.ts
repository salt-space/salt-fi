import { formatUnits } from "viem";
import type { ContractParamRestrictionOperator, Policy, PolicyType } from "salt-sdk";
import { CHAIN_NAME_BY_ID } from "./chains.js";

export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Fallback name lookup for addresses with no nickname stored on the policy itself. */
export type ResolveLabel = (address: string) => string | undefined;

/**
 * Builds a fallback label lookup for policy addresses: an unlabeled whitelist
 * entry is often another account in the org, or a collaborator's own signing
 * address, so show the name rather than a bare hex string.
 */
export function buildResolveLabel(
  accounts: { evmAddress?: string; name: string }[],
  members: { address: string; name?: string }[],
): ResolveLabel {
  const byAddress = new Map<string, string>();
  for (const account of accounts) if (account.evmAddress) byAddress.set(account.evmAddress.toLowerCase(), account.name);
  for (const member of members) if (member.name) byAddress.set(member.address.toLowerCase(), member.name);
  return (address) => byAddress.get(address.toLowerCase());
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

export const POLICY_OPERATORS: { value: ContractParamRestrictionOperator; label: string }[] = [
  { value: "eq", label: "eq — equals" },
  { value: "neq", label: "neq — not equal" },
  { value: "lt", label: "lt — less than (numeric)" },
  { value: "lte", label: "lte — less than or equal (numeric)" },
  { value: "gt", label: "gt — greater than (numeric)" },
  { value: "gte", label: "gte — greater than or equal (numeric)" },
];

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

/**
 * A contract_param_restriction template: pre-fills the function/param/operator
 * so the user only supplies the compared value (usually an address). "Custom"
 * (no preset) lets them enter every field by hand.
 */
export interface ContractPreset {
  label: string;
  functionSignature: string;
  paramIndex: number;
  operator: ContractParamRestrictionOperator;
  /** Prompt shown when collecting the compared value. */
  valuePrompt: string;
}

export const CONTRACT_PRESETS: ContractPreset[] = [
  {
    label: "ERC-20 transfer — only to a specific recipient",
    functionSignature: "transfer(address,uint256)",
    paramIndex: 0,
    operator: "eq",
    valuePrompt: "Recipient address the transfer must go to",
  },
  {
    label: "ERC-20 approve — only a specific spender",
    functionSignature: "approve(address,uint256)",
    paramIndex: 0,
    operator: "eq",
    valuePrompt: "Spender address that may be approved",
  },
];

/**
 * Human-readable multi-line description of a policy, for lists and
 * confirmations. `resolveLabel` is an optional fallback name lookup (by
 * address) for recipient entries with no explicit nickname stored on the
 * policy — e.g. a known org collaborator or another account in the org.
 */
export function describePolicy(policy: Policy, resolveLabel?: (address: string) => string | undefined): string {
  const header = `${POLICY_TYPE_LABEL[policy.type] ?? policy.type}  •  ${chainLabel(policy.chain)}`;
  const lines: string[] = [];
  const params = policy.params as Record<string, unknown>;

  if (Array.isArray(params.recipients)) {
    for (const r of params.recipients as { address: string; nickname?: string }[]) {
      const label = r.nickname || resolveLabel?.(r.address);
      lines.push(`  ${label ? `${label} — ` : ""}${r.address}`);
    }
  } else if (Array.isArray(params.limits)) {
    for (const l of params.limits as { address: string; amount: string }[]) {
      const token = l.address.toLowerCase() === NATIVE_ADDRESS ? "native currency" : `token ${l.address}`;
      lines.push(`  ${l.amount} base units on ${token}`);
    }
  } else if (Array.isArray(params.restrictions)) {
    for (const r of params.restrictions as {
      contractAddress: string;
      functionSignature: string;
      paramIndex: number;
      operator: string;
      value: string;
    }[]) {
      lines.push(`  ${r.functionSignature} arg[${r.paramIndex}] ${r.operator} ${r.value} @ ${r.contractAddress}`);
    }
  }

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
