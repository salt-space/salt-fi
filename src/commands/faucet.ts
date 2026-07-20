import { exec } from "node:child_process";
import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID } from "../chains.js";
import { reportError } from "../errors.js";
import { pickOrganisation, select } from "../prompts.js";

// Web faucets that fund brand-new addresses with NO Ethereum-mainnet balance or
// history requirement — the point being to top up freshly-created Salt accounts.
// (Alchemy and Chainlink native drips both gate on mainnet reputation, which a
// fresh MPC account can't satisfy, so they're deliberately not used here.)
//   - Circle drips the gas token + USDC; one page, pick the chain there.
//   - Google Cloud drips the gas token only, per-chain URLs.
// Keyed by chain ID so the display name and gas-token symbol come from
// chains.ts rather than being duplicated here (Amoy's is POL, not ETH).
const CIRCLE_FAUCET = "https://faucet.circle.com/";
const GOOGLE_FAUCET_BY_CHAIN: { chainId: string; url: string }[] = [
  { chainId: "11155111", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
  { chainId: "421614", url: "https://cloud.google.com/application/web3/faucet/arbitrum/sepolia" },
  { chainId: "84532", url: "https://cloud.google.com/application/web3/faucet/base/sepolia" },
  { chainId: "80002", url: "https://cloud.google.com/application/web3/faucet/polygon/amoy" },
];

/** Best-effort open a URL in the user's default browser; silent if it fails (the URL is printed anyway). */
function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
  exec(`${opener} "${url}"`, () => {});
}

export async function faucetFlow(salt: Salt): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Fund an account in which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return;
  }

  // Deliberately Salt accounts only — the faucet is a reward for having got as
  // far as creating one, so the signing EOA isn't offered as a target.
  const usable = accounts.filter((account) => Boolean(account.evmAddress));
  if (usable.length === 0) {
    p.log.info(
      'No fully set-up Salt accounts in this organisation yet — create one with "Create account" first, then come back to fund it.',
    );
    return;
  }

  const target = await select({
    message: "Which Salt account do you want to fund?",
    options: usable.map((account) => ({ value: account.id, label: account.name, hint: account.evmAddress })),
  });
  if (p.isCancel(target)) return;
  const address = usable.find((account) => account.id === target)?.evmAddress as string;

  const chainIndex = await select({
    message: "Which testnet?",
    options: GOOGLE_FAUCET_BY_CHAIN.map((entry, index) => ({
      value: index,
      label: CHAIN_NAME_BY_ID[entry.chainId] ?? entry.chainId,
    })),
  });
  if (p.isCancel(chainIndex)) return;
  const chain = GOOGLE_FAUCET_BY_CHAIN[chainIndex];
  const chainName = CHAIN_NAME_BY_ID[chain.chainId] ?? chain.chainId;
  const gas = CHAIN_BY_ID[chain.chainId]?.nativeCurrency.symbol ?? "gas token";

  p.note(
    `${address}\n\n` +
      `Circle (${gas} + USDC):\n  ${CIRCLE_FAUCET}\n  select ${chainName} on the page\n\n` +
      `Google Cloud (${gas} only):\n  ${chain.url}`,
    `Fund on ${chainName}`,
  );

  const open = await select({
    message: "Open a faucet in your browser?",
    options: [
      { value: "circle", label: `Circle (${gas} + USDC)` },
      { value: "google", label: `Google Cloud (${gas} only)` },
      { value: "none", label: "No — I'll copy the links above" },
    ],
  });
  if (p.isCancel(open) || open === "none") return;
  openInBrowser(open === "circle" ? CIRCLE_FAUCET : chain.url);
  p.log.step("Opened the faucet in your default browser — paste the address above.");
}
