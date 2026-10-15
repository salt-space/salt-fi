import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { network } from "../env.js";
import { reportError } from "../errors.js";
import { isUsable, stashClear, stashCount, stashList, stashPrune } from "../fee-stash.js";
import {
  accountInfo,
  chainById,
  chainName,
  FEE_MODES,
  getFeeConfig,
  setFeeConfig,
  signBatch,
  type FeeConfig,
  type FeeMode,
  type FeeOperation,
  type FeeTermsLike,
} from "../fees.js";
import { pickOrganisation, select } from "../prompts.js";
import { readTokenBalance } from "../token-balances.js";
import type { SaltWalletClient } from "../wallet.js";

// The fee API only exists from salt-sdk 0.0.44; the menu only offers these flows there, and
// they reach it through a structural cast so the app still builds against 0.0.43.
type Quote = { description?: string; accepts: (FeeTermsLike & Record<string, unknown>)[] };
const getQuote = (salt: Salt, op: FeeOperation) =>
  (salt as unknown as { getFeeTerms(a: { for: FeeOperation }): Promise<Quote> }).getFeeTerms({ for: op });

const usdc = (raw: string) => `${formatUnits(BigInt(raw), 6)} USDC`;

const MODE_LABEL: Record<FeeMode, { label: string; hint: string }> = {
  signer: { label: "The signer's own wallet", hint: "your signing wallet pays from its own USDC" },
  wallet: { label: "A separate sponsor wallet", hint: "another funded wallet pays" },
  account: { label: "An existing Salt account", hint: "the account pays, co-signed in an MPC ceremony" },
  none: { label: "Nobody (no payer)", hint: "anything that costs a fee is refused" },
};

const OP_LABEL: Record<FeeOperation, string> = { createAccount: "account creation", submitTx: "transaction" };

/** One-line summary of the current setting, for menu hints. */
export function feeStatusLine(): string {
  const c = getFeeConfig();
  const chain = c.chainId === undefined ? "auto chain" : chainName(c.chainId);
  const stash = stashCount();
  return `${MODE_LABEL[c.mode].label.toLowerCase()} · ${c.presign ? "pre-signed" : "on 402"} · ${chain}${stash > 0 ? ` · ${stash} in stash` : ""}`;
}

export async function showFeeQuoteFlow(salt: Salt): Promise<void> {
  const s = p.spinner();
  s.start("Asking Salt what it charges");
  try {
    const [create, tx] = await Promise.all([getQuote(salt, "createAccount"), getQuote(salt, "submitTx")]);
    s.stop("Current fees");
    for (const [name, q] of [["Create an account", create], ["Submit a transaction", tx]] as const) {
      p.log.message(
        `${name}${q.description ? ` (${q.description})` : ""}\n` +
          q.accepts.map((o) => `  • ${chainName(o.chainId)} (${o.chainId}): ${usdc(o.amount)} → ${o.payTo}`).join("\n"),
      );
    }
  } catch (err) {
    s.stop("Couldn't read the fees");
    reportError(err);
  }
}

/**
 * Reads what `address` holds of the fee token on every chain Salt quotes, and says plainly
 * whether it can pay: a success line when it can, a warning with what to do when it can't.
 */
async function reportFunds(salt: Salt, who: string, address: string, selectedChainId?: number): Promise<boolean> {
  try {
    const [create, tx] = await Promise.all([getQuote(salt, "createAccount"), getQuote(salt, "submitTx")]);
    const lines: string[] = [];
    let canPay = false;
    for (const o of create.accepts) {
      const chain = o.chainId === undefined ? undefined : chainById(o.chainId);
      if (!chain) continue;
      const bal = await readTokenBalance(chain, o.asset as Address, address as Address);
      const txFee = tx.accepts.find((t) => t.chainId === o.chainId)?.amount;
      const createsN = bal / BigInt(o.amount);
      const txsN = txFee ? bal / BigInt(txFee) : 0n;
      if ((txsN > 0n || createsN > 0n) && (selectedChainId === undefined || selectedChainId === o.chainId)) canPay = true;
      // ✓ can pay for an account creation, ~ transactions only (below the creation fee), ✗ nothing
      const icon = createsN > 0n ? "✓" : txsN > 0n ? "~" : "✗";
      const capacity =
        createsN > 0n
          ? `enough for ${createsN} account creation(s) or ${txsN} transaction(s)`
          : txsN > 0n
            ? `${txsN} transaction(s) only; below the ${formatUnits(BigInt(o.amount), 6)} USDC an account creation costs`
            : "not enough for any fee";
      lines.push(`  ${icon} ${chainName(chain.id).padEnd(17)} ${formatUnits(bal, 6).padStart(8)} USDC  ${capacity}${selectedChainId === o.chainId ? "  ← selected" : ""}`);
    }
    const head = `${who} ${address}\n${lines.join("\n")}`;
    if (canPay) p.log.success(head);
    else p.log.warn(`${head}\n  Not funded for the chosen chain. Send it ${network.realFunds ? "USDC" : "testnet USDC"} on that chain (it needs no gas).`);
    return canPay;
  } catch (err) {
    p.log.warn(`${who} ${address}: couldn't read its USDC balance (${err instanceof Error ? err.message.slice(0, 80) : String(err)}).`);
    return false;
  }
}

export async function chooseFeePayerFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const current = getFeeConfig();
  const mode = await select<FeeMode>({
    message: `Who pays the fee? (now: ${MODE_LABEL[current.mode].label})`,
    initialValue: current.mode,
    options: FEE_MODES.map((m) => ({ value: m, ...MODE_LABEL[m] })),
  });
  if (p.isCancel(mode)) return;
  const patch: Partial<FeeConfig> = { mode };
  let payerAddress: string | undefined;
  let payerWho = "";

  if (mode === "wallet") {
    let key = current.sponsorKey;
    if (key) {
      const reuse = await p.confirm({ message: `Keep the sponsor wallet already set (${privateKeyToAccount(key).address})?` });
      if (p.isCancel(reuse)) return;
      if (!reuse) key = undefined;
    }
    if (!key) {
      const entered = await p.password({
        message: "Sponsor wallet private key (kept in memory for this session only)",
        validate: (v) => (/^0x[0-9a-fA-F]{64}$/.test(v ?? "") ? undefined : "Enter a 0x-prefixed 32-byte hex key"),
      });
      if (p.isCancel(entered)) return;
      key = entered as `0x${string}`;
    }
    patch.sponsorKey = key;
    payerAddress = privateKeyToAccount(key).address;
    payerWho = "Sponsor wallet";
  }

  if (mode === "account") {
    const organisationId = await pickOrganisation(salt, "Which organisation holds the paying account?");
    if (!organisationId) return;
    let accounts;
    try {
      const self = walletClient.account.address.toLowerCase();
      accounts = (await salt.getAccounts(organisationId)).filter((a) => Boolean(a.evmAddress) && a.signers.some((x) => x.toLowerCase() === self));
    } catch (err) {
      reportError(err);
      return;
    }
    if (accounts.length === 0) {
      p.log.warn("No fully set-up accounts in that organisation where you are a signer.");
      return;
    }
    const accountId = await select({ message: "Which account pays?", options: accounts.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress ?? "" })) });
    if (p.isCancel(accountId)) return;
    patch.accountId = accountId;
    const chosen = accounts.find((a) => a.id === accountId);
    payerAddress = chosen?.evmAddress;
    payerWho = `Salt account "${chosen?.name}"`;
    p.log.info("Each payment is an MPC signing ceremony on that account, co-signed by its Robo Guardians and you.");
  }

  if (mode !== "none") {
    try {
      const q = await getQuote(salt, "createAccount");
      const chain = await select<number | "auto">({
        message: "Pay on which chain?",
        initialValue: current.chainId ?? "auto",
        options: [
          { value: "auto", label: "Automatic", hint: "the payer's own chain if quoted, else the first" },
          ...q.accepts.map((o) => ({ value: o.chainId as number, label: chainName(o.chainId), hint: `chain ${o.chainId}` })),
        ],
      });
      if (p.isCancel(chain)) return;
      patch.chainId = chain === "auto" ? undefined : chain;
    } catch (err) {
      reportError(err);
    }
  }

  setFeeConfig(patch);
  p.log.success(`Fee payment: ${feeStatusLine()}`);
  if (mode === "signer") {
    payerAddress = walletClient.account.address;
    payerWho = "Signer";
  }
  if (mode !== "none" && payerAddress) await reportFunds(salt, payerWho, payerAddress, getFeeConfig().chainId);
}

export async function togglePresignFlow(): Promise<void> {
  const next = !getFeeConfig().presign;
  setFeeConfig({ presign: next });
  p.log.success(
    next
      ? "Pre-signing ON: the payment is signed up front, so each call is one request (no 402 and retry)."
      : "Pre-signing OFF: the call is tried first and the payment is signed in reply to the 402.",
  );
}

/** USDC balance of every wallet that could pay, on every chain Salt quotes. */
export async function feeBalancesFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const cfg = getFeeConfig();
  const who: { label: string; address: Address }[] = [{ label: "signer", address: walletClient.account.address }];
  if (cfg.sponsorKey) who.push({ label: "sponsor wallet", address: privateKeyToAccount(cfg.sponsorKey).address });
  if (cfg.mode === "account" && cfg.accountId) {
    const info = await accountInfo(salt, cfg.accountId);
    if (info.address) who.push({ label: "paying account", address: info.address as Address });
  }
  const s = p.spinner();
  s.start("Reading USDC balances");
  try {
    const q = await getQuote(salt, "createAccount");
    const lines: string[] = [];
    for (const o of q.accepts) {
      const chain = o.chainId === undefined ? undefined : chainById(o.chainId);
      if (!chain) continue;
      for (const w of who) {
        const bal = await readTokenBalance(chain, o.asset as Address, w.address);
        lines.push(`  ${chainName(chain.id).padEnd(17)} ${w.label.padEnd(15)} ${formatUnits(bal, 6).padStart(10)} USDC   ${w.address}`);
      }
    }
    s.stop("USDC balances (to pay a fee, the payer must hold at least the quoted amount)");
    p.log.message(lines.join("\n"));
  } catch (err) {
    s.stop("Couldn't read balances");
    reportError(err);
  }
}

/** The fields of a fee payment record this flow prints (a structural subset of the SDK's type). */
type FeePaymentLike = {
  status?: string;
  reason?: string;
  payer?: string;
  terms?: { amount?: string; network?: string };
  settlement?: { transactionHash?: string };
  failure?: { kind?: string };
};

export async function viewFeePaymentsFlow(salt: Salt): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Fee payments for which organisation?");
  if (!organisationId) return;
  try {
    const payments = await (salt as unknown as { getOrganisationFeePayments(id: string): Promise<FeePaymentLike[]> }).getOrganisationFeePayments(organisationId);
    if (payments.length === 0) return void p.log.info("No fee payments recorded for this organisation.");
    p.log.message(
      payments
        .slice(0, 15)
        .map((f) => {
          // `network` is a CAIP-2 id, e.g. "eip155:8453"
          const chainId = Number(String(f.terms?.network ?? "").split(":")[1]);
          const amount = f.terms?.amount ? usdc(f.terms.amount) : "?";
          return (
            `  ${String(f.status).padEnd(9)} ${String(f.reason).padEnd(16)} ${amount.padEnd(11)} ${chainName(Number.isNaN(chainId) ? undefined : chainId)}  payer ${f.payer}` +
            (f.settlement?.transactionHash ? `  tx ${f.settlement.transactionHash}` : "") +
            (f.failure?.kind ? `  ${f.failure.kind}` : "")
          );
        })
        .join("\n"),
    );
  } catch (err) {
    reportError(err);
  }
}

/** Sign a batch of fee authorisations now, to be spent one per later call. Signing is free; spending costs the fee. */
export async function presignBatchFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const cfg = getFeeConfig();
  if (cfg.mode === "none") return void p.log.warn('The payer is set to "Nobody". Choose who pays first, then pre-sign.');
  let quotes: Record<FeeOperation, Quote>;
  try {
    const [createAccount, submitTx] = await Promise.all([getQuote(salt, "createAccount"), getQuote(salt, "submitTx")]);
    quotes = { createAccount, submitTx };
  } catch (err) {
    return reportError(err);
  }
  const price = (op: FeeOperation) => {
    const q = quotes[op].accepts[0];
    return q ? usdc(q.amount) : "?";
  };
  const op = await select<FeeOperation>({
    message: "Pre-sign fees for which operation?",
    options: [
      { value: "submitTx", label: "Transactions", hint: `${price("submitTx")} each` },
      { value: "createAccount", label: "Account creations", hint: `${price("createAccount")} each` },
    ],
  });
  if (p.isCancel(op)) return;

  const entered = await p.text({
    message: "How many authorisations?",
    initialValue: "10",
    validate: (v) => (/^\d+$/.test(v ?? "") && Number(v) >= 1 && Number(v) <= 200 ? undefined : "Enter a whole number from 1 to 200"),
  });
  if (p.isCancel(entered)) return;
  const count = Number(entered);

  const mpc = cfg.mode === "account" ? " Each one is a full MPC ceremony on the paying account (a few seconds each), and its Robo Guardians must be online." : "";
  const ok = await p.confirm({
    message: `Sign ${count} ${OP_LABEL[op]} fee authorisation(s) as ${feeStatusLine().split(" · ")[0]}? Signing costs nothing; each one you later spend costs ${price(op)}.${mpc}`,
  });
  if (p.isCancel(ok) || !ok) return;

  const s = p.spinner();
  s.start(`Signing 0/${count}`);
  try {
    const r = await signBatch(salt, walletClient, op, count, {
      onProgress: (done, total, ms) => s.message(`Signed ${done}/${total} (${(ms / 1000).toFixed(1)}s for the last one)`),
    });
    s.stop(r.failed ? `Signed ${r.signed}/${count}, then stopped` : `Signed ${r.signed}/${count}`);
    const exp = r.expiresAt === undefined ? "no stated expiry" : `the earliest expires in ${Math.round((r.expiresAt - Date.now() / 1000) / 3600)}h`;
    (r.failed ? p.log.warn : p.log.success)(
      `${r.signed} ${OP_LABEL[op]} authorisation(s) now in the stash for ${r.who} (${exp}). ` +
        "Each create-account or transaction spends one automatically, falling back to the live payer when none match." +
        (r.failed ? `\nStopped: ${r.failed}` : ""),
    );
  } catch (err) {
    s.stop("Couldn't pre-sign");
    reportError(err);
  }
}

/** What is stashed, per payer, with the option to drop expired ones or clear everything. */
export async function viewStashFlow(): Promise<void> {
  const all = stashList();
  if (all.length === 0) return void p.log.info('The stash is empty. Use "Pre-sign a batch" to fill it.');
  const groups = new Map<string, { n: number; usable: number; earliest?: number }>();
  for (const e of all) {
    const key = `${OP_LABEL[e.operation]} · ${chainName(e.chainId)} · ${e.payerLabel} · ${usdc(e.amount)}`;
    const g = groups.get(key) ?? { n: 0, usable: 0 };
    g.n++;
    if (isUsable(e)) g.usable++;
    if (e.expiresAt !== undefined) g.earliest = Math.min(g.earliest ?? Infinity, e.expiresAt);
    groups.set(key, g);
  }
  p.log.message(
    [...groups.entries()]
      .map(
        ([k, g]) =>
          `  ${g.usable}/${g.n} usable  ${k}` +
          (g.earliest === undefined ? "" : `  (earliest expiry in ${Math.max(0, Math.round((g.earliest - Date.now() / 1000) / 3600))}h)`),
      )
      .join("\n") + `\n  Anyone holding these can spend them (.fee-stash.${network.saltEnv}.json, owner-only, gitignored). Keep them private.`,
  );
  const action = await select<"keep" | "prune" | "clear">({
    message: "What now?",
    options: [
      { value: "keep", label: "Leave the stash as it is" },
      { value: "prune", label: "Remove expired / nearly expired" },
      { value: "clear", label: "Clear all", hint: "unspent authorisations are simply discarded; they cost nothing" },
    ],
  });
  if (p.isCancel(action) || action === "keep") return;
  const n = action === "prune" ? stashPrune() : stashClear();
  p.log.success(`Removed ${n} authorisation(s).`);
}
