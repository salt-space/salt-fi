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

  // Raw wire-level nudge signal — fires when a nudge arrives, before the
  // auto-join machinery takes over. `ceremonyCompleted` (below) then reports
  // the finished join. Between them the user sees: nudge in -> setup joined.
  const unsubscribe = salt.subscribeToNudgeEvent((nudge) => {
    const kind =
      nudge.sessionType === "keygen"
        ? "account setup"
        : nudge.sessionType === "signing"
          ? "transaction signing"
          : nudge.sessionType === "sign-message"
            ? "message signing"
            : "ceremony";
    const target = nudge.accountId ? ` for account ${nudge.accountId}` : "";
    p.log.step(`Nudge received from ${nudge.from} — joining ${kind}${target}...`);
  });

  listener.on("ceremonyCompleted", (result) => {
    if (result?.account) {
      p.log.success(
        `Joined account setup: ${result.account.name}  (${result.account.id})\n  address: ${result.account.evmAddress}`,
      );
    } else {
      p.log.success("Joined a ceremony (account details weren't available to this signer).");
    }
  });

  listener.on("error", (err) => {
    p.log.error(`Nudge listener error: ${formatSaltError(err)}`);
  });

  p.log.info("Listening for account-setup nudges. Leave this running while a teammate creates an account naming you as a signer.");
  await p.text({ message: "Press Enter to stop listening" });

  unsubscribe();
  listener.disableNudgeListener();
  p.log.info("Stopped listening for nudges.");
}
