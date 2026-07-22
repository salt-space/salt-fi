import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { buildResolveLabel } from "../policies.js";
import { select } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";
import { createAccountFlow } from "./accounts.js";
import { createOrganisationFlow, setUpRoboHost } from "./create-organisation.js";
import { inviteMemberFlow } from "./organisations.js";
import { addPolicy } from "./policy-management.js";

const TOTAL_STEPS = 5;

/** A titled concept note framed as "Step n of 5" — teaches the concept, then the flow does it. */
function step(n: number, title: string, body: string): void {
  p.note(body, `Step ${n} of ${TOTAL_STEPS} · ${title}`);
}

type GateResult = "ready" | "exit";

/**
 * Poll until `poll().done`, showing the live status each tick (e.g. "1 of 2
 * collaborators active") so it's clear the gate is re-checking, not stuck. If
 * it hasn't happened within `timeoutMs`, offer to keep waiting or exit and
 * resume later — the wizard is resumable, so exiting loses nothing.
 */
async function waitForGate(
  poll: () => Promise<{ done: boolean; message: string }>,
  opts: { readyLabel: string; timeoutMs?: number },
): Promise<GateResult> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const safePoll = () => poll().catch(() => ({ done: false, message: "checking..." }));

  while (true) {
    const first = await safePoll();
    // Confirm even when it's already satisfied on the first check (e.g. the
    // invite was accepted during the previous step) — otherwise the wizard
    // jumps to the next step with no acknowledgement.
    if (first.done) {
      p.log.success(opts.readyLabel);
      return "ready";
    }

    const s = p.spinner();
    s.start(first.message);
    const deadline = Date.now() + timeoutMs;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const r = await safePoll();
      s.message(r.message);
      if (r.done) {
        done = true;
        break;
      }
    }
    if (done) {
      s.stop(opts.readyLabel);
      return "ready";
    }
    s.stop("Still waiting");

    const next = await select({
      message: "Not ready yet.",
      escAction: "exit and resume later",
      options: [
        { value: "wait", label: "Keep waiting" },
        { value: "exit", label: "Exit — I'll re-run this later to continue" },
      ],
    });
    if (p.isCancel(next) || next === "exit") return "exit";
  }
}

export async function gettingStartedFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  p.note(
    "Salt secures on-chain assets with MPC: no single key controls an account —\n" +
      "signing is shared between you and automated co-signers, and every transaction\n" +
      "is checked against your policies first.\n\n" +
      "This walks you through the five steps to a working, policy-protected account.",
    "Getting started with Salt",
  );

  // --- Step 1: Organisation -------------------------------------------------
  step(
    1,
    "Organisation",
    "An organisation holds your accounts and the policies that govern them.\n" + "You'll be its first owner.",
  );

  let organisationId: string | undefined;
  let ownedOrgs: Awaited<ReturnType<Salt["getOrganisations"]>> = [];
  try {
    ownedOrgs = (await salt.getOrganisations()).filter((org) =>
      org.members.some((m) => m.address.toLowerCase() === selfAddress.toLowerCase() && m.accessLevel === 1),
    );
  } catch {
    ownedOrgs = [];
  }

  if (ownedOrgs.length > 0) {
    const CREATE = "__create";
    const choice = await select({
      message: "You already own organisations — continue with one, or start fresh?",
      options: [
        { value: CREATE, label: "Create a new organisation" },
        ...ownedOrgs.map((org) => ({ value: org._id, label: org.name, hint: "continue setup" })),
      ],
    });
    if (p.isCancel(choice)) return;
    if (choice !== CREATE) organisationId = choice;
  }

  if (!organisationId) {
    organisationId = await createOrganisationFlow(salt, walletClient, { skipRoboSetup: true });
    if (!organisationId) return;
  }

  // --- Step 2: Collaborators ------------------------------------------------
  step(
    2,
    "Collaborators",
    "You add collaborators to your organisation\n" +
      "and give each an access level:\n\n" +
      "Owner\n" +
      "  full control of the org, its accounts\n" +
      "  and policies\n\n" +
      "Member\n" +
      "  can view (not edit) org accounts &\n" +
      "  policies. Can sign on accounts they're\n" +
      "  added to\n\n" +
      "Agent\n" +
      "  external co-signer, added to specific\n" +
      "  accounts\n\n" +
      "Collaborators must accept the invitation\n" +
      "before a new account can be created — an\n" +
      "account needs at least two active\n" +
      "collaborators.",
  );

  const activeCount = async () => {
    const { organisation } = await salt.getOrganisationById(organisationId!);
    return organisation.members.filter((m) => m.status === "Active").length;
  };

  if ((await activeCount()) < 2) {
    p.log.info("Only you are active so far. Invite someone, then wait for them to accept.");
    const invited = await inviteMemberFlow(salt, organisationId);
    // Escaping the invite should leave the wizard, not wait for an acceptance
    // that will never come.
    if (!invited) return;
    const gate = await waitForGate(
      async () => {
        const n = await activeCount();
        return { done: n >= 2, message: `Waiting for the invite to be accepted — ${n} of 2 collaborators active` };
      },
      { readyLabel: "Organisation has 2 or more collaborators" },
    );
    if (gate === "exit") return;
  } else {
    p.log.success("Organisation has 2 or more collaborators");
  }

  // An existing account means steps 3 and 4 are already done: you can't have
  // created one without the Robo Guardians being online for its keygen. So an
  // account short-circuits the robo gate below (robos being *offline right now*
  // is a runtime concern for transacting, not a setup step to block on).
  const setUpAccounts = async () => (await salt.getAccounts(organisationId!)).filter((a) => Boolean(a.evmAddress));
  let accounts = await setUpAccounts();
  const alreadyHasAccount = accounts.length > 0;

  const roboOnlineCount = async () => {
    try {
      return (await salt.getRoboStatus({ organisationId: organisationId! })).onlineCount;
    } catch {
      return 0;
    }
  };

  // --- Step 3: Robo Guardians -----------------------------------------------
  step(
    3,
    "Robo Guardians",
    "Now it's time to set up your automated\n" +
      "cosigners for policy enforcement. Robo\n" +
      "guardians hold a share of the signing\n" +
      "quorum on all accounts and only co-sign\n" +
      "transactions that pass your pre-configured\n" +
      "policies.",
  );

  if (alreadyHasAccount) {
    p.log.success("Already done — this organisation has Robo Guardians set up (an account exists).");
  } else if ((await roboOnlineCount()) > 0) {
    p.log.success("At least one Robo Guardian is already online.");
  } else {
    const roboSetUp = await setUpRoboHost(salt, walletClient, organisationId, ownedOrgs.find((o) => o._id === organisationId)?.name ?? "your organisation");
    // Escaping robo setup should leave the wizard entirely, not fall through to
    // polling for robos that were never set up.
    if (!roboSetUp) return;
    p.log.info("Once the host is running (script executed, or CloudFormation stack launched), the robos come online.");
    const gate = await waitForGate(
      async () => {
        const online = await roboOnlineCount();
        return { done: online > 0, message: `Waiting for a Robo Guardian to come online — ${online} online` };
      },
      { readyLabel: "A Robo Guardian is online" },
    );
    if (gate === "exit") return;
  }

  // --- Step 4: Account ------------------------------------------------------
  step(
    4,
    "Account",
    "An account is one address that works across every supported EVM chain — no\n" +
      "separate contract to deploy per network. Creating it runs a key-generation\n" +
      "ceremony between you and the Robo Guardians.",
  );

  if (alreadyHasAccount) {
    p.log.success(`You already have ${accounts.length} set-up account(s).`);
  } else {
    await createAccountFlow(salt, walletClient, organisationId);
    accounts = await setUpAccounts();
  }
  if (accounts.length === 0) {
    p.log.info("No account was created — re-run getting started when you're ready to finish.");
    return;
  }

  // --- Step 5: Policies -----------------------------------------------------
  step(
    5,
    "Policies",
    "Policies are the rules your Robo Guardians enforce before signing — a\n" +
      "whitelist of recipients, a per-transaction limit, a contract restriction.\n" +
      "Let's add your first one. (Owners only.)",
  );

  const account = accounts[0];
  let organisation;
  try {
    ({ organisation } = await salt.getOrganisationById(organisationId));
  } catch {
    organisation = { members: [] as { address: string; name?: string }[] };
  }
  const addFirst = await p.confirm({ message: `Add a policy to "${account.name}" now?` });
  if (!p.isCancel(addFirst) && addFirst) {
    await addPolicy(salt, account.id, organisationId, buildResolveLabel(accounts, organisation.members));
  }

  // --- Done -----------------------------------------------------------------
  p.note(
    "That's the full setup: organisation, collaborators, Robo Guardians, an\n" +
      "account, and a policy protecting it.\n\n" +
      'Next: fund the account ("Faucet for Salt accounts"), then Send or Swap.',
    "You're set up",
  );
}
