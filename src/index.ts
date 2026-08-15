import * as p from "@clack/prompts";
import { network } from "./env.js";
import { runMenu } from "./menu.js";
import { loadSalt } from "./session.js";
import { createSaltWalletClient } from "./wallet.js";

async function main() {
  // Name the environment up front — the app talks to real funds on mainnet, so
  // which network you're on must never be something you have to guess.
  p.intro(`salt-fi · ${network.label} (${network.domain})`);
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

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
