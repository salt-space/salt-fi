import * as p from "@clack/prompts";
import type { Policy, PolicyCheck, Salt } from "salt-sdk";
import { type Address, type PublicClient } from "viem";
import { formatSaltError, txHashFromError } from "../errors.js";
import { explainBreach, explainNotEvaluated, policyCheckGasFields, policyCheckParams, policyHeadline } from "../policies.js";
import type { SaltWalletClient } from "../wallet.js";

/**
 * Shared transaction pre-flight + submission helpers, used by any flow that
 * submits an account transaction via a Salt MPC ceremony (Swap, Bridge, …).
 * Extracted from the swap flow so cross-chain and same-chain flows share one
 * battle-tested policy check + ceremony tracker.
 */

const STAGE_LABEL: Record<string, string> = {
  proposing: "proposing...",
  signing: "signing...",
  broadcasting: "broadcasting...",
  confirming: "waiting to be mined...",
};

export interface SubmitParams {
  accountId: string;
  to: string;
  value: bigint;
  data: string;
  chainId: number;
  userAddress: Address;
  walletClient: SaltWalletClient;
  publicClient: PublicClient;
}

/**
 * Run a `submitTx` ceremony to completion with spinner progress, returning the
 * broadcast tx hash. Recovers from a local receipt-wait timeout by re-checking
 * the chain directly (the ceremony itself already broadcast). Re-throws on
 * genuine failure.
 */
export async function submitAndTrack(salt: Salt, params: SubmitParams, label: string): Promise<string | undefined> {
  const s = p.spinner();
  s.start(`${label}...`);
  try {
    const ceremony = await salt.submitTx(params);
    ceremony.on("stateChanged", (event) => {
      s.message(`${label} — ${STAGE_LABEL[event.stage] ?? `${event.stage}...`}`);
    });
    ceremony.on("presence", (event) => {
      s.message(`${label} — waiting for signers: ${event.joined}/${event.total} joined`);
    });
    const { transaction } = await ceremony.wait();
    s.stop(`${label} — complete`);
    return transaction.broadcastReceipt?.transactionHash;
  } catch (err) {
    // The ceremony broadcasts before it confirms, so an error here is usually a
    // receipt-lookup problem (slow / flaky / archive-gated RPC), not a failed tx.
    // If we can recover the broadcast hash the tx is already on-chain — return it
    // (never surface "failed") so the caller reports the hash instead of implying
    // nothing happened, which could trigger a dangerous re-submit.
    const hash = txHashFromError(err);
    if (hash) {
      s.message(`${label} — broadcast, confirming on-chain...`);
      try {
        const receipt = await params.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        s.stop(`${label} — complete`);
        return receipt.transactionHash;
      } catch {
        s.stop(`${label} — broadcast; confirm on the explorer`);
        return hash;
      }
    }
    s.stop(`${label} — failed`);
    throw err;
  }
}

/** A transaction a flow will submit, with the label to whitelist if a policy blocks its `to`. */
export interface PreflightTx {
  label: string;
  to: Address;
  /** Native value sent with the call, in wei — what native per-transaction limits read. */
  value: bigint;
  data: `0x${string}`;
  whitelistNickname: string;
}

/** The fixed context of a pre-check: who proposes, from which account, on which chain. */
export interface PreflightContext {
  accountId: string;
  /** The Salt account's own address — the `from` of every transaction it submits. */
  accountAddress: string;
  /** The signer proposing the transactions (the connected wallet). */
  selfAddress: string;
  chainId: string;
  isOwner: boolean;
  /** User-facing noun for the action ("swap", "bridge"), woven into the prompts. */
  operation: string;
}

type CheckResult = { tx: PreflightTx; check: PolicyCheck };

/**
 * Outcome of the policy pre-check:
 * - `clear`   — no breach (or an owner fixed the whitelist); ask the normal confirm.
 * - `proceed` — breach, but the user opted to submit anyway (already an explicit
 *               go-ahead, so skip the redundant confirm).
 * - `abort`   — cancelled; don't submit.
 */
export type PolicyDecision = "clear" | "proceed" | "abort";

function dedupeById(policies: Policy[]): Policy[] {
  const seen = new Set<string>();
  const out: Policy[] = [];
  for (const pol of policies) {
    if (!seen.has(pol.id)) {
      seen.add(pol.id);
      out.push(pol);
    }
  }
  return out;
}

/** Offer to submit despite a policy breach — it will very likely be rejected. */
async function promptProceedAnyway(operation: string): Promise<PolicyDecision> {
  const anyway = await p.confirm({
    message: `Try the ${operation} anyway? It will very likely be rejected — a Robo Guardian refuses to sign on a policy breach.`,
    initialValue: false,
  });
  return !p.isCancel(anyway) && anyway === true ? "proceed" : "abort";
}

const indent = (text: string, spaces: number): string =>
  text
    .split("\n")
    .map((line) => " ".repeat(spaces) + line)
    .join("\n");

/**
 * Every policy that bears on this operation: those evaluated, marked pass/fail,
 * then those on this chain that weren't — and so don't constrain it, which is
 * easy to assume they do (a token limit next to a swap of that token, say).
 */
function showPolicySummary(ctx: PreflightContext, results: CheckResult[], accountPolicies: Policy[] | undefined): void {
  const rejectedIds = new Set(results.flatMap((r) => r.check.rejectedPolicies.map((pol) => pol.id)));
  const evaluated = dedupeById(results.flatMap((r) => r.check.networkPolicies));
  const evaluatedIds = new Set(evaluated.map((pol) => pol.id));
  const unevaluated = (accountPolicies ?? []).filter(
    (pol) => (pol.chain === "*" || pol.chain === ctx.chainId) && !evaluatedIds.has(pol.id),
  );
  const lines = [
    ...evaluated.map((pol) => `${rejectedIds.has(pol.id) ? "✗" : "✓"} ${policyHeadline(pol)}`),
    ...unevaluated.map(
      (pol) => `– ${policyHeadline(pol)} — doesn't apply:\n${indent(explainNotEvaluated(pol, ctx.operation), 4)}`,
    ),
  ];
  if (lines.length > 0) p.note(lines.join("\n"), `Account policies for this ${ctx.operation}`);
}

/**
 * Each rejected policy, with why each transaction breaches it — worked out
 * locally from the policy's params where possible, so the report says "amount
 * must be ≤ X; this call has Y" rather than only naming the policy.
 */
function breachReport(ctx: PreflightContext, results: CheckResult[]): string {
  const names = new Map(results.map(({ tx }) => [tx.to.toLowerCase(), tx.whitelistNickname]));
  names.set(ctx.selfAddress.toLowerCase(), "you");
  const resolveLabel = (address: string) => names.get(address.toLowerCase());

  return dedupeById(results.flatMap((r) => r.check.rejectedPolicies))
    .map((pol) => {
      const reasons = results
        .filter(({ check }) => check.rejectedPolicies.some((rejected) => rejected.id === pol.id))
        .flatMap(({ tx }) =>
          explainBreach(
            pol,
            { chainId: ctx.chainId, to: tx.to, value: tx.value, data: tx.data },
            { proposer: ctx.selfAddress, resolveLabel },
          ).map((why) => `${tx.label}: ${why}`),
        );
      return [`  • ${policyHeadline(pol)}`, ...reasons.map((why) => indent(why, 6))].join("\n");
    })
    .join("\n");
}

/**
 * Run Salt's policy check against each transaction a flow will submit and
 * surface the results: which policies pass or fail, why a failure fails, and
 * which of the account's policies on this chain don't constrain the operation
 * at all. The checks are built exactly as `submitTx` builds the transaction
 * record, so they evaluate what the Robo Guardians will.
 *
 * The common blocker is an allowed-recipients whitelist that doesn't include
 * the contract being called (e.g. the swap router or the bridge contract,
 * and/or a sell token being approved). An owner can add the missing addresses
 * inline; anyone else can proceed and see it fail. See {@link PolicyDecision}
 * for the outcomes.
 */
export async function resolvePolicies(salt: Salt, ctx: PreflightContext, txs: PreflightTx[]): Promise<PolicyDecision> {
  const { accountId, chainId, isOwner, operation } = ctx;
  const runChecks = async (): Promise<CheckResult[]> => {
    const [nonce, gasFields] = await Promise.all([
      salt.getAccountNonce(accountId, Number(chainId)),
      policyCheckGasFields(salt, Number(chainId)),
    ]);
    const out: CheckResult[] = [];
    // Each transaction is submitted once the one before it lands, so it takes the next nonce.
    for (const [i, tx] of txs.entries()) {
      const call = { chainId, to: tx.to, value: tx.value, data: tx.data };
      out.push({ tx, check: await salt.runPoliciesCheck(accountId, policyCheckParams(call, ctx.accountAddress, nonce + i, gasFields)) });
    }
    return out;
  };

  let results: CheckResult[];
  let accountPolicies: Policy[] | undefined;
  try {
    [results, accountPolicies] = await Promise.all([
      runChecks(),
      // Only needed to name the policies that *don't* apply — not worth failing the check over.
      salt.listAccountPolicies(accountId).catch(() => undefined),
    ]);
  } catch (err) {
    p.log.warn(`Couldn't check account policies (${(err as Error).message}). Proceeding without a policy check.`);
    return "clear";
  }

  showPolicySummary(ctx, results, accountPolicies);

  const rejected = dedupeById(results.flatMap((r) => r.check.rejectedPolicies));
  if (rejected.length === 0) return "clear";

  // Blockers other than the whitelist can't be auto-resolved here.
  if (rejected.some((pol) => pol.type !== "allowed_recipients")) {
    p.log.error(
      `This ${operation} is blocked by account policy:\n${breachReport(ctx, results)}\n` +
        'An owner can adjust these via "Manage policies".',
    );
    return promptProceedAnyway(operation);
  }

  // Only allowed-recipients blocks remain. A rejected tx's `to` is the address
  // that whitelist is missing — collect them per blocking policy.
  const fixes = new Map<string, { policy: Policy; additions: { address: string; nickname: string }[] }>();
  for (const { tx, check } of results) {
    for (const pol of check.rejectedPolicies) {
      if (pol.type !== "allowed_recipients") continue;
      const entry = fixes.get(pol.id) ?? { policy: pol, additions: [] };
      if (!entry.additions.some((a) => a.address.toLowerCase() === tx.to.toLowerCase())) {
        entry.additions.push({ address: tx.to, nickname: tx.whitelistNickname });
      }
      fixes.set(pol.id, entry);
    }
  }

  const neededList = [
    ...new Set([...fixes.values()].flatMap((f) => f.additions.map((a) => `${a.nickname} (${a.address})`))),
  ];
  p.log.warn(
    `This account has an allowed-recipients whitelist, and this ${operation} needs these addresses on it:\n` +
      neededList.map((x) => `  • ${x}`).join("\n"),
  );

  if (!isOwner) {
    p.log.info(
      "You're not an owner of this organisation, so you can't change the whitelist. Ask an owner to add the " +
        `addresses above ("Manage policies" → the allowed-recipients policy), then run the ${operation} again.`,
    );
    return promptProceedAnyway(operation);
  }

  const addNow = await p.confirm({ message: "You're an owner — add these to the whitelist now?" });
  if (p.isCancel(addNow)) return "abort";
  if (!addNow) return promptProceedAnyway(operation);

  const s = p.spinner();
  s.start("Updating whitelist");
  try {
    for (const { policy, additions } of fixes.values()) {
      const existing = (policy.params as { recipients?: { address: string; nickname?: string }[] }).recipients ?? [];
      const merged = [...existing];
      for (const add of additions) {
        if (!merged.some((r) => r.address.toLowerCase() === add.address.toLowerCase())) merged.push(add);
      }
      await salt.updateAccountPolicy(policy.id, { recipients: merged });
    }
    s.stop("Whitelist updated");
  } catch (err) {
    s.stop("Failed to update whitelist");
    p.log.error(formatSaltError(err));
    return promptProceedAnyway(operation);
  }

  // Re-check to confirm the operation is now allowed (e.g. in case another policy also applies).
  try {
    const recheck = await runChecks();
    if (recheck.some((r) => r.check.rejectedPolicies.length > 0)) {
      p.log.error(`Still blocked after the whitelist update:\n${breachReport(ctx, recheck)}`);
      return promptProceedAnyway(operation);
    }
  } catch {
    // Whitelist was updated; if the re-check errors, let the submit be the source of truth.
  }
  p.log.success(`Whitelist updated — the ${operation} is now allowed.`);
  return "clear";
}
