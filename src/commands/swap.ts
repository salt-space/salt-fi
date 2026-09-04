import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { type Address, createPublicClient, formatUnits, http } from "viem";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID, explorerTxUrl, rpcUrl, SEND_NETWORK_IDS } from "../chains.js";
import { reportError } from "../errors.js";
import { fetchTokenPricesUsd, getQuote, type LifiQuote, LIFI_NATIVE_TOKEN, tokenPriceKey } from "../lifi.js";
import { pickOrganisation, promptTokenAmount, select } from "../prompts.js";
import { fetchAccountTokens, formatBalanceHint } from "../token-balances.js";
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
      { value: "aggregated", label: "Aggregated swap (LI.FI)", hint: "best route across DEXes; swaps native ETH too" },
      { value: "fast", label: "Fast swap (Uniswap v3)", hint: "direct Uniswap v3; ERC-20 → ERC-20 only" },
      { value: "slow", label: "Slow swap (Turbine)", hint: "coming soon" },
    ],
  });
  if (p.isCancel(choice)) return;

  if (choice === "slow") {
    p.log.info("Slow swap (Turbine) is coming soon — it's pending a testnet endpoint from the Turbine team.");
    return;
  }

  if (choice === "aggregated") {
    await aggregatedSwapFlow(salt, walletClient);
    return;
  }

  await fastSwapFlow(salt, walletClient);
}

/**
 * Same-chain swap routed through LI.FI's DEX aggregator (a quote where
 * `fromChain === toChain`). Unlike {@link fastSwapFlow} it aggregates across
 * DEXes for a better price AND supports swapping the native asset directly (no
 * wrap-to-WETH step). The signed `to`/`data`/`value` come verbatim from the
 * quote — we never build swap calldata ourselves.
 */
async function aggregatedSwapFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
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
    options: SEND_NETWORK_IDS.map((id) => ({ value: id, label: CHAIN_NAME_BY_ID[id] ?? id })),
  });
  if (p.isCancel(chainId)) return;
  const chainName = CHAIN_NAME_BY_ID[chainId] ?? chainId;
  const chain = CHAIN_BY_ID[chainId];
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl(chainId)) });

  // --- sell asset (native IS supported here, unlike fast swap) ---
  const s = p.spinner();
  s.start(`Fetching balances on ${chainName}`);
  let tokens;
  let prices = new Map<string, number>();
  try {
    tokens = await fetchAccountTokens(accountAddress, { raw: true, networks: [chainId] });
    prices = await fetchTokenPricesUsd(tokens.map((t) => ({ chainId: t.chainId, address: t.address })));
    s.stop(`Found ${tokens.length} balance(s) on ${chainName}`);
  } catch (err) {
    s.stop("Failed to fetch balances");
    reportError(err);
    return;
  }

  const sellable = tokens.filter(
    (t) => t.balance > 0n && (t.address.toLowerCase() === NATIVE_ADDRESS || MAINSTREAM_SYMBOLS.has(t.symbol.toUpperCase())),
  );
  if (sellable.length === 0) {
    p.log.info(`No swappable balances on ${chainName} (native ${chain.nativeCurrency.symbol} or a mainstream token).`);
    return;
  }

  const sellIndex = await select({
    message: "Swap which asset?",
    options: sellable.map((t, index) => ({
      value: index,
      label: t.symbol,
      hint: formatBalanceHint(t.balance, t.decimals, prices.get(tokenPriceKey(t.chainId, t.address))),
    })),
  });
  if (p.isCancel(sellIndex)) return;
  const sellToken = sellable[sellIndex];
  const sellIsNative = sellToken.address.toLowerCase() === NATIVE_ADDRESS;
  const sellParam = sellIsNative ? LIFI_NATIVE_TOKEN : (sellToken.address as Address);

  // --- buy token (curated list, native, or manual) ---
  const MANUAL = "__manual";
  const NATIVE = "__native";
  const known = (KNOWN_TOKENS_BY_CHAIN[chainId] ?? []).filter(
    (t) => t.address.toLowerCase() !== sellToken.address.toLowerCase(),
  );
  const buyChoice = await select({
    message: "Swap into which asset?",
    options: [
      ...known.map((t) => ({ value: t.address as string, label: t.symbol, hint: t.address })),
      ...(sellIsNative ? [] : [{ value: NATIVE, label: `${chain.nativeCurrency.symbol} (native)`, hint: "native currency" }]),
      { value: MANUAL, label: "Other token (enter address)" },
    ],
  });
  if (p.isCancel(buyChoice)) return;

  let buyParam: string;
  let buyLabel: string;
  if (buyChoice === NATIVE) {
    buyParam = LIFI_NATIVE_TOKEN;
    buyLabel = chain.nativeCurrency.symbol;
  } else if (buyChoice === MANUAL) {
    const manual = await p.text({
      message: "Token address to buy",
      validate: (v) => (!v || !ADDRESS_PATTERN.test(v) ? "Enter a valid 0x-prefixed address" : undefined),
    });
    if (p.isCancel(manual)) return;
    buyParam = manual;
    buyLabel = `${manual.slice(0, 6)}…${manual.slice(-4)}`;
  } else {
    buyParam = buyChoice;
    buyLabel = known.find((t) => t.address === buyChoice)?.symbol ?? buyChoice;
  }
  if (buyParam.toLowerCase() === sellParam.toLowerCase()) {
    p.log.error("Buy and sell tokens must be different.");
    return;
  }

  // --- amount + slippage ---
  const fromAmount = await promptTokenAmount({
    verb: "swap",
    symbol: sellToken.symbol,
    decimals: sellToken.decimals,
    maxRaw: sellToken.balance,
  });
  if (fromAmount === null) return;
  const amountInput = formatUnits(fromAmount, sellToken.decimals);
  if (sellIsNative && fromAmount === sellToken.balance) {
    p.log.warn(`Swapping your entire ${sellToken.symbol} balance — leave a little behind for gas or the tx will fail.`);
  }

  const slippageInput = await p.text({
    message: "Max slippage % (0.5 suggested)",
    defaultValue: "0.5",
    placeholder: "0.5",
    validate: (v) => {
      if (v && Number.isNaN(Number(v))) return "Enter a number, e.g. 0.5";
      if (v && (Number(v) < 0 || Number(v) >= 100)) return "Must be between 0 and 100";
      return undefined;
    },
  });
  if (p.isCancel(slippageInput)) return;
  const slippage = Number(slippageInput || "0.5") / 100;

  // --- quote (same-chain: fromChain === toChain) ---
  const quoteSpinner = p.spinner();
  quoteSpinner.start("Finding the best route");
  let quote: LifiQuote;
  try {
    quote = await getQuote({
      fromChain: Number(chainId),
      toChain: Number(chainId),
      fromToken: sellParam,
      toToken: buyParam,
      fromAmount,
      fromAddress: accountAddress,
      toAddress: accountAddress,
      slippage,
    });
    quoteSpinner.stop(`Route found via ${quote.toolDetails?.name ?? quote.tool}`);
  } catch (err) {
    quoteSpinner.stop("No route available");
    p.log.error((err as Error).message);
    return;
  }

  const toDecimals = quote.action.toToken.decimals;
  const toAmount = formatUnits(BigInt(quote.estimate.toAmount), toDecimals);
  const toAmountMin = formatUnits(BigInt(quote.estimate.toAmountMin), toDecimals);
  const totalFeesUsd = (quote.estimate.feeCosts ?? []).reduce((sum, f) => sum + (Number(f.amountUSD) || 0), 0);
  p.note(
    `Swap ${amountInput} ${sellToken.symbol} → ~${toAmount} ${buyLabel} on ${chainName}\n` +
      `  route: ${quote.toolDetails?.name ?? quote.tool}\n` +
      `  min received (after ${slippageInput || "0.5"}% slippage): ${toAmountMin} ${buyLabel}` +
      (totalFeesUsd > 0 ? `\n  fees: ~$${totalFeesUsd.toFixed(2)}` : ""),
    "Aggregated swap (LI.FI)",
  );

  // --- policy pre-check on the exact transactions we'll submit ---
  const swapTo = quote.transactionRequest.to;
  const swapData = quote.transactionRequest.data;
  const swapValue = BigInt(quote.transactionRequest.value ?? "0x0");

  // ERC-20 sources need an allowance to LI.FI's approvalAddress first; native doesn't.
  let approveData: `0x${string}` | undefined;
  if (!sellIsNative) {
    const approvalAddress = quote.estimate.approvalAddress as Address;
    try {
      const allowance = await publicClient.readContract({
        address: sellToken.address as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [accountAddress, approvalAddress],
      });
      if (allowance < fromAmount) approveData = encodeApprove(approvalAddress, fromAmount);
    } catch (err) {
      reportError(err);
      return;
    }
  }

  const txs: PreflightTx[] = [
    ...(approveData
      ? [{ label: `Approve ${sellToken.symbol}`, to: sellToken.address as Address, data: approveData, whitelistNickname: `${sellToken.symbol} token` }]
      : []),
    { label: "Swap", to: swapTo, data: swapData, whitelistNickname: `LI.FI (${quote.toolDetails?.name ?? quote.tool})` },
  ];

  const decision = await resolvePolicies(salt, accountId, selfAddress, chainId, isOwner, txs, "swap");
  if (decision === "abort") return;
  if (decision === "clear") {
    const confirmed = await p.confirm({ message: "Execute this swap?" });
    if (p.isCancel(confirmed) || !confirmed) return;
  }

  const submitBase = { accountId, chainId: Number(chainId), userAddress: selfAddress, walletClient, publicClient };
  try {
    if (approveData) {
      await submitAndTrack(
        salt,
        { ...submitBase, to: sellToken.address as string, value: 0n, data: approveData },
        `Approving ${sellToken.symbol}`,
      );
    }
    const hash = await submitAndTrack(salt, { ...submitBase, to: swapTo, value: swapValue, data: swapData }, "Swapping");
    p.log.success(
      `Swapped ${amountInput} ${sellToken.symbol} → ~${toAmount} ${buyLabel} on ${chainName}` +
        (hash ? `\n  tx hash: ${hash}` : "\n  (no broadcast receipt yet)"),
    );
    if (hash) {
      const explorer = explorerTxUrl(chainId, hash);
      if (explorer) console.log(`  tx link: ${explorer}`);
    }
  } catch (err) {
    reportError(err);
  }
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
  let prices = new Map<string, number>();
  try {
    tokens = await fetchAccountTokens(accountAddress, { raw: true, networks: [chainId] });
    prices = await fetchTokenPricesUsd(tokens.map((t) => ({ chainId: t.chainId, address: t.address })));
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
      hint: formatBalanceHint(token.balance, token.decimals, prices.get(tokenPriceKey(token.chainId, token.address))),
    })),
  });
  if (p.isCancel(sellIndex)) return;
  const sellToken = sellable[sellIndex];
  const sellAddress = sellToken.address as Address;

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
  const amountIn = await promptTokenAmount({
    verb: "swap",
    symbol: sellToken.symbol,
    decimals: sellToken.decimals,
    maxRaw: sellToken.balance,
  });
  if (amountIn === null) return;
  const amountInput = formatUnits(amountIn, sellToken.decimals);

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
