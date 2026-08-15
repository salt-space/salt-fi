import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { backupStatusLabel, verifyKeyshareBackup } from "../backup-status.js";
import { reportError } from "../errors.js";
import { ACCESS_LEVEL_LABEL, pickOrganisation, renderSignerList, select } from "../prompts.js";
import { ensureSignerPublicKey } from "../session.js";
import type { SaltWalletClient } from "../wallet.js";

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
    const selected = await p.multiselect({
      message: "Select additional co-signers (optional)",
      required: false,
      initialValues: [otherActiveMembers[0].address],
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

  const confirmed = await p.confirm({
    message: `Create account "${name}" with signers:\n  ${signers.join("\n  ")}`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  // Account creation backs up a keyshare, which needs the signer's public key. That key
  // is recovered during a live `authenticate()` and kept in memory on this Salt instance
  // — it is NOT carried by a session restored from a cached auth token. So re-authenticate
  // here if needed, otherwise the backup step fails with
  // "Cannot back up a keyshare without the owner public key".
  await ensureSignerPublicKey(salt, walletClient);

  const s = p.spinner();
  s.start("Starting account creation ceremony");
  let renudge: ReturnType<typeof setInterval> | undefined;
  try {
    const ceremony = await salt.createAccount({
      name,
      organisationId,
      signers,
      signer: walletClient,
    });

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

    const { account } = await ceremony.wait();
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
  } catch (err) {
    s.stop("Account creation failed");
    reportError(err);
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
