import * as p from "@clack/prompts";
import { DuplicatePolicyError, type Policy, type PolicyType, type Salt } from "salt-sdk";
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
  type ResolveLabel,
  buildResolveLabel,
  chainLabel,
  describePolicy,
  policyChainOptions,
} from "../policies.js";
import { pickOrganisation, select } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

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
/** A builder's first step was backed out of — return to the previous add step. */
const GO_BACK = Symbol("go_back");

const addressValidator = (value: string | undefined) =>
  !value || !ADDRESS_PATTERN.test(value) ? "Enter a valid 0x-prefixed address" : undefined;

// --- param builders. Return the entries array, CANCEL (abort), or — only when
// `allowBack` and no entries have been added yet — GO_BACK (step back). ---

async function buildRecipients(
  existing: RecipientEntry[] = [],
  allowBack = false,
): Promise<RecipientEntry[] | typeof CANCEL | typeof GO_BACK> {
  const entries = [...existing];
  while (true) {
    const first = entries.length === 0;
    const address = await p.text({
      message: first
        ? allowBack
          ? "Address (leave blank to go back)"
          : "Address"
        : "Add another address (or leave blank to finish)",
      placeholder: "0x1234567890123456789012345678901234567890",
      validate: (v) => (v && v.trim() !== "" && !ADDRESS_PATTERN.test(v) ? "Enter a valid 0x-prefixed address" : undefined),
    });
    if (p.isCancel(address)) return CANCEL;
    if (!address || address.trim() === "") {
      if (first) return allowBack ? GO_BACK : entries;
      return entries;
    }
    const nickname = await p.text({ message: "Nickname (optional)", defaultValue: "" });
    if (p.isCancel(nickname)) return CANCEL;
    entries.push(nickname ? { address, nickname } : { address });
  }
}

async function buildLimits(
  existing: LimitEntry[] = [],
  allowBack = false,
): Promise<LimitEntry[] | typeof CANCEL | typeof GO_BACK> {
  const entries = [...existing];
  while (true) {
    if (entries.length > 0) {
      const more = await p.confirm({ message: "Add another token limit?", initialValue: false });
      if (p.isCancel(more)) return CANCEL;
      if (!more) return entries;
    }

    const kind = await select({
      message: "What is the limit on?",
      options: [
        { value: "native", label: "Native currency (ETH/MATIC)" },
        { value: "token", label: "A specific token" },
        ...(allowBack && entries.length === 0 ? [{ value: "__back", label: "← Back" }] : []),
      ],
    });
    if (p.isCancel(kind)) return CANCEL;
    if (kind === "__back") return GO_BACK;

    let tokenAddress = NATIVE_ADDRESS;
    let decimals = 18;
    if (kind === "token") {
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

async function buildRestrictions(
  existing: Restriction[] = [],
  allowBack = false,
): Promise<Restriction[] | typeof CANCEL | typeof GO_BACK> {
  const entries = [...existing];
  while (true) {
    if (entries.length > 0) {
      const more = await p.confirm({ message: "Add another restriction?", initialValue: false });
      if (p.isCancel(more)) return CANCEL;
      if (!more) return entries;
    }

    const presetChoice = await select({
      message: "Restriction template",
      options: [
        ...CONTRACT_PRESETS.map((preset, i) => ({ value: String(i), label: preset.label })),
        { value: "custom", label: "Custom — enter everything manually" },
        ...(allowBack && entries.length === 0 ? [{ value: "__back", label: "← Back" }] : []),
      ],
    });
    if (p.isCancel(presetChoice)) return CANCEL;
    if (presetChoice === "__back") return GO_BACK;

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
    const operator = await select({ message: "Operator", options: [...POLICY_OPERATORS] });
    if (p.isCancel(operator)) return CANCEL;
    const value = await p.text({
      message: "Value the argument is compared against",
      validate: (v) => (!v || v.trim() === "" ? "Required" : undefined),
    });
    if (p.isCancel(value)) return CANCEL;
    entries.push({ contractAddress, functionSignature, paramIndex: Number(paramIndex), operator, value });
  }
}

/** Build the full params object for a given policy type: object, CANCEL, or GO_BACK. */
async function buildParams(type: CreatableType): Promise<Record<string, unknown> | typeof CANCEL | typeof GO_BACK> {
  if (RECIPIENT_TYPES.includes(type)) {
    const recipients = await buildRecipients([], true);
    return recipients === CANCEL || recipients === GO_BACK ? recipients : { recipients };
  }
  if (type === "transaction_limit_token_denominated") {
    const limits = await buildLimits([], true);
    return limits === CANCEL || limits === GO_BACK ? limits : { limits };
  }
  const restrictions = await buildRestrictions([], true);
  return restrictions === CANCEL || restrictions === GO_BACK ? restrictions : { restrictions };
}

const BACK = "__back";

/** Exported so the getting-started wizard can walk a user through their first policy directly. */
export async function addPolicy(
  salt: Salt,
  accountId: string,
  organisationId: string,
  resolveLabel: ResolveLabel,
): Promise<void> {
  // Step through type -> chain -> params, letting the user back up a step
  // (or return to the actions menu) at each select rather than only Esc.
  let type: CreatableType | undefined;
  let chain: string | undefined;
  let params: Record<string, unknown> | undefined;

  while (params === undefined) {
    if (type === undefined) {
      const choice = await select({
        message: "Policy type",
        options: CREATABLE_POLICY_TYPES.map((t) => ({ value: t.value as string, label: t.label, hint: t.hint })),
      });
      if (p.isCancel(choice)) return;
      type = choice as CreatableType;
    }

    if (chain === undefined) {
      const choice = await select({
        message: "Which chain does this policy apply to?",
        options: [...policyChainOptions(), { value: BACK, label: "← Back (change type)" }],
      });
      if (p.isCancel(choice)) return;
      if (choice === BACK) {
        type = undefined; // back to type selection
        continue;
      }
      chain = choice;
    }

    const built = await buildParams(type);
    if (built === GO_BACK) {
      chain = undefined; // back to chain selection
      continue;
    }
    if (built === CANCEL) return;
    params = built;
  }

  // The loop only completes with all three set; narrow for TS.
  if (type === undefined || chain === undefined) return;

  const preview = describePolicy({ type, chain, params, accountId, organisationId, id: "(new)" } as Policy, resolveLabel);
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

/**
 * Edit a list-shaped policy's entries (add/remove) in an editor loop, then save.
 * The SDK's update fully replaces params, so we send the whole working set.
 */
async function editListPolicy(salt: Salt, policy: Policy, resolveLabel: ResolveLabel): Promise<void> {
  const params = policy.params as Record<string, unknown>;
  const key = Array.isArray(params.recipients)
    ? "recipients"
    : Array.isArray(params.limits)
      ? "limits"
      : "restrictions";

  const labelFor = (entry: Record<string, unknown>): string => {
    if (key === "recipients") {
      const label = (entry.nickname as string | undefined) || resolveLabel(entry.address as string);
      return `${label ? `${label} — ` : ""}${entry.address}`;
    }
    if (key === "limits") return `${entry.amount} base units @ ${entry.address}`;
    return `${entry.functionSignature} arg[${entry.paramIndex}] ${entry.operator} ${entry.value}`;
  };

  let working = [...(params[key] as Record<string, unknown>[])];

  const SAVE = "__save";
  const CANCEL_EDIT = "__cancel";
  const ADD = "__add";
  const REMOVE = "__remove";

  while (true) {
    p.log.message(
      working.length > 0
        ? `Current entries:\n${working.map((e) => `  ${labelFor(e)}`).join("\n")}`
        : "No entries — add at least one, or cancel.",
    );

    const action = await select({
      message: "Edit policy",
      options: [
        { value: ADD, label: "Add entries" },
        ...(working.length > 0 ? [{ value: REMOVE, label: "Remove entries" }] : []),
        { value: SAVE, label: "Save changes" },
        { value: CANCEL_EDIT, label: "Cancel (discard changes)" },
      ],
    });
    if (p.isCancel(action) || action === CANCEL_EDIT) return;

    if (action === ADD) {
      // Builders return the full list (existing + newly added).
      const built =
        key === "recipients"
          ? await buildRecipients(working as never)
          : key === "limits"
            ? await buildLimits(working as never)
            : await buildRestrictions(working as never);
      if (built === CANCEL || built === GO_BACK) continue; // aborting Add keeps the working set
      working = built as Record<string, unknown>[];
      continue;
    }

    if (action === REMOVE) {
      const removeIdx = await p.multiselect({
        message: "Select entries to remove",
        required: false,
        options: working.map((entry, i) => ({ value: i, label: labelFor(entry) })),
      });
      if (p.isCancel(removeIdx)) continue;
      working = working.filter((_, i) => !removeIdx.includes(i));
      continue;
    }

    // SAVE
    if (working.length === 0) {
      p.log.warn("A policy needs at least one entry. To remove it entirely, use Delete policy instead.");
      continue;
    }
    const newParams = { [key]: working };
    p.note(describePolicy({ ...policy, params: newParams } as Policy, resolveLabel), "Updated policy");
    const ok = await p.confirm({ message: "Apply this update?" });
    if (p.isCancel(ok) || !ok) continue;

    const s = p.spinner();
    s.start("Updating policy");
    try {
      await salt.updateAccountPolicy(policy.id, newParams as never);
      s.stop("Policy updated");
    } catch (err) {
      s.stop("Failed to update policy");
      p.log.error(formatSaltError(err));
    }
    return;
  }
}

async function deletePolicy(salt: Salt, policy: Policy, resolveLabel: ResolveLabel): Promise<void> {
  p.note(describePolicy(policy, resolveLabel), "Policy to delete");
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
  const choice = await select({
    message,
    options: policies.map((policy) => ({
      value: policy.id,
      label: `${POLICY_TYPE_LABEL[policy.type] ?? policy.type} · ${chainLabel(policy.chain)}`,
    })),
  });
  if (p.isCancel(choice)) return undefined;
  return policies.find((policy) => policy.id === choice);
}

export async function policyManagementFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Manage policies in which organisation?");
  if (!organisationId) return;

  let accounts;
  let organisation;
  try {
    [accounts, { organisation }] = await Promise.all([
      salt.getAccounts(organisationId),
      salt.getOrganisationById(organisationId),
    ]);
  } catch (err) {
    p.log.error(formatSaltError(err));
    return;
  }

  const usableAccounts = accounts.filter((a) => Boolean(a.evmAddress));
  if (usableAccounts.length === 0) {
    p.log.info("No fully-set-up accounts in this organisation to manage policies for.");
    return;
  }

  const resolveLabel = buildResolveLabel(accounts, organisation.members);

  // Per Salt's access levels (owner/member/agent/member-no-permissions), only
  // an owner may add/edit/delete policies — member and agent are view-only.
  // Deliberately not scoping *which* accounts are viewable here (e.g. an
  // agent's account list) — that's left to the API/server to enforce, so it
  // can be verified independently rather than duplicated client-side.
  const selfAddress = walletClient.account.address;
  const self = organisation.members.find((m) => m.address.toLowerCase() === selfAddress.toLowerCase());
  const canEdit = self?.accessLevel === 1;
  if (!canEdit) {
    p.log.info("You have view-only access to policies — adding, editing, and deleting are owner-only.");
  }

  const accountId = await select({
    message: "Manage policies for which account?",
    options: usableAccounts.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress })),
  });
  if (p.isCancel(accountId)) return;

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
      for (const policy of policies) p.log.message(describePolicy(policy, resolveLabel));
    }

    const actionOptions = [
      ...(canEdit ? [{ value: "add", label: "Add policy" }] : []),
      ...(canEdit && policies.length > 0
        ? [
            { value: "edit", label: "Edit policy" },
            { value: "delete", label: "Delete policy" },
          ]
        : []),
    ];
    // Nothing to do here (view-only account with no policies) — nothing to pick from.
    if (actionOptions.length === 0) return;

    const action = await select({ message: "Policy actions", options: actionOptions });
    if (p.isCancel(action)) return;

    if (action === "add") {
      await addPolicy(salt, accountId, organisationId, resolveLabel);
    } else if (action === "edit") {
      const policy = await pickPolicy(policies, "Edit which policy?");
      if (policy) await editListPolicy(salt, policy, resolveLabel);
    } else if (action === "delete") {
      const policy = await pickPolicy(policies, "Delete which policy?");
      if (policy) await deletePolicy(salt, policy, resolveLabel);
    }
  }
}
