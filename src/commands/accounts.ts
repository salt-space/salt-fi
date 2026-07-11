import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { reportError } from "../errors.js";
import type { SaltWalletClient } from "../wallet.js";

async function pickOrganisation(salt: Salt, message: string): Promise<string | undefined> {
  let organisations;
  try {
    organisations = await salt.getOrganisations();
  } catch (err) {
    reportError(err);
    return undefined;
  }

  if (organisations.length === 0) {
    p.log.info("You're not a member of any organisations yet.");
    return undefined;
  }

  const organisationId = await p.select({
    message,
    options: organisations.map((org) => ({ value: org._id, label: org.name })),
  });

  if (p.isCancel(organisationId)) return undefined;
  return organisationId;
}

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

export async function createAccountFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Create an account in which organisation?");
  if (!organisationId) return;

  const name = await p.text({
    message: "Account name",
    validate: (value) => (!value || value.trim().length === 0 ? "Name is required" : undefined),
  });
  if (p.isCancel(name)) return;

  const extraSigners = await p.text({
    message: "Additional co-signer addresses (comma-separated, optional)",
    placeholder: "0x1111...,0x2222...",
    defaultValue: "",
  });
  if (p.isCancel(extraSigners)) return;

  const signers = [
    walletClient.account.address,
    ...extraSigners
      .split(",")
      .map((address) => address.trim())
      .filter(Boolean),
  ];

  const confirmed = await p.confirm({
    message: `Create account "${name}" with signers:\n  ${signers.join("\n  ")}`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Starting account creation ceremony");
  try {
    const ceremony = await salt.createAccount({
      name,
      organisationId,
      signers,
      signer: walletClient,
    });

    ceremony.on("presence", (event) => {
      s.message(`Waiting for signers: ${event.joined}/${event.total} joined`);
    });
    ceremony.on("ready", () => {
      s.message("All signers present, running keygen...");
    });
    ceremony.on("keygenCompleted", () => {
      s.message("Keygen complete, backing up keyshares...");
    });
    ceremony.on("keyshareBackedUp", () => {
      s.message("Keyshares backed up, finalising...");
    });

    const { account } = await ceremony.wait();
    s.stop("Account created");
    p.log.success(`${account.name}  (${account.id})\n  address: ${account.evmAddress}\n  public key: ${account.publicKey}`);
  } catch (err) {
    s.stop("Account creation failed");
    reportError(err);
  }
}
