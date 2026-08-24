import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { type Address, createPublicClient, formatUnits, http, parseUnits } from "viem";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID, explorerTxUrl, rpcUrl } from "../chains.js";
import { reportError } from "../errors.js";
import { pickOrganisation, select } from "../prompts.js";
import { fetchAccountTokens } from "../token-balances.js";
import {
  encodeApprove,
  encodeExactInputSingle,
  ERC20_ABI,
  KNOWN_TOKENS_BY_CHAIN,
  quoteBestFee,
  UNISWAP_V3_BY_CHAIN,
} from "../uniswap.js";
import { type PreflightTx, resolvePolicies, submitAndTrack } from "./tx-preflight.js";
import type { SaltWalletClient } from "../wallet.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAINSTREAM_SYMBOLS = new Set(["USDC", "USDT", "DAI", "WETH", "WBTC", "MATIC", "POL"]);

export async function swapFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const choice = await select({
    message: "Which kind of swap?",
    options: [
      { value: "fast", label: "Fast swap (Uniswap v3)", hint: "immediate on-chain swap via the account" },
      { value: "slow", label: "Slow swap (Turbine)", hint: "coming soon" },
    ],
  });
  if (p.isCancel(choice)) return;

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
  let organisation;
  try {
    [accounts, { organisation }] = await Promise.all([
      salt.getAccounts(organisationId),
      salt.getOrganisationById(organisationId),
    ]);
  } catch (err) {
    reportError(err);
    return;
  }

  const isOwner =
    organisation.collaborators.find((m) => m.address.toLowerCase() === selfAddress.toLowerCase())?.accessLevel === 1;

  const eligibleAccounts = accounts.filter(
    (account) =>
      Boolean(account.evmAddress) &&
      account.signers.some((signer) => signer.toLowerCase() === selfAddress.toLowerCase()),
  );
  if (eligibleAccounts.length === 0) {
    p.log.info("No accounts here are both fully set up and ones you're a signer on.");
    return;
  }

  const accountId = await select({
    message: "Swap from which account?",
    options: eligibleAccounts.map((account) => ({ value: account.id, label: account.name, hint: account.evmAddress })),
  });
  if (p.isCancel(accountId)) return;
  const account = eligibleAccounts.find((a) => a.id === accountId)!;
  const accountAddress = account.evmAddress as Address;

  const chainId = await select({
    message: "On which chain?",
    options: Object.keys(UNISWAP_V3_BY_CHAIN).map((id) => ({ value: id, label: CHAIN_NAME_BY_ID[id] ?? id })),
  });
  if (p.isCancel(chainId)) return;
  const deployment = UNISWAP_V3_BY_CHAIN[chainId];
  const chainName = CHAIN_NAME_BY_ID[chainId] ?? chainId;
  const chain = CHAIN_BY_ID[chainId];
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl(chainId)) });

  // --- sell token (from the account's own ERC-20 balances) ---
  const s = p.spinner();
  s.start("Fetching balances");
  let tokens;
  try {
    tokens = await fetchAccountTokens(accountAddress, { raw: true, networks: [chainId] });
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

  const sellIndex = await select({
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
  const buyChoice = await select({
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
    message: "Max slippage % (0.5 suggested for most pairs; raise it for thin/volatile pools)",
    defaultValue: "0.5",
    placeholder: "0.5",
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
  // Build the calldata + figure out whether an approval is needed, so the
  // policy check below evaluates the exact transactions we'll submit.
  const approveData = encodeApprove(deployment.swapRouter02, amountIn);
  const swapData = encodeExactInputSingle({
    tokenIn: sellAddress,
    tokenOut: buyAddress,
    fee: quote.fee,
    recipient: accountAddress,
    amountIn,
    amountOutMinimum,
  });

  let approveNeeded: boolean;
  try {
    const allowance = await publicClient.readContract({
      address: sellAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [accountAddress, deployment.swapRouter02],
    });
    approveNeeded = allowance < amountIn;
  } catch (err) {
    reportError(err);
    return;
  }

  const txs: PreflightTx[] = [
    ...(approveNeeded
      ? [{ label: `Approve ${sellToken.symbol}`, to: sellAddress, data: approveData, whitelistNickname: `${sellToken.symbol} token` }]
      : []),
    { label: "Swap", to: deployment.swapRouter02, data: swapData, whitelistNickname: "Uniswap SwapRouter02" },
  ];

  // Check the swap against the account's policies (whitelist, limits, contract
  // restrictions, denied proposers). Surfaces what applies; an owner can add a
  // missing whitelist entry inline; otherwise the user can proceed and see it
  // fail (the "proceed anyway" prompt is itself the go-ahead, so skip the
  // normal confirm in that case).
  const decision = await resolvePolicies(salt, accountId, selfAddress, chainId, isOwner, txs, "swap");
  if (decision === "abort") return;
  if (decision === "clear") {
    const confirmed = await p.confirm({ message: "Execute this swap?" });
    if (p.isCancel(confirmed) || !confirmed) return;
  }

  const submitBase = {
    accountId,
    value: 0n,
    chainId: Number(chainId),
    userAddress: selfAddress,
    walletClient,
    publicClient,
  };

  try {
    if (approveNeeded) {
      await submitAndTrack(salt, { ...submitBase, to: sellAddress, data: approveData }, `Approving ${sellToken.symbol}`);
    } else {
      p.log.step(`${sellToken.symbol} already approved — skipping approval.`);
    }

    const hash = await submitAndTrack(salt, { ...submitBase, to: deployment.swapRouter02, data: swapData }, "Swapping");

    p.log.success(
      `Swapped ${amountInput} ${sellToken.symbol} → ~${formatUnits(quote.amountOut, buyDecimals)} ${buySymbol} on ${chainName}\n` +
        (hash ? `  tx hash: ${hash}` : "  (no broadcast receipt yet)"),
    );
    if (hash) {
      const explorer = explorerTxUrl(chainId, hash);
      if (explorer) console.log(`  tx link: ${explorer}`);
    }
  } catch (err) {
    reportError(err);
  }
}
