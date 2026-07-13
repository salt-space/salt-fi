import fs from "node:fs";
import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { reportError } from "../errors.js";
import type { SaltWalletClient } from "../wallet.js";

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";
}

/** Prepend an identifying comment header, keeping any shebang as the true first line. */
function withOrgHeader(script: string, organisationName: string, organisationId: string, roboName: string): string {
  const header = [
    `# Organisation: ${organisationName} (${organisationId})`,
    `# Robo Guardian host: ${roboName}`,
    `# Generated: ${new Date().toISOString()}`,
    "",
    "",
  ].join("\n");

  const shebangMatch = script.match(/^#!.*\n/);
  if (shebangMatch) {
    return script.slice(0, shebangMatch[0].length) + header + script.slice(shebangMatch[0].length);
  }
  return header + script;
}

export async function createOrganisationFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  const orgName = await p.text({
    message: "Organisation name",
    validate: (value) => (!value || value.trim().length === 0 ? "Name is required" : undefined),
  });
  if (p.isCancel(orgName)) return;

  const ownerName = await p.text({
    message: "Your display name within this organisation",
    validate: (value) => (!value || value.trim().length === 0 ? "Name is required" : undefined),
  });
  if (p.isCancel(ownerName)) return;

  const ownerRole = await p.text({
    message: "Your role label",
    placeholder: "e.g. CEO, Founder",
    validate: (value) => (!value || value.trim().length === 0 ? "Role is required" : undefined),
  });
  if (p.isCancel(ownerRole)) return;

  const confirmed = await p.confirm({
    message: `Create organisation "${orgName}" with you as owner?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Creating organisation");
  let organisation;
  try {
    organisation = await salt.createOrganisation({
      name: orgName,
      owner: { name: ownerName, address: selfAddress, role: ownerRole },
    });
    s.stop(`Organisation created: ${organisation.name} (${organisation._id})`);
  } catch (err) {
    s.stop("Failed to create organisation");
    reportError(err);
    return;
  }

  const setUpRobos = await p.confirm({
    message: "Set up Robo Guardians for this organisation now?",
  });
  if (p.isCancel(setUpRobos) || !setUpRobos) {
    p.log.info('You can set up Robo Guardians for this organisation later — there\'s just no menu item for that on an existing org yet, only as part of "Create organisation".');
    return;
  }

  await setUpRoboHost(salt, walletClient, organisation._id, organisation.name);
}

async function setUpRoboHost(
  salt: Salt,
  walletClient: SaltWalletClient,
  organisationId: string,
  organisationName: string,
): Promise<void> {
  const roboNameInput = await p.text({
    message: "Robo Guardian display name",
    defaultValue: `${organisationName} Robos`,
  });
  if (p.isCancel(roboNameInput)) return;
  const roboName = roboNameInput || `${organisationName} Robos`;

  const s = p.spinner();
  s.start("Registering robo host");
  let host;
  try {
    host = await salt.createRoboHost({
      name: roboName,
      organisationId,
      ownerAddress: walletClient.account.address,
    });
    s.stop("Robo host registered");
  } catch (err) {
    s.stop("Failed to register robo host");
    reportError(err);
    return;
  }

  // `userPublicKey` is only populated by a fresh authenticate() call — a
  // session restored from a cached token (the common case) won't have it.
  // Force a re-auth here since generateSetupScript needs it to encrypt the
  // robo's seed to the owner.
  if (!salt.userPublicKey) {
    const s2 = p.spinner();
    s2.start("Refreshing session to get your public key");
    try {
      await salt.authenticate(walletClient);
      s2.stop("Session refreshed");
    } catch (err) {
      s2.stop("Failed to refresh session");
      reportError(err);
      return;
    }
  }

  if (!salt.userPublicKey) {
    p.log.error("Could not determine your public key — can't generate the robo setup script.");
    return;
  }

  // Only the self-hosted install script is reliable right now. The AWS
  // CloudFormation path (RoboHost.generateCloudFormationUrl) is known-broken
  // for TESTNET as of this session (its template hardcodes the mainnet API
  // domain and Arbitrum One's chain ID instead of testnet's) — intentionally
  // not wired up here. Add it once that's fixed upstream.
  let script: string;
  try {
    script = host.generateSetupScript({ publicKey: salt.userPublicKey });
  } catch (err) {
    reportError(err);
    return;
  }

  const filename = `robo-setup-${slugify(organisationName)}-${organisationId}.sh`;
  fs.writeFileSync(filename, withOrgHeader(script, organisationName, organisationId, roboName), { mode: 0o600 });

  p.log.success(
    `Wrote ${filename} (contains a secret API key — already gitignored, treat it like a credential).\n\n` +
      "This is a one-shot, fully automated script — you don't need to install\n" +
      "Docker or anything else yourself first. Just get it onto whatever\n" +
      "machine will run your Robo Guardians (a VPS, a spare box, a cloud\n" +
      "instance — anything running Ubuntu or Debian) and run it as root:\n" +
      `  scp ${filename} root@<your-server>:~ && ssh root@<your-server> "chmod +x ~/${filename} && ~/${filename}"\n\n` +
      "See docs/robo-hosting/ in this repo for platform-specific walkthroughs\n" +
      "(e.g. how to do this with only a browser-based terminal, no scp).\n\n" +
      'Once it\'s running, use "Check robo status" here to confirm it connected.',
  );
}
