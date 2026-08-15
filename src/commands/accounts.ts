import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { reportError } from "../errors.js";
import { ACCESS_LEVEL_LABEL, pickOrganisation, renderSignerList } from "../prompts.js";
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
      p.log.message(`${account.name}  (${account.id})\n  address: ${account.evmAddress ?? "pending setup"}`);
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
    s.stop("Account created");
    p.log.success(`${account.name}  (${account.id})\n  address: ${account.evmAddress}\n  public key: ${account.publicKey}`);
  } catch (err) {
    s.stop("Account creation failed");
    reportError(err);
  } finally {
    if (renudge) clearInterval(renudge);
  }
}
