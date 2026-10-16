import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { backupStatusLabel, verifyKeyshareBackup } from "../backup-status.js";
import { reportError } from "../errors.js";
import { approvingMessage, keyshareBackupSigner, UNUSED_APPROVAL_WARNING } from "../keyshare-backup.js";
import { findLedgerError } from "../ledger.js";
import { ACCESS_LEVEL_LABEL, pickOrganisation, renderSignerList, select } from "../prompts.js";
import { ensureSignerPublicKey } from "../session.js";
import { ensureSignerReachable, type SaltWalletClient } from "../wallet.js";

export async function listAccounts(salt: Salt): Promise<void> {
  const organisationId = await pickOrganisation(salt, "List accounts for which organisation?");
  if (!organisationId) return;

  const s = p.spinner();
  s.start("Fetching accounts");
  try {
    const accounts = await salt.getAccounts(organisationId);
    s.stop(`Found ${accounts.length} account(s)`);

    if (accounts.length === 0) {
      p.log.info("No accounts in this organisation yet.");
      return;
    }

    for (const account of accounts) {
      // `backupStatusLabel` reads the account's publicKey + keyshares map — the
      // typed replacement for the removed `keysharesBackedUp` response field.
      p.log.message(
        `${account.name}  (${account.id})\n  address: ${account.evmAddress ?? "pending setup"}\n  backup: ${backupStatusLabel(account)}`,
      );
    }
  } catch (err) {
    s.stop("Failed to fetch accounts");
    reportError(err);
  }
}

/** The Salt API's rules for an account name (UpdateAccountParams): trimmed, not blank, no angle brackets, at most 50 characters. */
export function accountNameProblem(raw: string | undefined): string | undefined {
  const name = (raw ?? "").trim();
  if (name.length === 0) return "Name is required";
  if (/[<>]/.test(name)) return "Names can't use angle brackets (< or >)";
  if ([...name].length > 50) return `That's ${[...name].length} characters; the limit is 50`;
  return undefined;
}

/**
 * Rename an account (`salt.updateAccount`). The API only lets an owner of the
 * organisation who is also one of the account's signers do it, so both are checked
 * first and named if missing. Free: renaming isn't a paid operation.
 */
export async function renameAccountFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Rename an account in which organisation?");
  if (!organisationId) return;
  const self = walletClient.account.address.toLowerCase();

  let accounts;
  let isOwner;
  try {
    const [list, { organisation }] = await Promise.all([salt.getAccounts(organisationId), salt.getOrganisationById(organisationId)]);
    accounts = list;
    isOwner = organisation.collaborators.some((m) => m.address.toLowerCase() === self && m.accessLevel === 1);
  } catch (err) {
    reportError(err);
    return;
  }
  if (accounts.length === 0) {
    p.log.info("No accounts in this organisation yet.");
    return;
  }

  const accountId = await select({
    message: "Which account?",
    options: accounts.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress ?? "pending setup" })),
  });
  if (p.isCancel(accountId)) return;
  const account = accounts.find((a) => a.id === accountId)!;

  const isSigner = account.signers.some((a) => a.toLowerCase() === self);
  if (!isOwner || !isSigner) {
    const missing = [!isOwner && "an owner of this organisation", !isSigner && `a signer on "${account.name}"`].filter(Boolean).join(" or ");
    p.log.warn(`Only an owner who is also one of the account's signers can rename it, and ${walletClient.account.address} isn't ${missing}.`);
    return;
  }

  const entered = await p.text({ message: "New name", initialValue: account.name, validate: accountNameProblem });
  if (p.isCancel(entered)) return;
  const name = entered.trim();
  if (name === account.name) {
    p.log.info("That's its current name; nothing to change.");
    return;
  }

  const go = await p.confirm({
    message: `Rename "${account.name}" (${account.evmAddress ?? account.id}) to "${name}"?`,
    initialValue: false,
  });
  if (p.isCancel(go) || !go) return;

  const s = p.spinner();
  s.start("Renaming");
  try {
    await salt.updateAccount(account.id, { name });
    const updated = await salt.getAccount(account.id);
    s.stop(updated.name === name ? `Renamed to "${updated.name}"` : `Sent, but the account still reads "${updated.name}"`);
  } catch (err) {
    s.stop("Rename failed");
    reportError(err);
  }
}

/**
 * What an account with `humans` human signers adds up to. Salt adds one Robo
 * Guardian fewer than the humans, and the threshold is the number of humans
 * (docs.salt.space, Accounts → Account configurations).
 */
export function describeConfiguration(humans: number): string {
  if (humans < 2 || humans > 4) return `${humans} human signers isn't a supported configuration (2 to 4, including you).`;
  const robos = humans - 1;
  return `+ ${robos} Robo Guardian${robos === 1 ? "" : "s"}: ${humans} of ${humans + robos} must sign`;
}

/** `preselectedOrganisationId` skips the org picker — used by the getting-started wizard, which already knows the org. */
export async function createAccountFlow(
  salt: Salt,
  walletClient: SaltWalletClient,
  preselectedOrganisationId?: string,
): Promise<void> {
  const organisationId = preselectedOrganisationId ?? (await pickOrganisation(salt, "Create an account in which organisation?"));
  if (!organisationId) return;

  const selfAddress = walletClient.account.address;

  let organisation;
  try {
    ({ organisation } = await salt.getOrganisationById(organisationId));
  } catch (err) {
    reportError(err);
    return;
  }

  const memberNameByAddress = new Map(
    organisation.collaborators.map((member) => [member.address.toLowerCase(), member.name || member.address]),
  );

  const otherActiveMembers = organisation.collaborators.filter(
    (member) => member.status === "Active" && member.address.toLowerCase() !== selfAddress.toLowerCase(),
  );

  const name = await p.text({
    message: "Account name",
    validate: (value) => (!value || value.trim().length === 0 ? "Name is required" : undefined),
  });
  if (p.isCancel(name)) return;

  let extraSigners: string[] = [];
  if (otherActiveMembers.length === 0) {
    p.log.info("No other active collaborators in this organisation to add as co-signers.");
  } else {
    // Nothing pre-ticked: each co-signer changes the account's configuration
    // (see describeConfiguration), so every one should be a deliberate choice.
    const selected = await p.multiselect({
      message: "Co-signers (space to tick, enter to confirm)",
      required: true,
      options: otherActiveMembers.map((member) => ({
        value: member.address,
        label: member.name || member.address,
        hint: ACCESS_LEVEL_LABEL[member.accessLevel] ?? String(member.accessLevel),
      })),
    });
    if (p.isCancel(selected)) return;
    extraSigners = selected;
  }

  const signers = [selfAddress, ...extraSigners];

  const signerNames = signers.map((address) =>
    address === selfAddress ? `You (${address})` : `${memberNameByAddress.get(address.toLowerCase()) ?? address} (${address})`,
  );
  const confirmed = await p.confirm({
    message: `Create account "${name}"?\n  ${signerNames.join("\n  ")}\n  ${describeConfiguration(signers.length)}`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  // Account creation backs up a keyshare, which needs the signer's public key. salt-sdk
  // 0.0.43 reads it from the session token, but older sessions may not carry it, so
  // re-authenticate if it's missing; otherwise the backup step fails with
  // "Cannot back up a keyshare without the owner public key".
  await ensureSignerPublicKey(salt, walletClient);

  const backup = keyshareBackupSigner(walletClient);
  const s = p.spinner();
  s.start("Starting account creation ceremony");
  let renudge: ReturnType<typeof setInterval> | undefined;
  let accountId: string | undefined;
  let keygenStarted = false;
  try {
    // Check the Ledger is there before Salt creates the account record: once that
    // exists it can't be deleted, and a missing device would leave it unfinished.
    await ensureSignerReachable();
    const ceremony = await salt.createAccount({
      name,
      organisationId,
      signers,
      signer: backup.walletClient,
    });
    accountId = ceremony.accountId;

    // Approve this signer's keyshare backup now, before keygen. The SDK only asks
    // for it once keygen has made the new keyshare, and rejecting it then on a
    // Ledger would throw that keyshare away (see keyshare-backup.ts).
    s.message(approvingMessage());
    await backup.approve(accountId);

    let allPresent = false;
    ceremony.on("presence", (event) => {
      allPresent = event.joined === event.total;
      s.message(`Waiting for signers: ${event.joined}/${event.total} joined`);
      p.log.message(renderSignerList(event.signers, selfAddress, memberNameByAddress));
    });
    ceremony.on("ready", () => {
      allPresent = true;
      s.message("All signers present, running keygen...");
    });
    ceremony.on("keygenCompleted", () => {
      s.message("Keygen complete, backing up keyshares...");
    });
    ceremony.on("keyshareBackedUp", () => {
      s.message("Keyshares backed up, finalising...");
    });

    // The initial createAccount fires one nudge. Re-nudge periodically so a
    // signer or robo that wasn't listening at kickoff — and starts listening
    // late — still gets pulled into the huddle. nudge() with no args targets
    // exactly the not-yet-present signers (host excluded); once everyone's in,
    // allPresent flips and we stop.
    renudge = setInterval(() => {
      if (allPresent) return;
      try {
        const nudged = ceremony.nudge();
        if (nudged.length > 0) {
          p.log.info(`Re-nudging ${nudged.length} signer(s) not yet joined...`);
        }
      } catch {
        // transient — the next tick will retry
      }
    }, 15_000);

    keygenStarted = true;
    const { account } = await ceremony.wait();
    const approvalUsed = backup.release(accountId);
    // publicKey/evmAddress can lag the ceremony result by a moment (the account is
    // created — it has an id — but finalization propagates a beat later). Poll getAccounts
    // until it's finalized so we display the real address instead of `undefined`/`null`.
    let finalized = account;
    for (let i = 0; i < 12 && !(finalized.publicKey && finalized.evmAddress); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const accounts = await salt.getAccounts(organisationId);
      finalized = accounts.find((a) => a.id === account.id) ?? finalized;
    }
    s.stop("Account created");
    p.log.success(
      `${finalized.name}  (${finalized.id})\n  address: ${finalized.evmAddress ?? "(finalizing…)"}\n  public key: ${finalized.publicKey ?? "(finalizing…)"}\n  backup: ${backupStatusLabel(finalized)}`,
    );
    if (!approvalUsed) p.log.warn(UNUSED_APPROVAL_WARNING);
  } catch (err) {
    if (accountId && !keygenStarted && findLedgerError(err)) {
      s.stop("Account creation stopped before keygen — no keys were generated");
      reportError(err);
      p.log.info(
        "Salt keeps the unfinished account record, and your co-signers were already nudged, " +
          "so they may see a setup that never completes. Run Create account again when you're ready.",
      );
    } else {
      s.stop("Account creation failed");
      reportError(err);
    }
  } finally {
    if (renudge) clearInterval(renudge);
  }
}

/**
 * Verify an account's keyshare backup — the *active* check. Where {@link listAccounts}
 * reads the passive backed-up signal off the account object (publicKey + keyshares),
 * this asks Salt to actually exercise the shares via `verifyAccount`, proving the
 * account is recoverable. This is the reliable replacement for the removed
 * `keysharesBackedUp` API field.
 */
export async function verifyAccountBackupFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Verify a backup in which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return;
  }

  // Only finalized accounts (publicKey set) can be verified.
  const verifiable = accounts.filter((account) => Boolean(account.publicKey));
  if (verifiable.length === 0) {
    p.log.info("No finalized accounts in this organisation to verify.");
    return;
  }

  const accountId = await select({
    message: "Verify which account's backup?",
    options: verifiable.map((account) => ({
      value: account.id,
      label: account.name,
      hint: `${account.evmAddress ?? account.id} · ${backupStatusLabel(account)}`,
    })),
  });
  if (p.isCancel(accountId)) return;

  const account = verifiable.find((a) => a.id === accountId);
  if (!account) return;

  const s = p.spinner();
  s.start("Verifying keyshare backup (running recovery + regular signing)");
  const ok = await verifyKeyshareBackup(salt, account.id, walletClient);
  s.stop(ok ? "Backup verified" : "Backup verification failed");
  if (ok) {
    p.log.success(`${account.name} is backed up and recoverable — its keyshares produce a valid signature.`);
  } else {
    p.log.error(`Could not verify ${account.name}'s backup. Confirm you're a signer on this account, then retry.`);
  }
}
