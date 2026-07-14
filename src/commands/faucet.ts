import { exec } from "node:child_process";
import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { reportError } from "../errors.js";
import { pickOrganisation } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

// Web faucets that fund brand-new addresses with NO Ethereum-mainnet balance or
// history requirement — the point being to top up freshly-created Salt accounts.
// (Alchemy and Chainlink native drips both gate on mainnet reputation, which a
// fresh MPC account can't satisfy, so they're deliberately not used here.)
//   - Circle drips USDC + native gas; one page, pick the chain there.
//   - Google Cloud drips native testnet ETH, per-chain URLs.
const CIRCLE_FAUCET = "https://faucet.circle.com/";
const GOOGLE_FAUCET_BY_CHAIN: { chainName: string; url: string }[] = [
  { chainName: "Ethereum Sepolia", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
  { chainName: "Arbitrum Sepolia", url: "https://cloud.google.com/application/web3/faucet/arbitrum/sepolia" },
  { chainName: "Base Sepolia", url: "https://cloud.google.com/application/web3/faucet/base/sepolia" },
  { chainName: "Polygon Amoy", url: "https://cloud.google.com/application/web3/faucet/polygon/amoy" },
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

  const chainIndex = await p.select({
    message: "Which testnet?",
    options: GOOGLE_FAUCET_BY_CHAIN.map((chain, index) => ({ value: index, label: chain.chainName })),
  });
  if (p.isCancel(chainIndex)) return;
  const chain = GOOGLE_FAUCET_BY_CHAIN[chainIndex];

  p.note(
    `Address to fund:\n  ${address}\n\n` +
      `USDC + native gas — Circle:\n  ${CIRCLE_FAUCET}\n  (select ${chain.chainName} on the page)\n\n` +
      `Native gas only — Google Cloud:\n  ${chain.url}`,
    `Fund on ${chain.chainName}`,
  );
  p.log.info(
    "Both of these fund brand-new accounts — no Ethereum-mainnet balance or history required. Open a faucet, paste the " +
      "address above, and request. (Circle also gives testnet USDC, handy for trying Send/Swap.)",
  );

  const open = await p.select({
    message: "Open a faucet in your browser?",
    options: [
      { value: "circle", label: "Circle (USDC + native gas)" },
      { value: "google", label: "Google Cloud (native gas only)" },
      { value: "none", label: "No — I'll copy the links above" },
    ],
  });
  if (p.isCancel(open) || open === "none") return;
  openInBrowser(open === "circle" ? CIRCLE_FAUCET : chain.url);
  p.log.step("Opened the faucet in your default browser — paste the address above.");
}
