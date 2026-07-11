import * as p from "@clack/prompts";
import { runMenu } from "./menu.js";
import { loadSalt } from "./session.js";
import { createSaltWalletClient } from "./wallet.js";

async function main() {
  p.intro("salt-fi");

  const walletClient = createSaltWalletClient();
  const s = p.spinner();
  s.start("Signing in");
  const salt = await loadSalt(walletClient);
  s.stop(`Signed in as ${walletClient.account.address}`);

  await runMenu(salt, walletClient);
  salt.disconnect();
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
