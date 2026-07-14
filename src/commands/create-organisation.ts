import fs from "node:fs";
import * as p from "@clack/prompts";
import type { RoboHost, Salt } from "@kagamidigital/salt-sdk-mirror";
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

  const method = await p.select({
    message: "How do you want to set up this robo host?",
    options: [
      {
        value: "script",
        label: "Self-hosted install script",
        hint: "run yourself on any Ubuntu/Debian box — validated end-to-end",
      },
      {
        value: "cloudformation",
        label: "AWS CloudFormation (one-click launch)",
        hint: "opens a pre-filled AWS console URL — confirm with \"Check robo status\" once launched",
      },
    ],
  });
  if (p.isCancel(method)) return;

  if (method === "cloudformation") {
    await generateCloudFormationLink(host, organisationName, salt.userPublicKey);
    return;
  }

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
    `Wrote ${filename} (contains a secret OTP / one-time password — already gitignored, treat it like a credential).\n\n` +
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

/** Pull the region, template URL, and stack parameters back out of the SDK's generated URL. */
function parseCloudFormationUrl(url: string): { region?: string; templateUrl?: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  let region: string | undefined;
  let templateUrl: string | undefined;
  try {
    const parsed = new URL(url);
    region = parsed.searchParams.get("region") ?? undefined;
    // The quick-create bits live in the fragment: #/stacks/quickcreate?templateURL=...&param_X=Y
    const q = parsed.hash.indexOf("?");
    if (q >= 0) {
      const frag = new URLSearchParams(parsed.hash.slice(q + 1));
      templateUrl = frag.get("templateURL") ?? frag.get("templateUrl") ?? undefined;
      for (const [key, value] of frag) {
        if (key.startsWith("param_")) params[key.slice("param_".length)] = value;
      }
    }
  } catch {
    // Non-fatal — the URL itself is still printed for the user.
  }
  return { region, templateUrl, params };
}

async function generateCloudFormationLink(host: RoboHost, organisationName: string, publicKey: string): Promise<void> {
  const stackNameInput = await p.text({
    message: "CloudFormation stack name",
    defaultValue: `${slugify(organisationName)}-robos`,
    validate: (value) => (value && !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(value) ? "Letters, numbers, and hyphens only, starting with a letter" : undefined),
  });
  if (p.isCancel(stackNameInput)) return;
  const stackName = stackNameInput || `${slugify(organisationName)}-robos`;

  let url: string;
  try {
    url = host.generateCloudFormationUrl({ publicKey, stackName });
  } catch (err) {
    reportError(err);
    return;
  }

  const { region, templateUrl, params } = parseCloudFormationUrl(url);
  const manualLines: string[] = [];
  if (region) manualLines.push(`  Region:        ${region}`);
  if (templateUrl) manualLines.push(`  Template URL:  ${templateUrl}`);
  for (const [name, value] of Object.entries(params)) {
    manualLines.push(`  ${`${name}:`.padEnd(13)}${value}`);
  }

  p.log.success(
    "AWS CloudFormation — one-click launch\n\n" +
      "Open this URL while signed into the AWS console to launch a pre-filled stack\n" +
      "(installs Docker, generates and encrypts the robo's seed, and starts the\n" +
      "container automatically — no server access needed):\n\n" +
      `  ${url}\n\n` +
      "IMPORTANT: this is an AWS deep link, and AWS only keeps the pre-filled values\n" +
      "if your console is already loaded in the us-east-1 (N. Virginia) region. If it\n" +
      "has to switch region or refresh your sign-in first, it silently drops them and\n" +
      "leaves you on the empty CloudFormation page. If that happens, either open\n" +
      "CloudFormation in us-east-1 first and re-paste the URL, or create the stack by\n" +
      "hand (Create stack → With new resources → Amazon S3 URL) with these values:\n\n" +
      `${manualLines.join("\n")}\n\n` +
      'The "ApiKey" parameter above is the robo\'s OTP (one-time password) — a secret,\n' +
      "treat it like a password. (Salt's console still labels this field \"ApiKey\" for now.)\n\n" +
      'Once the stack finishes launching, use "Check robo status" here to confirm it\n' +
      "connected. See docs/robo-hosting/aws.md for details.",
  );
}
