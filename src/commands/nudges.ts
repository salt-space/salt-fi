import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { formatSaltError, reportError } from "../errors.js";
import type { SaltWalletClient } from "../wallet.js";

export async function listenForNudgesFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const confirmed = await p.confirm({
    message: "Start listening for account-setup nudges? Any ceremony you're nudged for will be joined automatically.",
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  let listener;
  try {
    // autoJoin: false + manual join() so we get the real AccountCeremony for
    // keygen nudges — same class accounts.ts drives for the host — and can
    // show live "N of M joined -> keygen -> backup" progress. autoJoin: true
    // only reports one opaque completion event at the very end, so a joiner
    // sees nothing between "nudge received" and (if it ever fires) done,
    // which reads as the app never confirming the account was finished.
    listener = await salt.listenToAccountNudges({
      signer: walletClient,
      autoJoin: false,
      resolveAccount: true,
    });
  } catch (err) {
    reportError(err);
    return;
  }

  listener.on("nudgeReceived", async (event) => {
    if (event.kind === "keygen") {
      p.log.step(`Nudge received from ${event.nudge.from} — joining account setup...`);
      const s = p.spinner();
      s.start("Joining account setup ceremony");
      try {
        const ceremony = await event.join();
        ceremony.on("presence", (e) => {
          s.message(`Waiting for signers: ${e.joined}/${e.total} joined`);
        });
        ceremony.on("ready", () => {
          s.message("All signers present, running keygen...");
        });
        ceremony.on("keygenCompleted", () => {
          s.message("Keygen complete, backing up keyshares...");
        });
        ceremony.on("keyshareBackedUp", () => {
          s.message("Keyshares backed up, finalising...");
        });

        const result = await ceremony.wait();
        if (result?.account) {
          s.stop("Account setup complete");
          p.log.success(
            `Joined account setup: ${result.account.name}  (${result.account.id})\n  address: ${result.account.evmAddress}`,
          );
        } else {
          s.stop("Account setup complete");
          p.log.success("Joined account setup (account details weren't available to this signer).");
        }
      } catch (err) {
        s.stop("Account setup failed");
        p.log.error(`Failed to join account setup: ${formatSaltError(err)}`);
      }
      return;
    }

    // Signing / sign-message ceremonies only expose wait() to a joiner — no
    // intermediate progress events are available for these on the SDK side.
    const kind = event.kind === "signing" ? "transaction signing" : "message signing";
    p.log.step(`Nudge received from ${event.nudge.from} — joining ${kind}...`);
    try {
      const ceremony = await event.join();
      await ceremony.wait();
      p.log.success(`Joined and completed ${kind}.`);
    } catch (err) {
      p.log.error(`Failed to join ${kind}: ${formatSaltError(err)}`);
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
