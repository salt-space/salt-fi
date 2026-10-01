import * as p from "@clack/prompts";
import { type ContractParamRestriction, DuplicatePolicyError, type Policy, type PolicyType, type Salt } from "salt-sdk";
import { type Address, createPublicClient, erc20Abi, getAddress, http, parseUnits } from "viem";
import { CHAIN_BY_ID, rpcUrl } from "../chains.js";
import {
  auditRestrictions,
  findConflicts,
  type FunctionParam,
  normalizeValue,
  OPERATOR_LABEL,
  operatorsFor,
  type ParamKind,
  paramLabel,
  parseFunctionSignature,
  RESTRICTION_PRESETS,
  type RestrictionPreset,
} from "../contract-restrictions.js";
import { formatSaltError } from "../errors.js";
import {
  ADDRESS_PATTERN,
  CREATABLE_POLICY_TYPES,
  NATIVE_ADDRESS,
  POLICY_TYPE_LABEL,
  RECIPIENT_TYPES,
  type ResolveLabel,
  buildResolveLabel,
  chainLabel,
  describeEntry,
  describePolicy,
  policyChainOptions,
  policyEntryKey,
} from "../policies.js";
import { pickOrganisation, select } from "../prompts.js";
import { KNOWN_TOKENS_BY_CHAIN } from "../uniswap.js";
import type { SaltWalletClient } from "../wallet.js";

type CreatableType = Exclude<PolicyType, "nominated_approvers">;
type RecipientEntry = { address: string; nickname?: string };
/** A pickable signer for a denied-proposers policy: the account's human co-signers. */
type ProposerOption = { address: string; label: string; hint?: string };
type LimitEntry = { address: string; amount: string };
type Restriction = ContractParamRestriction;

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

/**
 * The account's human signers, as pickable options for a denied-proposers
 * policy. Only humans can *propose* a transfer (robos co-sign, they don't
 * initiate), so robo guardians are filtered out. Labels resolve to org member
 * names where known. Returns `[]` if the signer set can't be read — callers
 * fall back to freeform address entry.
 */
async function loadProposerOptions(salt: Salt, accountId: string, resolveLabel: ResolveLabel): Promise<ProposerOption[]> {
  try {
    const signers = await salt.getAccountSigners(accountId);
    return signers
      .filter((s) => !s.isRobo)
      .map((s) => {
        const label = resolveLabel(s.address);
        return { address: s.address, label: label ?? s.address, hint: label ? s.address : undefined };
      });
  } catch {
    // Reading signers needs account access; if it fails, callers degrade to
    // freeform entry rather than blocking the whole policy flow.
    return [];
  }
}

/**
 * Pick the denied proposers from the account's co-signers (multiselect) rather
 * than typing addresses. Pre-checks any addresses already on the policy (edit
 * flow) and preserves any existing entries that aren't in the signer set.
 * Returns the full list or CANCEL (Esc). Re-prompts on an empty selection —
 * a proposers policy needs at least one entry, and space (not enter) toggles.
 */
async function buildProposers(
  options: ProposerOption[],
  existing: RecipientEntry[] = [],
): Promise<RecipientEntry[] | typeof CANCEL> {
  const existingAddrs = new Set(existing.map((e) => e.address.toLowerCase()));
  const optionAddrs = new Set(options.map((o) => o.address.toLowerCase()));
  // Keep any existing off-list entries (e.g. a manually-added address from
  // before this account's signer set changed); the multiselect owns the rest.
  const preserved = existing.filter((e) => !optionAddrs.has(e.address.toLowerCase()));

  while (true) {
    const selected = await p.multiselect({
      message: "Which co-signers may NOT initiate transfers?",
      required: false,
      initialValues: options.filter((o) => existingAddrs.has(o.address.toLowerCase())).map((o) => o.address),
      options: options.map((o) => ({ value: o.address, label: o.label, hint: o.hint })),
    });
    if (p.isCancel(selected)) return CANCEL;
    const chosen = [...preserved, ...selected.map((address) => ({ address }))];
    if (chosen.length === 0) {
      p.log.warn("Toggle a co-signer with space, then press enter — or press Esc to go back.");
      continue;
    }
    return chosen;
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

const OTHER_TOKEN = "__other";

/**
 * Pick a token contract: the chain's curated tokens when the policy is scoped
 * to a single chain, otherwise (or for anything else) a pasted address.
 */
async function promptTokenAddress(chain: string | undefined, message: string): Promise<Address | typeof CANCEL> {
  const known = chain && chain !== "*" ? (KNOWN_TOKENS_BY_CHAIN[chain] ?? []) : [];
  if (known.length > 0) {
    const choice = await select({
      message,
      options: [
        ...known.map((token) => ({ value: token.address as string, label: token.symbol, hint: token.address })),
        { value: OTHER_TOKEN, label: "Another token — enter its address" },
      ],
    });
    if (p.isCancel(choice)) return CANCEL;
    if (choice !== OTHER_TOKEN) return getAddress(choice);
  }
  const address = await p.text({ message: known.length > 0 ? "Token contract address" : message, validate: addressValidator });
  return p.isCancel(address) ? CANCEL : getAddress(address);
}

/**
 * A token's decimals — read on-chain when the policy is scoped to one chain,
 * otherwise (or if the read fails) asked for.
 */
async function promptTokenDecimals(chain: string | undefined, token: Address): Promise<number | typeof CANCEL> {
  const viemChain = chain && chain !== "*" ? CHAIN_BY_ID[chain] : undefined;
  if (chain && viemChain) {
    const s = p.spinner();
    s.start("Reading the token's decimals");
    try {
      const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl(chain), { timeout: 8_000, retryCount: 1 }) });
      const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
      s.stop(`The token has ${decimals} decimals`);
      return decimals;
    } catch {
      s.stop("Couldn't read the token's decimals — enter them below");
    }
  }
  const dec = await p.text({
    message: "Token decimals",
    defaultValue: "18",
    placeholder: "18",
    validate: (v) => (v && !/^\d+$/.test(v) ? "Enter a whole number" : undefined),
  });
  return p.isCancel(dec) ? CANCEL : Number(dec || "18");
}

const VALUE_PLACEHOLDER: Record<ParamKind, string> = {
  uint: "a whole number in base units, e.g. 1000000",
  int: "a whole number, e.g. -5",
  address: "0x1234567890123456789012345678901234567890",
  bool: "true or false",
  bytes: "0x-prefixed hex",
  string: "exact text (compared case-insensitively)",
};

/**
 * Collect the value an argument is compared against, validated for its
 * Solidity type — the API accepts a malformed value, and one that fails to
 * parse on the server blocks every call the restriction matches. Returns the
 * value normalised for saving.
 */
async function promptValue(param: FunctionParam, message: string, decimals?: number): Promise<string | typeof CANCEL> {
  const input = await p.text({
    message,
    placeholder: decimals !== undefined ? "e.g. 250" : VALUE_PLACEHOLDER[param.kind ?? "string"],
    validate: (v) => {
      const checked = normalizeValue(param, v ?? "", { decimals });
      return checked.ok ? undefined : checked.error;
    },
  });
  if (p.isCancel(input)) return CANCEL;
  const checked = normalizeValue(param, input ?? "", { decimals });
  if (!checked.ok) return CANCEL; // unreachable: validate already passed
  if (decimals !== undefined) p.log.step(`${input.trim()} tokens = ${checked.value} base units`);
  return checked.value;
}

/** A restriction from a template: pick the token, enter the value. */
async function buildPresetRestriction(preset: RestrictionPreset, chain: string | undefined): Promise<Restriction | typeof CANCEL> {
  const fn = parseFunctionSignature(preset.functionSignature);
  if (preset.note) p.log.info(preset.note);

  const contractAddress = await promptTokenAddress(chain, "Which token?");
  if (contractAddress === CANCEL) return CANCEL;
  let decimals: number | undefined;
  if (preset.tokenAmount) {
    const read = await promptTokenDecimals(chain, contractAddress);
    if (read === CANCEL) return CANCEL;
    decimals = read;
  }
  const value = await promptValue(
    fn.params[preset.paramIndex],
    decimals !== undefined ? `${preset.valuePrompt}, in whole tokens` : preset.valuePrompt,
    decimals,
  );
  if (value === CANCEL) return CANCEL;
  return { contractAddress, functionSignature: fn.signature, paramIndex: preset.paramIndex, operator: preset.operator, value };
}

/**
 * A restriction on any function: the signature is parsed up front, the
 * argument is picked from its parameters, and only operators and values the
 * engine can compare for that argument's type are offered. Returns undefined
 * when the function has nothing that can be restricted.
 */
async function buildCustomRestriction(): Promise<Restriction | typeof CANCEL | undefined> {
  const contractAddress = await p.text({ message: "Contract address", validate: addressValidator });
  if (p.isCancel(contractAddress)) return CANCEL;

  const signature = await p.text({
    message: "Function signature",
    placeholder: "approve(address spender, uint256 amount)",
    validate: (v) => {
      try {
        parseFunctionSignature(v ?? "");
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
  if (p.isCancel(signature)) return CANCEL;
  const fn = parseFunctionSignature(signature);

  const comparable = fn.params.filter((param) => param.kind);
  if (comparable.length === 0) {
    p.log.warn(
      fn.params.length === 0
        ? `${fn.signature} takes no arguments — there's nothing to restrict.`
        : `None of ${fn.signature}'s arguments can be restricted: Salt compares top-level numbers, addresses, bools,\n` +
            "bytes and strings, not tuples or arrays.",
    );
    return undefined;
  }
  // Show what will actually be matched, so it can be checked against the contract's ABI or an explorer.
  p.log.info(`Matches calls to ${fn.signature} — selector ${fn.selector}`);

  const paramIndex = await select({
    message: "Which argument?",
    initialValue: comparable[0].index,
    options: fn.params.map((param) => ({
      value: param.index,
      label: `${paramLabel(param)} — ${param.type}`,
      hint: param.kind ? undefined : "tuples and arrays can't be compared",
      disabled: !param.kind,
    })),
  });
  if (p.isCancel(paramIndex)) return CANCEL;
  const param = fn.params[paramIndex];

  const operator = await select({
    message: "Operator",
    options: operatorsFor(param.kind!).map((op) => ({ value: op, label: OPERATOR_LABEL[op] })),
  });
  if (p.isCancel(operator)) return CANCEL;

  const value = await promptValue(param, `Value ${paramLabel(param)} is compared against`);
  if (value === CANCEL) return CANCEL;
  return { contractAddress: getAddress(contractAddress), functionSignature: fn.signature, paramIndex, operator, value };
}

async function buildRestrictions(
  existing: Restriction[] = [],
  allowBack = false,
  chain?: string,
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
        ...RESTRICTION_PRESETS.map((preset, i) => ({ value: String(i), label: preset.label, hint: preset.hint })),
        { value: "custom", label: "Custom — any function and argument" },
        ...(allowBack && entries.length === 0 ? [{ value: "__back", label: "← Back" }] : []),
      ],
    });
    if (p.isCancel(presetChoice)) return CANCEL;
    if (presetChoice === "__back") return GO_BACK;

    const built =
      presetChoice === "custom"
        ? await buildCustomRestriction()
        : await buildPresetRestriction(RESTRICTION_PRESETS[Number(presetChoice)], chain);
    if (built === CANCEL) return CANCEL;
    if (built === undefined) continue;

    // Restrictions are ANDed, so one that can't hold alongside the others
    // freezes the function outright. Allow it (freezing can be the intent),
    // but only knowingly.
    const before = new Set(findConflicts(entries));
    const conflicts = findConflicts([...entries, built]).filter((c) => !before.has(c));
    if (conflicts.length > 0) {
      p.log.warn(conflicts.join("\n\n"));
      const keep = await p.confirm({ message: "Add this restriction anyway?", initialValue: false });
      if (p.isCancel(keep)) return CANCEL;
      if (!keep) continue;
    }
    entries.push(built);
  }
}

/** Build the full params object for a given policy type: object, CANCEL, or GO_BACK. */
async function buildParams(
  type: CreatableType,
  chain: string,
  proposerOptions: ProposerOption[] = [],
): Promise<Record<string, unknown> | typeof CANCEL | typeof GO_BACK> {
  // Denied proposers are always the account's own co-signers, so offer them as
  // a pick-list. Fall back to freeform entry only if the signer set is empty
  // or unreadable.
  if (type === "denied_proposers" && proposerOptions.length > 0) {
    const recipients = await buildProposers(proposerOptions);
    return recipients === CANCEL ? recipients : { recipients };
  }
  if (RECIPIENT_TYPES.includes(type)) {
    const recipients = await buildRecipients([], true);
    return recipients === CANCEL || recipients === GO_BACK ? recipients : { recipients };
  }
  if (type === "transaction_limit_token_denominated") {
    const limits = await buildLimits([], true);
    return limits === CANCEL || limits === GO_BACK ? limits : { limits };
  }
  const restrictions = await buildRestrictions([], true, chain);
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
  // Loaded lazily the first time a denied-proposers policy is being built.
  let proposerOptions: ProposerOption[] | undefined;

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

    if (type === "denied_proposers" && proposerOptions === undefined) {
      proposerOptions = await loadProposerOptions(salt, accountId, resolveLabel);
      if (proposerOptions.length === 0) {
        p.log.info("Couldn't read this account's co-signers — enter proposer addresses manually.");
      }
    }

    const built = await buildParams(type, chain, proposerOptions ?? []);
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
  const key = policyEntryKey(policy.params);
  // Nominated approvers aren't enforced by Salt yet (the picker leaves them out); nothing else lacks entries.
  if (key === undefined || key === "approvers") {
    p.log.info("This policy has no editable entries — delete it instead.");
    return;
  }

  const labelFor = (entry: Record<string, unknown>): string => describeEntry(key, entry, policy.chain, resolveLabel);

  let working = [...(params[key] as Record<string, unknown>[])];

  // For a denied-proposers policy, adding entries picks from the account's
  // co-signers rather than freeform address entry (loaded once, on demand).
  const isProposers = policy.type === "denied_proposers";
  let proposerOptions: ProposerOption[] | undefined;

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
      if (isProposers && proposerOptions === undefined) {
        proposerOptions = await loadProposerOptions(salt, policy.accountId, resolveLabel);
      }
      // Builders return the full list (existing + newly added).
      const built =
        key === "recipients"
          ? isProposers && proposerOptions && proposerOptions.length > 0
            ? await buildProposers(proposerOptions, working as never)
            : await buildRecipients(working as never)
          : key === "limits"
            ? await buildLimits(working as never)
            : await buildRestrictions(working as never, false, policy.chain);
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

  const resolveLabel = buildResolveLabel(accounts, organisation.collaborators);

  // Per Salt's access levels (owner/member/agent/member-no-permissions), only
  // an owner may add/edit/delete policies — member and agent are view-only.
  // Deliberately not scoping *which* accounts are viewable here (e.g. an
  // agent's account list) — that's left to the API/server to enforce, so it
  // can be verified independently rather than duplicated client-side.
  const selfAddress = walletClient.account.address;
  const self = organisation.collaborators.find((m) => m.address.toLowerCase() === selfAddress.toLowerCase());
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
      for (const policy of policies) {
        p.log.message(describePolicy(policy, resolveLabel));
        const problems = "restrictions" in policy.params ? auditRestrictions(policy.params.restrictions) : [];
        if (problems.length > 0) {
          p.log.warn(`Problems with the policy above:\n${problems.map((problem) => `  • ${problem}`).join("\n")}`);
        }
      }
    }

    // Nominated approvers aren't enforced by Salt yet, so there's nothing to edit — only delete.
    const editable = policies.filter((policy) => policy.type !== "nominated_approvers");
    const actionOptions = [
      ...(canEdit ? [{ value: "add", label: "Add policy" }] : []),
      ...(canEdit && editable.length > 0 ? [{ value: "edit", label: "Edit policy" }] : []),
      ...(canEdit && policies.length > 0 ? [{ value: "delete", label: "Delete policy" }] : []),
    ];
    // Nothing to do here (view-only account with no policies) — nothing to pick from.
    if (actionOptions.length === 0) return;

    const action = await select({ message: "Policy actions", options: actionOptions });
    if (p.isCancel(action)) return;

    if (action === "add") {
      await addPolicy(salt, accountId, organisationId, resolveLabel);
    } else if (action === "edit") {
      const policy = await pickPolicy(editable, "Edit which policy?");
      if (policy) await editListPolicy(salt, policy, resolveLabel);
    } else if (action === "delete") {
      const policy = await pickPolicy(policies, "Delete which policy?");
      if (policy) await deletePolicy(salt, policy, resolveLabel);
    }
  }
}
