import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
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
  if (!host.provisioned) {
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
