import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { env, network } from "./env.js";
import { findLedgerError } from "./ledger.js";
import { runMenu } from "./menu.js";
import { loadSalt } from "./session.js";
import { createSaltWalletClient, type SaltWalletClient } from "./wallet.js";
import { chooseDeskIdentity, type DeskIdentity } from "./desk/start.js";
import { fundingStep } from "./desk/funding.js";
import { readDeskState } from "./desk/state.js";

/**
 * Runs the app for the already-selected environment. Imported dynamically from
 * index.ts *after* SALT_ENV is fixed, so `network` (and everything that reads it
 * at module-load: session domain, shard chain, Send networks) resolves for the
 * chosen environment rather than the default.
 */
export async function runApp(): Promise<void> {
  // Name the environment plainly — mainnet moves real funds, so which network
  // you're on must never be something you have to guess.
  p.log.info(`Environment: ${network.label} · ${network.domain}`);
  if (network.saltEnv === "mainnet") {
    p.log.warn(
      "MAINNET — real funds. Transactions are irreversible; verify every address, amount and policy before confirming.",
    );
  }

  const onLedger = env.signer === "ledger";
  if (onLedger) {
    // Device prompts arrive mid-spinner, where a printed line would garble it — so
    // say once, up front, that the Ledger will ask.
    p.log.info(
      `Signing with your Ledger (${env.ledgerPath}). Keep it unlocked with the Ethereum app open: it asks you to ` +
        "confirm when signing in (unless a saved session is still valid) and once for each account ceremony (create, send, sign, swap…).",
    );
  }
  // No key in .env and no Ledger: sign in as a trading desk's owner (or set one up).
  let desk: DeskIdentity | undefined;
  if (!onLedger && !process.env.PRIVATE_KEY) {
    desk = await chooseDeskIdentity();
    if (!desk) {
      p.outro("Cancelled.");
      return;
    }
  }
  const signedIn = await signIn(onLedger, desk?.account);
  if (!signedIn) {
    p.outro("Cancelled.");
    return;
  }
  if (desk && !readDeskState(desk.desk)?.steps.funded) {
    await fundingStep(signedIn.salt, desk.desk, desk.account.address);
  }

  await runMenu(signedIn.salt, signedIn.walletClient);
  signedIn.salt.disconnect();
}

/**
 * Connect the signer and sign in. A Ledger can refuse — rejected on the device,
 * locked, unplugged, Ethereum app closed — so offer to try again instead of
 * exiting, defaulting to "no" after a rejection since that's usually deliberate.
 * Returns undefined if the person stops there.
 */
async function signIn(onLedger: boolean, deskAccount?: DeskIdentity["account"]): Promise<{ salt: Salt; walletClient: SaltWalletClient } | undefined> {
  // Created once and kept across retries: it holds the device connection.
  let walletClient: SaltWalletClient | undefined;
  while (true) {
    const s = p.spinner();
    s.start(`Signing in to ${network.label}${onLedger ? " (confirm on your Ledger if it asks)" : ""}`);
    try {
      walletClient ??= await createSaltWalletClient(deskAccount);
      const { salt, savedSession } = await loadSalt(walletClient);
      s.stop(`Signed in as ${walletClient.account.address} · ${network.label}${savedSession ? " (saved session)" : ""}`);
      return { salt, walletClient };
    } catch (err) {
      const ledgerError = findLedgerError(err);
      if (!ledgerError) {
        s.error("Sign-in failed");
        throw err;
      }
      s.error(ledgerError.rejected ? "Sign-in rejected on your Ledger" : ledgerError.message);
      const again = await p.confirm({ message: "Try again?", initialValue: !ledgerError.rejected });
      if (p.isCancel(again) || !again) return undefined;
    }
  }
}
