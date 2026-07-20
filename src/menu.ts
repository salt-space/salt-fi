import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { createAccountFlow, listAccounts } from "./commands/accounts.js";
import { createOrganisationFlow, setUpRoboFlow } from "./commands/create-organisation.js";
import { faucetFlow } from "./commands/faucet.js";
import { gettingStartedFlow } from "./commands/getting-started.js";
import { manageInvitations } from "./commands/invitations.js";
import { listenForNudgesFlow } from "./commands/nudges.js";
import { inviteMemberFlow, listOrganisations, manageCollaboratorsFlow } from "./commands/organisations.js";
import { policyChatFlow } from "./commands/policy-chat.js";
import { policyManagementFlow } from "./commands/policy-management.js";
import { checkRoboStatusFlow } from "./commands/robos.js";
import { sendTransactionFlow } from "./commands/send.js";
import { swapFlow } from "./commands/swap.js";
import { isAuthExpired } from "./errors.js";
import { select } from "./prompts.js";
import { clearStoredSession } from "./session.js";
import type { SaltWalletClient } from "./wallet.js";

const EXIT = "__exit" as const;
type Action = () => Promise<void>;
type MenuEntry = { value: string; label: string; hint?: string; run: Action };
type Outcome = "ok" | "exit-app";

export async function runMenu(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  // Run a flow, translating an expired session into a clean app exit (the one
  // error that can't be recovered mid-session — everything else bubbles up).
  const execute = async (action: Action): Promise<Outcome> => {
    try {
      await action();
      return "ok";
    } catch (err) {
      if (isAuthExpired(err)) {
        clearStoredSession(selfAddress);
        p.log.error("Your session expired. Please restart the app to sign in again.");
        return "exit-app";
      }
      throw err;
    }
  };

  // A grouped submenu that loops until Esc (back to the top menu).
  const openSubmenu = async (title: string, entries: MenuEntry[]): Promise<Outcome> => {
    while (true) {
      const choice = await select({
        message: title,
        options: entries.map(({ value, label, hint }) => ({ value, label, hint })),
      });
      if (p.isCancel(choice)) return "ok";
      const entry = entries.find((e) => e.value === choice);
      if (entry && (await execute(entry.run)) === "exit-app") return "exit-app";
    }
  };

  const groups: Record<string, { title: string; entries: MenuEntry[] }> = {
    org: {
      title: "Organisation",
      entries: [
        { value: "create-org", label: "Create organisation", run: () => createOrganisationFlow(salt, walletClient).then(() => {}) },
        { value: "invite-member", label: "Invite collaborators", run: () => inviteMemberFlow(salt) },
        { value: "manage-collaborators", label: "Manage collaborators", run: () => manageCollaboratorsFlow(salt) },
        { value: "invites", label: "Manage your invitations", run: () => manageInvitations(salt) },
        { value: "orgs", label: "List your organisations", run: () => listOrganisations(salt, selfAddress) },
      ],
    },
    robos: {
      title: "Robo Guardians",
      entries: [
        { value: "robo-setup", label: "Set up Robo Guardians", run: () => setUpRoboFlow(salt, walletClient) },
        { value: "robo-status", label: "Check robo guardians", run: () => checkRoboStatusFlow(salt) },
      ],
    },
    accounts: {
      title: "Accounts",
      entries: [
        { value: "create-account", label: "Create account", run: () => createAccountFlow(salt, walletClient) },
        { value: "accounts", label: "List accounts", run: () => listAccounts(salt) },
        { value: "listen-nudges", label: "Listen for account nudges", run: () => listenForNudgesFlow(salt, walletClient) },
      ],
    },
    assets: {
      title: "Assets",
      entries: [
        { value: "faucet", label: "Faucet for Salt accounts", run: () => faucetFlow(salt) },
        { value: "send", label: "Send assets", run: () => sendTransactionFlow(salt, walletClient) },
        { value: "swap", label: "Swap assets", run: () => swapFlow(salt, walletClient) },
      ],
    },
    policies: {
      title: "Policies",
      entries: [
        { value: "manage-policies", label: "Manage policies", run: () => policyManagementFlow(salt, walletClient) },
        { value: "policy-chat", label: "Policy chat", run: () => policyChatFlow(salt, walletClient) },
      ],
    },
  };

  while (true) {
    const choice = await select({
      message: "What would you like to do?",
      escAction: "exit",
      options: [
        { value: "getting-started", label: "Getting started", hint: "guided first-time setup" },
        { value: "org", label: "Organisation ▸" },
        { value: "robos", label: "Robo Guardians ▸" },
        { value: "accounts", label: "Accounts ▸" },
        { value: "assets", label: "Assets ▸" },
        { value: "policies", label: "Policies ▸" },
        { value: EXIT, label: "Exit" },
      ],
    });

    if (p.isCancel(choice) || choice === EXIT) {
      p.outro("Goodbye!");
      return;
    }

    const outcome =
      choice === "getting-started"
        ? await execute(() => gettingStartedFlow(salt, walletClient))
        : await openSubmenu(groups[choice].title, groups[choice].entries);

    if (outcome === "exit-app") return;
  }
}
