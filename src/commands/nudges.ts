import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { formatSaltError, reportError } from "../errors.js";
import type { SaltWalletClient } from "../wallet.js";

export async function listenForNudgesFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const confirmed = await p.confirm({
    message: "Start listening for account-setup nudges? Any ceremony you're nudged for will be joined automatically.",
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  let listener;
  try {
    listener = await salt.listenToAccountNudges({
      signer: walletClient,
      autoJoin: true,
      resolveAccount: true,
    });
  } catch (err) {
    reportError(err);
    return;
  }

  listener.on("ceremonyCompleted", (result) => {
    if (result?.account) {
      p.log.success(
        `Joined account setup: ${result.account.name}  (${result.account.id})\n  address: ${result.account.evmAddress}`,
      );
    } else {
      p.log.info("A ceremony completed, but account details weren't available to this signer.");
    }
  });

  listener.on("error", (err) => {
    p.log.error(`Nudge listener error: ${formatSaltError(err)}`);
  });

  p.log.info("Listening for account-setup nudges. Leave this running while a teammate creates an account naming you as a signer.");
  await p.text({ message: "Press Enter to stop listening" });

  listener.disableNudgeListener();
  p.log.info("Stopped listening for nudges.");
}
