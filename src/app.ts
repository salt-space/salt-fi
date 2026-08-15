import * as p from "@clack/prompts";
import { network } from "./env.js";
import { runMenu } from "./menu.js";
import { loadSalt } from "./session.js";
import { createSaltWalletClient } from "./wallet.js";

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

  const walletClient = createSaltWalletClient();
  const s = p.spinner();
  s.start(`Signing in to ${network.label}`);
  const salt = await loadSalt(walletClient);
  s.stop(`Signed in as ${walletClient.account.address} · ${network.label}`);

  await runMenu(salt, walletClient);
  salt.disconnect();
}
