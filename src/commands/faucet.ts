import { exec } from "node:child_process";
import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { reportError } from "../errors.js";
import { pickOrganisation } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

// Alchemy's testnet faucet pages (verified to resolve) for the chains this app
// works with. Alchemy has no public faucet API, so the app can't dispense
// funds itself — it just hands the user the right URL + the address to paste.
const ALCHEMY_FAUCETS: { chainName: string; url: string }[] = [
  { chainName: "Ethereum Sepolia", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
  { chainName: "Arbitrum Sepolia", url: "https://www.alchemy.com/faucets/arbitrum-sepolia" },
  { chainName: "Base Sepolia", url: "https://www.alchemy.com/faucets/base-sepolia" },
  { chainName: "Polygon Amoy", url: "https://www.alchemy.com/faucets/polygon-amoy" },
];

/** Best-effort open a URL in the user's default browser; silent if it fails (the URL is printed anyway). */
function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
  exec(`${opener} "${url}"`, () => {});
}

export async function faucetFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  const organisationId = await pickOrganisation(salt, "Fund an account in which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return;
  }
  const usable = accounts.filter((account) => Boolean(account.evmAddress));

  const SELF = "__self";
  const target = await p.select({
    message: "Which address do you want to fund?",
    options: [
      ...usable.map((account) => ({ value: account.id, label: account.name, hint: account.evmAddress })),
      { value: SELF, label: "My signing wallet", hint: selfAddress },
    ],
  });
  if (p.isCancel(target)) return;
  const address = target === SELF ? selfAddress : (usable.find((account) => account.id === target)?.evmAddress as string);

  const faucetIndex = await p.select({
    message: "Which testnet?",
    options: ALCHEMY_FAUCETS.map((faucet, index) => ({ value: index, label: faucet.chainName })),
  });
  if (p.isCancel(faucetIndex)) return;
  const faucet = ALCHEMY_FAUCETS[faucetIndex];

  p.note(`Address to fund:\n  ${address}\n\nAlchemy faucet:\n  ${faucet.url}`, `Get ${faucet.chainName} testnet funds`);
  p.log.info(
    "Alchemy has no faucet API, so this can't be automated from here — open the URL, connect a wallet, and paste the " +
      "address above to receive ~0.1 test ETH.\nHeads-up: Alchemy requires the wallet you connect to hold a little ETH " +
      "and have real activity on Ethereum mainnet (an anti-bot check), so a brand-new wallet may be turned away.",
  );

  const open = await p.confirm({ message: "Open the faucet in your browser now?" });
  if (p.isCancel(open)) return;
  if (open) {
    openInBrowser(faucet.url);
    p.log.step("Opened the faucet in your default browser (paste the address above).");
  }
}
