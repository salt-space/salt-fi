import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import {
  type Address,
  createPublicClient,
  formatUnits,
  http,
  parseUnits,
  type PublicClient,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID } from "../chains.js";
import { reportError } from "../errors.js";
import { pickOrganisation } from "../prompts.js";
import {
  encodeApprove,
  encodeExactInputSingle,
  ERC20_ABI,
  KNOWN_TOKENS_BY_CHAIN,
  quoteBestFee,
  UNISWAP_V3_BY_CHAIN,
} from "../uniswap.js";
import type { SaltWalletClient } from "../wallet.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAINSTREAM_SYMBOLS = new Set(["USDC", "USDT", "DAI", "WETH", "WBTC", "MATIC", "POL"]);

const STAGE_LABEL: Record<string, string> = {
  proposing: "proposing...",
  signing: "signing...",
  broadcasting: "broadcasting...",
  confirming: "waiting to be mined...",
};

interface SubmitParams {
  accountId: string;
  to: string;
  value: bigint;
  data: string;
  chainId: number;
  userAddress: string;
  walletClient: SaltWalletClient;
  publicClient: PublicClient;
}

/**
 * Run a submitTx ceremony to completion with spinner progress, returning the
 * broadcast tx hash. Recovers from a local receipt-wait timeout by re-checking
 * the chain directly (the ceremony itself already broadcast) — same treatment
 * as send.ts. Re-throws on genuine failure.
 */
async function submitAndTrack(salt: Salt, params: SubmitParams, label: string): Promise<string | undefined> {
  const s = p.spinner();
  s.start(`${label}...`);
  try {
    const ceremony = await salt.submitTx(params);
    ceremony.on("stateChanged", (event) => {
      s.message(`${label} — ${STAGE_LABEL[event.stage] ?? `${event.stage}...`}`);
    });
    ceremony.on("presence", (event) => {
      s.message(`${label} — waiting for signers: ${event.joined}/${event.total} joined`);
    });
    const { transaction } = await ceremony.wait();
    s.stop(`${label} — complete`);
    return transaction.broadcastReceipt?.transactionHash;
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      const hashMatch = err.message.match(/hash "(0x[0-9a-fA-F]+)"/);
      if (hashMatch) {
        s.message(`${label} — local confirmation timed out, checking directly...`);
        try {
          const receipt = await params.publicClient.waitForTransactionReceipt({
            hash: hashMatch[1] as `0x${string}`,
            timeout: 120_000,
          });
          s.stop(`${label} — complete (confirmation was just slow)`);
          return receipt.transactionHash;
        } catch {
          // Fall through to failure.
        }
      }
    }
    s.stop(`${label} — failed`);
    throw err;
  }
}

export async function swapFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const choice = await p.select({
    message: "Which kind of swap?",
    options: [
      { value: "fast", label: "Fast swap (Uniswap v3)", hint: "immediate on-chain swap via the account" },
      { value: "slow", label: "Slow swap (Turbine)", hint: "coming soon" },
      { value: "__back", label: "Back" },
    ],
  });
  if (p.isCancel(choice) || choice === "__back") return;

  if (choice === "slow") {
    p.log.info("Slow swap (Turbine) is coming soon — it's pending a testnet endpoint from the Turbine team.");
    return;
  }

  await fastSwapFlow(salt, walletClient);
}

async function fastSwapFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  const organisationId = await pickOrganisation(salt, "Swap from which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return;
  }

  const eligibleAccounts = accounts.filter(
    (account) =>
      Boolean(account.evmAddress) &&
      account.signers.some((signer) => signer.toLowerCase() === selfAddress.toLowerCase()),
  );
  if (eligibleAccounts.length === 0) {
    p.log.info("No accounts here are both fully set up and ones you're a signer on.");
    return;
  }

  const accountId = await p.select({
    message: "Swap from which account?",
    options: eligibleAccounts.map((account) => ({ value: account.id, label: account.name, hint: account.evmAddress })),
  });
  if (p.isCancel(accountId)) return;
  const account = eligibleAccounts.find((a) => a.id === accountId)!;
  const accountAddress = account.evmAddress as Address;

  const chainId = await p.select({
    message: "On which chain?",
    options: Object.keys(UNISWAP_V3_BY_CHAIN).map((id) => ({ value: id, label: CHAIN_NAME_BY_ID[id] ?? id })),
  });
  if (p.isCancel(chainId)) return;
  const deployment = UNISWAP_V3_BY_CHAIN[chainId];
  const chainName = CHAIN_NAME_BY_ID[chainId] ?? chainId;
  const chain = CHAIN_BY_ID[chainId];
  const publicClient = createPublicClient({ chain, transport: http() });

  // --- sell token (from the account's own ERC-20 balances) ---
  const s = p.spinner();
  s.start("Fetching balances");
  let tokens;
  try {
    tokens = await salt.getAccountTokens(accountId, { raw: true, networks: [chainId] });
    s.stop(`Found ${tokens.length} token balance(s) on ${chainName}`);
  } catch (err) {
    s.stop("Failed to fetch balances");
    reportError(err);
    return;
  }

  const sellable = tokens.filter(
    (token) =>
      token.balance > 0n &&
      token.address.toLowerCase() !== NATIVE_ADDRESS &&
      MAINSTREAM_SYMBOLS.has(token.symbol.toUpperCase()),
  );
  if (sellable.length === 0) {
    p.log.info(
      `No swappable ERC-20 balances on ${chainName}. (Fast swap is ERC-20 → ERC-20 for now — native ${chain.nativeCurrency.symbol} isn't supported yet; wrap it to W${chain.nativeCurrency.symbol} first.)`,
    );
    return;
  }

  const sellIndex = await p.select({
    message: "Swap which asset?",
    options: sellable.map((token, index) => ({
      value: index,
      label: token.symbol,
      hint: formatUnits(token.balance, token.decimals),
    })),
  });
  if (p.isCancel(sellIndex)) return;
  const sellToken = sellable[sellIndex];
  const sellAddress = sellToken.address as Address;
  const maxSellFormatted = formatUnits(sellToken.balance, sellToken.decimals);

  // --- buy token (curated list for the chain, minus the sell token, or manual) ---
  const MANUAL = "__manual";
  const known = (KNOWN_TOKENS_BY_CHAIN[chainId] ?? []).filter((t) => t.address.toLowerCase() !== sellAddress.toLowerCase());
  const buyChoice = await p.select({
    message: "Swap into which asset?",
    options: [
      ...known.map((t) => ({ value: t.address as string, label: t.symbol, hint: t.address })),
      { value: MANUAL, label: "Other token (enter address)" },
    ],
  });
  if (p.isCancel(buyChoice)) return;

  let buyAddress: Address;
  if (buyChoice === MANUAL) {
    const manual = await p.text({
      message: "Token address to buy",
      validate: (v) => (!v || !ADDRESS_PATTERN.test(v) ? "Enter a valid 0x-prefixed address" : undefined),
    });
    if (p.isCancel(manual)) return;
    buyAddress = manual as Address;
  } else {
    buyAddress = buyChoice as Address;
  }
  if (buyAddress.toLowerCase() === sellAddress.toLowerCase()) {
    p.log.error("Buy and sell tokens must be different.");
    return;
  }

  let buyDecimals: number;
  let buySymbol: string;
  try {
    buyDecimals = await publicClient.readContract({ address: buyAddress, abi: ERC20_ABI, functionName: "decimals" });
    buySymbol =
      known.find((t) => t.address.toLowerCase() === buyAddress.toLowerCase())?.symbol ??
      `${buyAddress.slice(0, 6)}…${buyAddress.slice(-4)}`;
  } catch (err) {
    p.log.error(`Couldn't read that token (is it an ERC-20 on ${chainName}?): ${(err as Error).message}`);
    return;
  }

  // --- amount + slippage ---
  const amountInput = await p.text({
    message: `Amount of ${sellToken.symbol} to swap (available: ${maxSellFormatted})`,
    placeholder: maxSellFormatted,
    validate: (value) => {
      if (!value) return "Amount is required";
      let parsed: bigint;
      try {
        parsed = parseUnits(value, sellToken.decimals);
      } catch {
        return "Not a valid amount";
      }
      if (parsed <= 0n) return "Amount must be greater than 0";
      if (parsed > sellToken.balance) return `Exceeds available balance (${maxSellFormatted} ${sellToken.symbol})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const amountIn = parseUnits(amountInput, sellToken.decimals);

  const slippageInput = await p.text({
    message: "Max slippage %",
    defaultValue: "0.5",
    validate: (v) => {
      if (v && Number.isNaN(Number(v))) return "Enter a number, e.g. 0.5";
      if (v && (Number(v) < 0 || Number(v) >= 100)) return "Must be between 0 and 100";
      return undefined;
    },
  });
  if (p.isCancel(slippageInput)) return;
  const slippageBps = BigInt(Math.round(Number(slippageInput || "0.5") * 100));

  // --- quote across fee tiers ---
  const quoteSpinner = p.spinner();
  quoteSpinner.start("Getting best quote");
  let quote;
  try {
    quote = await quoteBestFee(publicClient, deployment.quoterV2, { tokenIn: sellAddress, tokenOut: buyAddress, amountIn });
  } catch (err) {
    quoteSpinner.stop("Quote failed");
    reportError(err);
    return;
  }
  if (!quote) {
    quoteSpinner.stop("No quote available");
    p.log.info(`No Uniswap v3 liquidity for ${sellToken.symbol} → ${buySymbol} on ${chainName} at the standard fee tiers.`);
    return;
  }
  quoteSpinner.stop("Quote ready");

  const amountOutMinimum = (quote.amountOut * (10_000n - slippageBps)) / 10_000n;
  const feePct = (quote.fee / 10_000).toString();
  p.note(
    `Swap ${amountInput} ${sellToken.symbol} → ~${formatUnits(quote.amountOut, buyDecimals)} ${buySymbol}\n` +
      `  chain: ${chainName}\n` +
      `  fee tier: ${feePct}%\n` +
      `  min received (after ${slippageInput || "0.5"}% slippage): ${formatUnits(amountOutMinimum, buyDecimals)} ${buySymbol}`,
    "Fast swap",
  );
  const confirmed = await p.confirm({ message: "Execute this swap?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  const submitBase = {
    accountId,
    value: 0n,
    chainId: Number(chainId),
    userAddress: selfAddress,
    walletClient,
    publicClient,
  };

  try {
    // Approve the router for exactly amountIn if the current allowance is short.
    const allowance = await publicClient.readContract({
      address: sellAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [accountAddress, deployment.swapRouter02],
    });
    if (allowance < amountIn) {
      await submitAndTrack(
        salt,
        { ...submitBase, to: sellAddress, data: encodeApprove(deployment.swapRouter02, amountIn) },
        `Approving ${sellToken.symbol}`,
      );
    } else {
      p.log.step(`${sellToken.symbol} already approved — skipping approval.`);
    }

    const swapData = encodeExactInputSingle({
      tokenIn: sellAddress,
      tokenOut: buyAddress,
      fee: quote.fee,
      recipient: accountAddress,
      amountIn,
      amountOutMinimum,
    });
    const hash = await submitAndTrack(salt, { ...submitBase, to: deployment.swapRouter02, data: swapData }, "Swapping");

    p.log.success(
      `Swapped ${amountInput} ${sellToken.symbol} → ~${formatUnits(quote.amountOut, buyDecimals)} ${buySymbol} on ${chainName}\n` +
        (hash ? `  tx hash: ${hash}` : "  (no broadcast receipt yet)"),
    );
  } catch (err) {
    reportError(err);
  }
}
