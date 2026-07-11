import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { InvalidAuthToken } from "@kagamidigital/salt-sdk-mirror";
import { createAccountFlow, listAccounts } from "./commands/accounts.js";
import { manageInvitations } from "./commands/invitations.js";
import { listOrganisations } from "./commands/organisations.js";
import { clearStoredSession } from "./session.js";
import type { SaltWalletClient } from "./wallet.js";

const EXIT = "__exit" as const;

export async function runMenu(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  while (true) {
    const choice = await p.select({
      message: "What would you like to do?",
      options: [
        { value: "orgs", label: "List organisations" },
        { value: "invites", label: "Manage invitations" },
        { value: "accounts", label: "List accounts" },
        { value: "create-account", label: "Create account" },
        { value: EXIT, label: "Exit" },
      ],
    });

    if (p.isCancel(choice) || choice === EXIT) {
      p.outro("Goodbye!");
      return;
    }

    try {
      switch (choice) {
        case "orgs":
          await listOrganisations(salt, selfAddress);
          break;
        case "invites":
          await manageInvitations(salt);
          break;
        case "accounts":
          await listAccounts(salt);
          break;
        case "create-account":
          await createAccountFlow(salt, walletClient);
          break;
      }
    } catch (err) {
      if (err instanceof InvalidAuthToken) {
        clearStoredSession();
        p.log.error("Your session expired. Please restart the app to sign in again.");
        return;
      }
      throw err;
    }
  }
}
