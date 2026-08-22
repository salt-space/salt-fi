// Load .env first so a SALT_ENV / PRIVATE_KEY set there is visible below. Nothing
// that reads `network` (env/session/wallet/chains) is imported statically here —
// the app is imported dynamically only after the environment is chosen, so those
// modules resolve for the selected network.
import "dotenv/config";
import * as p from "@clack/prompts";

type SaltEnv = "testnet" | "mainnet";

/**
 * Decide which environment to run. An explicitly-set SALT_ENV (from the
 * dev:testnet / dev:mainnet scripts, or a line in .env) is respected without a
 * prompt; otherwise ask, defaulting to testnet and requiring an extra confirm
 * for mainnet since it moves real funds. Returns null if the user cancels.
 */
async function chooseEnv(): Promise<SaltEnv | null> {
  const preset = process.env.SALT_ENV?.toLowerCase();
  if (preset === "testnet" || preset === "mainnet") return preset;

  const choice = await p.select({
    message: "Which environment?",
    initialValue: "testnet" as SaltEnv,
    options: [
      { value: "testnet", label: "Testnet", hint: "test funds · testnet.salt.space" },
      { value: "mainnet", label: "Mainnet", hint: "⚠ REAL FUNDS · app.salt.space" },
    ],
  });
  if (p.isCancel(choice)) return null;

  if (choice === "mainnet") {
    const ok = await p.confirm({
      message: "Mainnet uses REAL funds and transactions are irreversible. Continue on mainnet?",
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) return null;
  }
  return choice;
}

async function main() {
  p.intro("salt-fi");

  const env = await chooseEnv();
  if (!env) {
    p.outro("Cancelled.");
    return;
  }
  process.env.SALT_ENV = env;

  // Import the app only now that SALT_ENV is fixed, so `network` resolves for the
  // chosen environment.
  const { runApp } = await import("./app.js");
  await runApp();
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
