import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { createAccountFlow, listAccounts } from "./commands/accounts.js";
import { createOrganisationFlow } from "./commands/create-organisation.js";
import { manageInvitations } from "./commands/invitations.js";
import { listenForNudgesFlow } from "./commands/nudges.js";
import { inviteMemberFlow, listOrganisations, manageCollaboratorsFlow } from "./commands/organisations.js";
import { policyChatFlow } from "./commands/policy-chat.js";
import { checkRoboStatusFlow } from "./commands/robos.js";
import { sendTransactionFlow } from "./commands/send.js";
import { isAuthExpired } from "./errors.js";
import { clearStoredSession } from "./session.js";
import type { SaltWalletClient } from "./wallet.js";

const EXIT = "__exit" as const;

export async function runMenu(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  while (true) {
    const choice = await p.select({
      message: "What would you like to do?",
      options: [
        { value: "create-org", label: "Create organisation" },
        { value: "invite-member", label: "Invite collaborators" },
        { value: "manage-collaborators", label: "Manage collaborators" },
        { value: "invites", label: "Manage your invitations" },
        { value: "orgs", label: "List your organisations" },
        { value: "robo-status", label: "Check robo guardians" },
        { value: "create-account", label: "Create account" },
        { value: "listen-nudges", label: "Listen for account nudges" },
        { value: "accounts", label: "List accounts" },
        { value: "send", label: "Send assets" },
        { value: "policy-chat", label: "Policy chat" },
        { value: EXIT, label: "Exit" },
      ],
    });

    if (p.isCancel(choice) || choice === EXIT) {
      p.outro("Goodbye!");
      return;
    }

    try {
      switch (choice) {
        case "create-org":
          await createOrganisationFlow(salt, walletClient);
          break;
        case "invite-member":
          await inviteMemberFlow(salt);
          break;
        case "manage-collaborators":
          await manageCollaboratorsFlow(salt);
          break;
        case "invites":
          await manageInvitations(salt);
          break;
        case "orgs":
          await listOrganisations(salt, selfAddress);
          break;
        case "robo-status":
          await checkRoboStatusFlow(salt);
          break;
        case "create-account":
          await createAccountFlow(salt, walletClient);
          break;
        case "listen-nudges":
          await listenForNudgesFlow(salt, walletClient);
          break;
        case "accounts":
          await listAccounts(salt);
          break;
        case "send":
          await sendTransactionFlow(salt, walletClient);
          break;
        case "policy-chat":
          await policyChatFlow(salt, walletClient);
          break;
      }
    } catch (err) {
      if (isAuthExpired(err)) {
        clearStoredSession(selfAddress);
        p.log.error("Your session expired. Please restart the app to sign in again.");
        return;
      }
      throw err;
    }
  }
}
