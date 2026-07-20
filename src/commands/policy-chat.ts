import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { CHAIN_NAME_BY_ID } from "../chains.js";
import { formatSaltError } from "../errors.js";
import { pickOrganisation } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

const REQUESTED_POLICIES_FILE = path.resolve(process.cwd(), "docs/requested-policies.md");

const SYSTEM_PROMPT = `You are a policy assistant embedded in "salt-fi", a terminal app for Salt — an MPC self-custody / treasury platform. You help the user understand and manage the transaction policies on their Salt accounts through natural conversation.

# How Salt policies work

A policy is attached to one account and one chain, and constrains which transactions that account can make. There are six policy types; each carries exactly ONE params member:

- allowed_recipients — { recipients: [{ address, nickname? }] }. A whitelist: only these addresses may RECEIVE funds; a transfer to any other address is a breach.
- denied_recipients — { recipients: [...] }. These addresses may NOT receive funds. If an address is on both allowed and denied lists, denied wins.
- denied_proposers — { recipients: [...] }. IMPORTANT QUIRK: for legacy reasons the addresses live under the "recipients" key, but they are matched against the transaction's PROPOSER (the human signer initiating the transfer), not the recipient. This is what blocks a signer from initiating transfers out of the account.
- transaction_limit_token_denominated — { limits: [{ address, amount, isWarningSuppressed? }] }. Caps the amount a SINGLE transaction may transfer, per token. "address" is the token contract address; use the zero address (0x0000000000000000000000000000000000000000) for the chain's native asset. "amount" is an integer STRING in the token's base units (wei for 18-decimal tokens; e.g. 1 USDC with 6 decimals = "1000000"). The cap is per-transaction, NOT cumulative across transactions.
- nominated_approvers — { approvers: [{ address }] }. CANNOT BE CREATED (the API rejects it; not yet implemented / not enforced). Existing ones can be read, updated, or deleted only.
- contract_param_restriction — { restrictions: [{ contractAddress, functionSignature, paramIndex, operator, value }] }. Restricts the arguments of a contract call. Only applies to transactions calling functionSignature on contractAddress; the decoded argument at paramIndex (zero-based) must satisfy operator/value. functionSignature is human-readable without the "function" keyword, e.g. "transfer(address,uint256)". operator is one of eq, neq, lt, lte, gt, gte — but lt/lte/gt/gte are numeric-only (uint*/int*); address/bool/bytes*/string support only eq/neq. value is an integer string for numeric params, or the literal value (case-insensitive) otherwise. Do NOT supply a solidityType — it's derived automatically.

# Critical rules

- At most ONE policy per (type, chain) on an account. Creating a duplicate fails. To express several constraints of one type, put them all in that single policy's params array.
- "chain" is a STRING: a numeric chain ID like "11155111", or "*" to apply on every chain. A "*" policy and a specific-chain policy of the same type BOTH apply on that chain.
- update_policy REPLACES the params entirely — it is not a patch. To add one recipient to a whitelist, you must resend the full desired recipients array (fetch the current policy first, then send current + new).
- You cannot change a policy's type or chain via update — delete and recreate instead.

Known chain IDs in this app: ${Object.entries(CHAIN_NAME_BY_ID)
  .map(([id, name]) => `${id} (${name})`)
  .join(", ")}, plus "*" for all chains.

# How to behave

- ALWAYS look before you write: call list_policies (and get_policy) to understand current state before proposing changes. Never guess a policyId — read it from list_policies.
- Propose, don't surprise: the create/update/delete tools each show the user the exact change and ask them to confirm before anything happens. If the user declines, acknowledge and adjust — don't retry the same thing.
- Ask clarifying questions when a request is ambiguous (which account? which chains? native asset or a specific token? exact amount?). Prefer one concise question over a wrong guess.
- For "copy" requests (whitelist to all chains, all policies from account A to B), read the source policies, then create the equivalent policies on the target — walking the user through each.
- Advisory questions ("I'm going to trade on AAVE, what policies should I add?"): recommend concrete, specific policies — e.g. a contract_param_restriction limiting which functions/pools, an allowed_recipients whitelist of the protocol's contracts, a transaction_limit to cap per-tx size. Explain the tradeoffs, then offer to create them.
- When the user asks for something Salt does NOT support — time-based / scheduled access (e.g. "only on the first of the month"), CUMULATIVE spend limits (Salt limits are per-transaction only), human approval workflows (nominated_approvers isn't enforced), or anything that doesn't map to the six types above — do NOT pretend it works. Explain the gap, then use record_unsupported_policy_request to log it for the Salt team.
- Be concise. Lead with the answer. When you show policies, translate them into plain language (e.g. "0x5F92… is blocked from proposing transactions on all chains"), don't just dump JSON.`;

interface PolicyChatContext {
  salt: Salt;
  organisationId: string;
  /** id -> display name, for fully-set-up accounts only. */
  accountNameById: Map<string, string>;
}

function accountLabel(accountNameById: Map<string, string>, accountId: string): string {
  const name = accountNameById.get(accountId);
  return name ? `${name} (${accountId})` : accountId;
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function saltCall<T>(fn: () => Promise<T>): Promise<string> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    return `ERROR: ${formatSaltError(err)}`;
  }
}

function buildTools(ctx: PolicyChatContext) {
  const { salt, organisationId, accountNameById } = ctx;

  const listPolicies = betaTool({
    name: "list_policies",
    description: "List all policies attached to an account. Returns each policy's id, type, chain, and params.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { accountId: { type: "string", description: "The Salt account id" } },
      required: ["accountId"],
    },
    run: (args) => saltCall(() => salt.listAccountPolicies(args.accountId)),
  });

  const getPolicy = betaTool({
    name: "get_policy",
    description: "Fetch a single policy by its id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { policyId: { type: "string" } },
      required: ["policyId"],
    },
    run: (args) => saltCall(() => salt.getAccountPolicy(args.policyId)),
  });

  const createPolicy = betaTool({
    name: "create_policy",
    description:
      "Create a new policy on an account. Shows the user the proposed policy and asks them to confirm before creating. One policy per (type, chain) — creating a duplicate fails.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: { type: "string" },
        type: {
          type: "string",
          enum: [
            "allowed_recipients",
            "denied_recipients",
            "denied_proposers",
            "transaction_limit_token_denominated",
            "contract_param_restriction",
          ],
          description: "Policy type. nominated_approvers cannot be created.",
        },
        chain: { type: "string", description: 'Chain ID string like "11155111", or "*" for all chains.' },
        params: {
          type: "object",
          description:
            "The params object matching the type: {recipients} for allowed/denied recipients & denied_proposers, {limits} for transaction_limit_token_denominated, {restrictions} for contract_param_restriction.",
        },
      },
      required: ["accountId", "type", "chain", "params"],
    },
    run: async (args) => {
      const label = accountLabel(accountNameById, args.accountId);
      p.note(
        `account: ${label}\ntype:    ${args.type}\nchain:   ${args.chain}\nparams:\n${jsonResult(args.params)}`,
        "Proposed new policy",
      );
      const ok = await p.confirm({ message: `Create this policy on ${label}?` });
      if (p.isCancel(ok) || !ok) return "User declined to create this policy.";
      return saltCall(() =>
        salt.createAccountPolicy({
          accountId: args.accountId,
          organisationId,
          type: args.type,
          chain: args.chain,
          params: args.params as never,
        }),
      );
    },
  });

  const updatePolicy = betaTool({
    name: "update_policy",
    description:
      "Replace a policy's params (full replacement, not a patch). Shows the user the before/after and asks them to confirm.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        policyId: { type: "string" },
        params: { type: "object", description: "The COMPLETE new params object — it fully replaces the existing params." },
      },
      required: ["policyId", "params"],
    },
    run: async (args) => {
      let current: { params?: unknown; type?: string; chain?: string; accountId?: string };
      try {
        current = await salt.getAccountPolicy(args.policyId);
      } catch (err) {
        return `ERROR fetching current policy: ${formatSaltError(err)}`;
      }
      const label = accountLabel(accountNameById, current.accountId ?? "");
      p.note(
        `account: ${label}\ntype:    ${current.type} (chain ${current.chain})\n\ncurrent params:\n${jsonResult(current.params)}\n\nnew params:\n${jsonResult(args.params)}`,
        "Proposed policy update",
      );
      const ok = await p.confirm({ message: `Apply this update on ${label}?` });
      if (p.isCancel(ok) || !ok) return "User declined to update this policy.";
      return saltCall(() => salt.updateAccountPolicy(args.policyId, args.params as never));
    },
  });

  const deletePolicy = betaTool({
    name: "delete_policy",
    description: "Delete a policy by id. Shows the user the policy and asks them to confirm.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { policyId: { type: "string" } },
      required: ["policyId"],
    },
    run: async (args) => {
      let current: { accountId?: string };
      try {
        current = await salt.getAccountPolicy(args.policyId);
      } catch (err) {
        return `ERROR fetching policy: ${formatSaltError(err)}`;
      }
      const label = accountLabel(accountNameById, current.accountId ?? "");
      p.note(`account: ${label}\n\n${jsonResult(current)}`, "Policy to delete");
      const ok = await p.confirm({ message: `Delete this policy on ${label}?` });
      if (p.isCancel(ok) || !ok) return "User declined to delete this policy.";
      return saltCall(async () => {
        await salt.deleteAccountPolicy(args.policyId);
        return { deleted: args.policyId };
      });
    },
  });

  const recordUnsupported = betaTool({
    name: "record_unsupported_policy_request",
    description:
      "Record a policy capability the user wants that Salt does not currently support, so the Salt team can review it. Shows the user the entry and asks them to confirm before writing it to docs/requested-policies.md.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Short title for the requested capability." },
        request: { type: "string", description: "What the user wants, in their terms." },
        reason_unsupported: { type: "string", description: "Why Salt can't do this today." },
      },
      required: ["title", "request", "reason_unsupported"],
    },
    run: async (args) => {
      const entry =
        `## ${args.title}\n\n` +
        `- **Requested:** ${new Date().toISOString().slice(0, 10)}\n` +
        `- **Request:** ${args.request}\n` +
        `- **Why unsupported:** ${args.reason_unsupported}\n\n`;
      p.note(entry.trim(), "Log this to docs/requested-policies.md");
      const ok = await p.confirm({ message: "Record this request?" });
      if (p.isCancel(ok) || !ok) return "User declined to record this request.";
      try {
        fs.appendFileSync(REQUESTED_POLICIES_FILE, entry);
        return `Recorded to docs/requested-policies.md (commit it to share with the Salt team).`;
      } catch (err) {
        return `ERROR writing file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return [listPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy, recordUnsupported];
}

export async function policyChatFlow(salt: Salt, _walletClient: SaltWalletClient): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    p.log.error(
      "Policy chat needs an Anthropic API key. Add ANTHROPIC_API_KEY=sk-ant-... to your .env (see .env.example) and restart.",
    );
    return;
  }

  const organisationId = await pickOrganisation(salt, "Manage policies in which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    p.log.error(formatSaltError(err));
    return;
  }

  // Only fully-set-up accounts have policies and can be acted on — accounts
  // whose MPC setup never completed (no evmAddress) are excluded entirely so
  // the agent never proposes changes against them.
  const usableAccounts = accounts.filter((a) => Boolean(a.evmAddress));
  if (usableAccounts.length === 0) {
    p.log.info("No fully-set-up accounts in this organisation to manage policies for.");
    return;
  }

  const accountNameById = new Map(usableAccounts.map((a) => [a.id, a.name]));
  const accountRoster = usableAccounts
    .map((a) => `- ${a.name} — id: ${a.id}, address: ${a.evmAddress}, signers: [${a.signers.join(", ")}]`)
    .join("\n");

  const anthropic = new Anthropic();
  const tools = buildTools({ salt, organisationId, accountNameById });
  const messages: BetaMessageParam[] = [];

  const contextBlock =
    `Organisation id: ${organisationId}\n` +
    `Accounts in this organisation (only fully-set-up accounts are listed and manageable):\n${accountRoster}\n\n` +
    `The user is a signer identified by their wallet; permission errors from the API mean they lack the required access.`;

  p.log.info('Policy chat — ask about or change this organisation\'s account policies. Type "exit" (or leave blank) to finish.');

  while (true) {
    const input = await p.text({ message: "You", placeholder: "e.g. what are my policies?" });
    if (p.isCancel(input)) break;
    const text = (input ?? "").trim();
    if (text === "" || text.toLowerCase() === "exit") break;

    messages.push({ role: "user", content: text });

    try {
      const runner = anthropic.beta.messages.toolRunner({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, { type: "text", text: contextBlock }],
        tools,
        messages,
      });

      for await (const message of runner) {
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim()) {
            p.log.message(block.text.trim());
          }
        }
      }

      // Persist the full accumulated turn (user msg + assistant turns + tool calls/results)
      // so context carries into the next message.
      messages.length = 0;
      messages.push(...(runner.params.messages as BetaMessageParam[]));
    } catch (err) {
      p.log.error(`Policy chat error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  p.log.info("Left policy chat.");
}
