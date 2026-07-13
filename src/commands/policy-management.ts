import * as p from "@clack/prompts";
import { DuplicatePolicyError, type Policy, type PolicyType, type Salt } from "@kagamidigital/salt-sdk-mirror";
import { parseUnits } from "viem";
import { formatSaltError } from "../errors.js";
import {
  ADDRESS_PATTERN,
  CONTRACT_PRESETS,
  CREATABLE_POLICY_TYPES,
  NATIVE_ADDRESS,
  POLICY_OPERATORS,
  POLICY_TYPE_LABEL,
  RECIPIENT_TYPES,
  chainLabel,
  describePolicy,
  policyChainOptions,
} from "../policies.js";
import { pickOrganisation } from "../prompts.js";

type CreatableType = Exclude<PolicyType, "nominated_approvers">;
type RecipientEntry = { address: string; nickname?: string };
type LimitEntry = { address: string; amount: string };
type Restriction = {
  contractAddress: string;
  functionSignature: string;
  paramIndex: number;
  operator: (typeof POLICY_OPERATORS)[number]["value"];
  value: string;
};

const CANCEL = Symbol("cancel");

const addressValidator = (value: string | undefined) =>
  !value || !ADDRESS_PATTERN.test(value) ? "Enter a valid 0x-prefixed address" : undefined;

// --- param builders (return the entries array, or CANCEL if the user aborts) ---

async function buildRecipients(existing: RecipientEntry[] = []): Promise<RecipientEntry[] | typeof CANCEL> {
  const entries = [...existing];
  while (true) {
    const address = await p.text({
      message: entries.length === 0 ? "Address" : "Add another address (or leave blank to finish)",
      placeholder: "0x1234567890123456789012345678901234567890",
      validate: (v) => (v && v.trim() !== "" && !ADDRESS_PATTERN.test(v) ? "Enter a valid 0x-prefixed address" : undefined),
    });
    if (p.isCancel(address)) return CANCEL;
    if (!address || address.trim() === "") {
      if (entries.length === 0) {
        p.log.warn("At least one address is required.");
        continue;
      }
      return entries;
    }
    const nickname = await p.text({ message: "Nickname (optional)", defaultValue: "" });
    if (p.isCancel(nickname)) return CANCEL;
    entries.push(nickname ? { address, nickname } : { address });
  }
}

async function buildLimits(existing: LimitEntry[] = []): Promise<LimitEntry[] | typeof CANCEL> {
  const entries = [...existing];
  while (true) {
    if (entries.length > 0) {
      const more = await p.confirm({ message: "Add another token limit?", initialValue: false });
      if (p.isCancel(more)) return CANCEL;
      if (!more) return entries;
    }
    const isNative = await p.confirm({ message: "Is this a limit on the chain's native currency (ETH/MATIC)?" });
    if (p.isCancel(isNative)) return CANCEL;

    let tokenAddress = NATIVE_ADDRESS;
    let decimals = 18;
    if (!isNative) {
      const addr = await p.text({ message: "Token contract address", validate: addressValidator });
      if (p.isCancel(addr)) return CANCEL;
      tokenAddress = addr;
      const dec = await p.text({
        message: "Token decimals",
        defaultValue: "18",
        validate: (v) => (v && !/^\d+$/.test(v) ? "Enter a whole number" : undefined),
      });
      if (p.isCancel(dec)) return CANCEL;
      decimals = Number(dec || "18");
    }

    const amount = await p.text({
      message: "Max amount per transaction",
      placeholder: "e.g. 1.5",
      validate: (v) => {
        if (!v) return "Amount is required";
        try {
          if (parseUnits(v, decimals) <= 0n) return "Amount must be greater than 0";
        } catch {
          return "Not a valid amount";
        }
        return undefined;
      },
    });
    if (p.isCancel(amount)) return CANCEL;
    entries.push({ address: tokenAddress, amount: parseUnits(amount, decimals).toString() });
  }
}

async function buildRestrictions(existing: Restriction[] = []): Promise<Restriction[] | typeof CANCEL> {
  const entries = [...existing];
  while (true) {
    if (entries.length > 0) {
      const more = await p.confirm({ message: "Add another restriction?", initialValue: false });
      if (p.isCancel(more)) return CANCEL;
      if (!more) return entries;
    }

    const presetChoice = await p.select({
      message: "Restriction template",
      options: [
        ...CONTRACT_PRESETS.map((preset, i) => ({ value: String(i), label: preset.label })),
        { value: "custom", label: "Custom — enter everything manually" },
      ],
    });
    if (p.isCancel(presetChoice)) return CANCEL;

    const contractAddress = await p.text({ message: "Contract address", validate: addressValidator });
    if (p.isCancel(contractAddress)) return CANCEL;

    if (presetChoice !== "custom") {
      const preset = CONTRACT_PRESETS[Number(presetChoice)];
      const value = await p.text({
        message: preset.valuePrompt,
        validate: (v) => (!v || v.trim() === "" ? "Required" : undefined),
      });
      if (p.isCancel(value)) return CANCEL;
      entries.push({
        contractAddress,
        functionSignature: preset.functionSignature,
        paramIndex: preset.paramIndex,
        operator: preset.operator,
        value,
      });
      continue;
    }

    const functionSignature = await p.text({
      message: "Function signature",
      placeholder: "transfer(address,uint256)",
      validate: (v) => (!v || !v.includes("(") ? "Enter a signature like transfer(address,uint256)" : undefined),
    });
    if (p.isCancel(functionSignature)) return CANCEL;
    const paramIndex = await p.text({
      message: "Zero-based index of the argument to restrict",
      placeholder: "0",
      validate: (v) => (!v || !/^\d+$/.test(v) ? "Enter a whole number" : undefined),
    });
    if (p.isCancel(paramIndex)) return CANCEL;
    const operator = await p.select({ message: "Operator", options: [...POLICY_OPERATORS] });
    if (p.isCancel(operator)) return CANCEL;
    const value = await p.text({
      message: "Value the argument is compared against",
      validate: (v) => (!v || v.trim() === "" ? "Required" : undefined),
    });
    if (p.isCancel(value)) return CANCEL;
    entries.push({ contractAddress, functionSignature, paramIndex: Number(paramIndex), operator, value });
  }
}

/** Build the full params object for a given policy type, or CANCEL. */
async function buildParams(type: CreatableType): Promise<Record<string, unknown> | typeof CANCEL> {
  if (RECIPIENT_TYPES.includes(type)) {
    const recipients = await buildRecipients();
    return recipients === CANCEL ? CANCEL : { recipients };
  }
  if (type === "transaction_limit_token_denominated") {
    const limits = await buildLimits();
    return limits === CANCEL ? CANCEL : { limits };
  }
  const restrictions = await buildRestrictions();
  return restrictions === CANCEL ? CANCEL : { restrictions };
}

async function addPolicy(salt: Salt, accountId: string, organisationId: string): Promise<void> {
  const type = await p.select({
    message: "Policy type",
    options: CREATABLE_POLICY_TYPES.map((t) => ({ value: t.value, label: t.label, hint: t.hint })),
  });
  if (p.isCancel(type)) return;

  const chain = await p.select({ message: "Which chain does this policy apply to?", options: policyChainOptions() });
  if (p.isCancel(chain)) return;

  const params = await buildParams(type);
  if (params === CANCEL) return;

  const preview = describePolicy({ type, chain, params, accountId, organisationId, id: "(new)" } as Policy);
  p.note(preview, "New policy");
  const ok = await p.confirm({ message: "Create this policy?" });
  if (p.isCancel(ok) || !ok) return;

  const s = p.spinner();
  s.start("Creating policy");
  try {
    await salt.createAccountPolicy({ accountId, organisationId, type, chain, params: params as never });
    s.stop("Policy created");
  } catch (err) {
    s.stop("Failed to create policy");
    if (err instanceof DuplicatePolicyError) {
      p.log.error(
        `A "${POLICY_TYPE_LABEL[type]}" policy already exists for ${chainLabel(chain)}. Edit that one instead of creating a second.`,
      );
    } else {
      p.log.error(formatSaltError(err));
    }
  }
}

/** Re-collect a list-shaped policy's entries: keep/remove current ones, then optionally add more. */
async function editListPolicy(salt: Salt, policy: Policy): Promise<void> {
  const params = policy.params as Record<string, unknown>;
  const key = Array.isArray(params.recipients)
    ? "recipients"
    : Array.isArray(params.limits)
      ? "limits"
      : "restrictions";
  const current = params[key] as Record<string, unknown>[];

  const labelFor = (entry: Record<string, unknown>, i: number): string => {
    if (key === "recipients") return `${entry.nickname ? `${entry.nickname} — ` : ""}${entry.address}`;
    if (key === "limits") return `${entry.amount} base units @ ${entry.address}`;
    return `${entry.functionSignature} arg[${entry.paramIndex}] ${entry.operator} ${entry.value}`;
  };

  let kept = current;
  if (current.length > 0) {
    const keepIdx = await p.multiselect({
      message: "Keep which entries? (unchecked ones are removed)",
      required: false,
      initialValues: current.map((_, i) => i),
      options: current.map((entry, i) => ({ value: i, label: labelFor(entry, i) })),
    });
    if (p.isCancel(keepIdx)) return;
    kept = keepIdx.map((i) => current[i]);
  }

  let added: Record<string, unknown>[] = [];
  const addMore = await p.confirm({ message: "Add new entries?", initialValue: false });
  if (p.isCancel(addMore)) return;
  if (addMore) {
    const built =
      key === "recipients"
        ? await buildRecipients([])
        : key === "limits"
          ? await buildLimits([])
          : await buildRestrictions([]);
    if (built === CANCEL) return;
    added = built as Record<string, unknown>[];
  }

  const merged = [...kept, ...added];
  if (merged.length === 0) {
    p.log.warn("A policy needs at least one entry. To remove it entirely, use Delete policy instead.");
    return;
  }

  const newParams = { [key]: merged };
  p.note(
    describePolicy({ ...policy, params: newParams } as Policy),
    "Updated policy",
  );
  const ok = await p.confirm({ message: "Apply this update?" });
  if (p.isCancel(ok) || !ok) return;

  const s = p.spinner();
  s.start("Updating policy");
  try {
    await salt.updateAccountPolicy(policy.id, newParams as never);
    s.stop("Policy updated");
  } catch (err) {
    s.stop("Failed to update policy");
    p.log.error(formatSaltError(err));
  }
}

async function deletePolicy(salt: Salt, policy: Policy): Promise<void> {
  p.note(describePolicy(policy), "Policy to delete");
  const ok = await p.confirm({ message: "Delete this policy?" });
  if (p.isCancel(ok) || !ok) return;

  const s = p.spinner();
  s.start("Deleting policy");
  try {
    await salt.deleteAccountPolicy(policy.id);
    s.stop("Policy deleted");
  } catch (err) {
    s.stop("Failed to delete policy");
    p.log.error(formatSaltError(err));
  }
}

async function pickPolicy(policies: Policy[], message: string): Promise<Policy | undefined> {
  const choice = await p.select({
    message,
    options: policies.map((policy) => ({
      value: policy.id,
      label: `${POLICY_TYPE_LABEL[policy.type] ?? policy.type} · ${chainLabel(policy.chain)}`,
    })),
  });
  if (p.isCancel(choice)) return undefined;
  return policies.find((policy) => policy.id === choice);
}

export async function policyManagementFlow(salt: Salt): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Manage policies in which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    p.log.error(formatSaltError(err));
    return;
  }

  const usableAccounts = accounts.filter((a) => Boolean(a.evmAddress));
  if (usableAccounts.length === 0) {
    p.log.info("No fully-set-up accounts in this organisation to manage policies for.");
    return;
  }

  const accountId = await p.select({
    message: "Manage policies for which account?",
    options: usableAccounts.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress })),
  });
  if (p.isCancel(accountId)) return;

  const BACK = "__back";
  while (true) {
    let policies: Policy[];
    try {
      policies = await salt.listAccountPolicies(accountId);
    } catch (err) {
      p.log.error(formatSaltError(err));
      return;
    }

    if (policies.length === 0) {
      p.log.info("No policies on this account yet.");
    } else {
      for (const policy of policies) p.log.message(describePolicy(policy));
    }

    const action = await p.select({
      message: "Policy actions",
      options: [
        { value: "add", label: "Add policy" },
        ...(policies.length > 0
          ? [
              { value: "edit", label: "Edit policy" },
              { value: "delete", label: "Delete policy" },
            ]
          : []),
        { value: BACK, label: "Back" },
      ],
    });
    if (p.isCancel(action) || action === BACK) return;

    if (action === "add") {
      await addPolicy(salt, accountId, organisationId);
    } else if (action === "edit") {
      const policy = await pickPolicy(policies, "Edit which policy?");
      if (policy) await editListPolicy(salt, policy);
    } else if (action === "delete") {
      const policy = await pickPolicy(policies, "Delete which policy?");
      if (policy) await deletePolicy(salt, policy);
    }
  }
}
