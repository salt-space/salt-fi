import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { InsufficientPermissions, type Salt } from "salt-sdk";
import { network } from "../env.js";
import { reportError } from "../errors.js";
import { pickOrganisation } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

/** `preselectedOrganisationId` skips the org picker — used by the getting-started wizard, which already knows the org. */
export async function checkRoboStatusFlow(salt: Salt, preselectedOrganisationId?: string): Promise<void> {
  const organisationId = preselectedOrganisationId ?? (await pickOrganisation(salt, "Check robo status for which organisation?"));
  if (!organisationId) return;

  const s = p.spinner();
  s.start("Checking robo guardian status");
  try {
    const status = await salt.getRoboStatus({ organisationId });
    s.stop(status.isReachable ? "At least one robo guardian is online" : "No robo guardians are online");

    if (status.signers.length === 0) {
      p.log.info("No robo guardians are registered for this organisation.");
      return;
    }

    const lines = status.signers.map((signer) => `  ${signer.isOnline ? "✓ online " : "✗ offline"}  ${signer.address}`);
    p.log.message(`${status.onlineCount}/${status.signers.length} robo guardian(s) online:\n${lines.join("\n")}`);

    // Presence alone isn't enough: a host that hasn't completed 2FA activation
    // can't sign, even with every signer online. Surface that explicitly — it's
    // the usual reason keygen/signing fails with a RoboStatusError.
    if (status.active) {
      p.log.success("2FA activation: complete — these robos can sign.");
    } else {
      p.log.warn(
        "2FA activation: NOT complete — these robos cannot sign yet, even while online.\n" +
          'Run "Activate Robo Guardians" (Robo Guardians menu) to finish setup.',
      );
    }

    await reportSeedBackup(salt, organisationId);
  } catch (err) {
    s.stop("Failed to check robo status");
    reportError(err);
  }
}

/**
 * Completes 2FA activation for an organisation's robo host — the step that flips
 * a provisioned-but-inactive host to usable. Without it, robos connect and show
 * "online" but can't participate in keygen or signing, and ceremonies fail with
 * a RoboStatusError ("… host is not active. Activate your host via 2FA Flow").
 *
 * Owner action: signs a SIWE message embedding the host's setup OTP (proving
 * both wallet control and possession of the setup code). Single-use — the OTP is
 * consumed on success.
 *
 * `preselectedOrganisationId` skips the org picker (used by the getting-started wizard).
 */
export async function activateRoboFlow(
  salt: Salt,
  walletClient: SaltWalletClient,
  preselectedOrganisationId?: string,
): Promise<void> {
  const organisationId = preselectedOrganisationId ?? (await pickOrganisation(salt, "Activate Robo Guardians for which organisation?"));
  if (!organisationId) return;

  const s = p.spinner();
  s.start("Fetching robo host");
  let host: Awaited<ReturnType<Salt["getRoboHost"]>>;
  try {
    host = await salt.getRoboHost({ organisationId });
  } catch (err) {
    s.stop("Failed to fetch robo host");
    reportError(err);
    return;
  }

  if (!host) {
    s.stop("No robo host registered");
    p.log.info('No robo host for this organisation yet — set one up first ("Set up Robo Guardians").');
    return;
  }
  if (host.active) {
    s.stop("Already activated");
    p.log.success("This robo host has already completed 2FA activation — nothing to do.");
    return;
  }
  if (!host.otp) {
    s.stop("No setup code available");
    p.log.error(
      "This host record carries no setup OTP, so it can't be activated from here.\n" +
        'Re-run "Set up Robo Guardians" to reissue setup (safe if the host never connected).',
    );
    return;
  }

  // Activation consumes the setup OTP, and the setup script/CloudFormation use
  // that same OTP — so activating before the host has connected would leave you
  // unable to (re)provision it. Guard against that; the getting-started wizard
  // only reaches here after robos are online, so this bites only the standalone flow.
  if (host.signers.length === 0) {
    s.stop("Robo host hasn't connected yet");
    p.log.warn(
      "This robo host hasn't connected yet — and activation consumes the one-time\n" +
        "setup code that provisioning also needs. Provision it first (\"Set up Robo\n" +
        'Guardians"), wait until "Check robo guardians" shows it online, then activate.',
    );
    const anyway = await p.confirm({ message: "Activate anyway? (Only if the host is definitely already running.)", initialValue: false });
    if (p.isCancel(anyway) || !anyway) return;
  } else {
    s.stop("Robo host found (online, not yet activated)");
  }

  const confirmed = await p.confirm({
    message: "Complete 2FA activation now? You'll sign a message with your wallet to prove ownership.",
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s2 = p.spinner();
  s2.start("Activating robo host (signing the 2FA message)");
  try {
    const activated = await salt.activateRoboHost({ roboId: host.id, otp: host.otp }, walletClient);
    if (activated.active) {
      s2.stop("Robo host activated");
      p.log.success('Robo Guardians activated — they can now join keygen and signing. Confirm any time via "Check robo guardians".');
    } else {
      s2.stop("Activation submitted");
      p.log.warn("Activation was submitted but the host still reports inactive — re-check status shortly.");
    }
  } catch (err) {
    s2.stop("Activation failed");
    reportError(err);
  }
}

/**
 * Whether Salt holds this host's encrypted seed backup — the one thing that can rebuild the same
 * robos if their machine is lost. Only owners can read it, so for anyone else this says nothing.
 */
async function reportSeedBackup(salt: Salt, organisationId: string): Promise<void> {
  try {
    const host = await salt.getRoboHost({ organisationId });
    if (!host) return;
    const { seed } = await salt.getRoboHostSecrets({ roboId: host.id });
    if (seed) {
      p.log.success('Seed backup: held by Salt, encrypted to the owner\'s key. Save a copy with "Back up robo seed".');
    } else {
      p.log.warn("Seed backup: Salt has none for this host. If its machine is lost, these robos can't be rebuilt.");
    }
  } catch {
    // Not an owner, or not a privileged session: the backup isn't ours to see.
  }
}

/** The file "Back up robo seed" writes, in the working directory (gitignored). */
export const roboSeedBackupFilename = (organisationId: string) => `robo-seed-${organisationId}.json`;

/** What "Back up robo seed" saves: the encrypted seed, plus enough to tell whose robos it rebuilds. */
export function roboSeedBackup(o: {
  organisationId: string;
  roboId: string;
  roboName?: string | null;
  signers: string[];
  encryptedSeed: string;
  savedAt?: Date;
}) {
  return {
    environment: network.saltEnv,
    organisationId: o.organisationId,
    roboId: o.roboId,
    roboName: o.roboName ?? null,
    signers: o.signers,
    encryptedSeed: o.encryptedSeed,
    encryption: "ECIES to the organisation owner's public key; only that owner's private key decrypts it",
    savedAt: (o.savedAt ?? new Date()).toISOString(),
  };
}

/**
 * Robo Guardians → "Back up robo seed": saves the robo host's encrypted seed backup from Salt.
 *
 * The seed derives all of a host's signer keys. Setup encrypts it to the owner's public key and
 * uploads it, so with this file and the owner's private key the same robos (same signer addresses)
 * can be rebuilt on a new machine. salt-fi never decrypts it.
 */
export async function backUpRoboSeedFlow(salt: Salt, preselectedOrganisationId?: string): Promise<void> {
  const organisationId = preselectedOrganisationId ?? (await pickOrganisation(salt, "Back up the robo seed for which organisation?"));
  if (!organisationId) return;

  const s = p.spinner();
  s.start("Fetching the encrypted seed backup");
  let host: Awaited<ReturnType<Salt["getRoboHost"]>>;
  let seed: string | null;
  try {
    host = await salt.getRoboHost({ organisationId });
    if (!host) {
      s.stop("No robo host registered");
      p.log.info('This organisation has no Robo Guardians yet ("Set up Robo Guardians").');
      return;
    }
    ({ seed } = await salt.getRoboHostSecrets({ roboId: host.id }));
  } catch (err) {
    s.stop("Couldn't fetch the seed backup");
    if (err instanceof InsufficientPermissions) {
      p.log.error(`Only an organisation owner can read the seed backup, signed in on ${network.domain}.`);
    } else {
      reportError(err);
    }
    return;
  }

  if (!seed) {
    s.stop("No seed backup in Salt");
    p.log.warn(
      host.signers.length
        ? "Salt has no seed backup for this host, so if its machine is lost these robos can't be rebuilt."
        : "This host hasn't been set up yet; setup uploads the seed backup.",
    );
    return;
  }

  const file = roboSeedBackupFilename(organisationId);
  const backup = roboSeedBackup({ organisationId, roboId: host.id, roboName: host.name, signers: host.signers, encryptedSeed: seed });
  fs.writeFileSync(file, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
  s.stop(`Saved ${file}`);
  p.log.message(
    `Signers   ${host.signers.join(", ")}\n` +
      `File      ${path.resolve(file)} (readable only by you, gitignored)\n` +
      "Encrypted to your owner key: only that key's private key can decrypt it. Together they rebuild\n" +
      "these robos, with the same signer addresses, on a new machine, so keep the file somewhere safe.",
  );
}
