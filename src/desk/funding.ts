import * as p from "@clack/prompts";
import QRCode from "qrcode";
import type { Salt } from "salt-sdk";
import { createPublicClient, formatEther, http, parseEther } from "viem";
import { mainnet } from "viem/chains";
import { CREDITS_PER_USD, hourlyCredits } from "../aleph/client.js";
import { rpcUrl } from "../chains.js";
import { network } from "../env.js";
import { supportsFees } from "../fees.js";
import { getTokenPriceUsd, LIFI_NATIVE_TOKEN } from "../lifi.js";
import { oneLine } from "../prompts.js";
import { markStep } from "./state.js";

/**
 * The one manual step in setting up a trading desk: sending ETH to the owner's address on
 * Ethereum. It pays for setup, not trading: the Robo Guardian's VM (Aleph credits, bought with ETH
 * on Ethereum), Salt's fees (USDC, converted from part of the ETH) and gas. Trading funds go into
 * the account later, once the policies are approved.
 */

export interface BudgetLine {
  what: string;
  usd: number;
}

const GAS_AND_CONVERSION_USD = 5;
/** Aleph's price for the smallest VM when its API can't be reached (credits per hour, Oct 2026). */
const FALLBACK_HOURLY_CREDITS = 14_250;
const TRADES_COVERED = 50;
const MARGIN = 1.1;

/** What setup costs, in USD, from Aleph's live price and Salt's own fee terms. */
export async function setupBudget(salt: Salt): Promise<BudgetLine[]> {
  const perHour = await hourlyCredits().catch(() => FALLBACK_HOURLY_CREDITS);
  const lines: BudgetLine[] = [{ what: "Robo Guardian VM on Aleph Cloud, first month", usd: (perHour * 24 * 30) / CREDITS_PER_USD }];
  if (network.realFunds && supportsFees(salt)) {
    const terms = salt as unknown as { getFeeTerms(a: { for: string }): Promise<{ accepts: { amount: string }[] }> };
    const cheapest = async (op: string) => {
      const q = await terms.getFeeTerms({ for: op }).catch(() => undefined);
      const amounts = (q?.accepts ?? []).map((o) => Number(o.amount) / 1e6);
      return amounts.length ? Math.min(...amounts) : undefined;
    };
    const [create, tx] = await Promise.all([cheapest("createAccount"), cheapest("submitTx")]);
    if (create) lines.push({ what: "Salt's fee to create your account", usd: create });
    if (tx) lines.push({ what: `Salt's fees for your first ${TRADES_COVERED} trades`, usd: tx * TRADES_COVERED });
  }
  lines.push({ what: "Gas, and converting some ETH to USDC for Salt's fees", usd: GAS_AND_CONVERSION_USD });
  return lines;
}

/** The ETH to ask for: the budget at today's price, plus a margin, rounded up to 0.001 ETH. */
export function ethToAskFor(totalUsd: number, ethUsd: number): bigint {
  const eth = (totalUsd * MARGIN) / ethUsd;
  return parseEther((Math.ceil(eth * 1000) / 1000).toFixed(3));
}

const ethereum = createPublicClient({ chain: mainnet, transport: http(rpcUrl("1"), { timeout: 10_000, retryCount: 1 }) });

/** Show where and how much to send, then wait until it arrives. Returns true once funded. */
export async function fundingStep(salt: Salt, desk: string, address: `0x${string}`): Promise<boolean> {
  const s = p.spinner();
  s.start("Working out what setup costs");
  const [lines, ethUsd, balance] = await Promise.all([
    setupBudget(salt),
    getTokenPriceUsd(1, LIFI_NATIVE_TOKEN).catch(() => undefined),
    ethereum.getBalance({ address }).catch(() => undefined),
  ]);
  const total = lines.reduce((a, l) => a + l.usd, 0);
  if (!ethUsd) {
    s.stop("Couldn't get today's ETH price");
    p.log.warn("Try again in a minute: the amount to send depends on it.");
    return false;
  }
  const want = ethToAskFor(total, ethUsd);
  s.stop(`Setup costs about $${total.toFixed(2)}, which is ${formatEther(want)} ETH at $${ethUsd.toFixed(0)}/ETH (with a 10% margin)`);

  if (balance !== undefined && balance >= want) {
    p.log.success(`Your address already holds ${formatEther(balance)} ETH on Ethereum: enough.`);
    markStep(desk, "funded");
    return true;
  }

  p.note(lines.map((l) => `${l.what.padEnd(56)} $${l.usd.toFixed(2)}`).join("\n"), "What the ETH pays for");
  const qr = await QRCode.toString(address, { type: "terminal", small: true });
  console.log(`\n${qr}`);
  p.note(
    [
      `Send ${formatEther(want)} ETH to:`,
      "",
      `  ${address}`,
      "",
      "on the Ethereum network (also called Ethereum mainnet or ERC-20). The QR code above is",
      "the same address. Ways to do it in the US:",
      "  · Coinbase: buy ETH, then Send it to this address, network Ethereum",
      "  · Robinhood, PayPal or Venmo: buy ETH, then transfer it to an external wallet (Ethereum)",
      "  · any other wallet or exchange you already use",
      "",
      "This is setup money only. The money your agent trades with goes into your account later,",
      "after you've approved its policies.",
    ].join("\n"),
    "Fund your desk (the one step you do yourself)",
  );

  s.start(oneLine(`Waiting for ${formatEther(want)} ETH to arrive at ${address} (checking every 15 seconds; you can close this and come back)`));
  const deadline = Date.now() + 60 * 60_000;
  while (Date.now() < deadline) {
    const now = await ethereum.getBalance({ address }).catch(() => undefined);
    if (now !== undefined && now >= want) {
      s.stop(`Received: ${formatEther(now)} ETH on Ethereum`);
      markStep(desk, "funded");
      return true;
    }
    if (now !== undefined && now > 0n) s.message(oneLine(`Received ${formatEther(now)} of ${formatEther(want)} ETH so far; waiting for the rest`));
    await new Promise((r) => setTimeout(r, 15_000));
  }
  s.stop("Still waiting after an hour");
  p.log.info("Sign in to your desk again once it has arrived: setup picks up from here.");
  return false;
}
