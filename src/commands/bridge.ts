import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { type Address, createPublicClient, formatUnits, http, parseUnits } from "viem";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID, explorerTxUrl, rpcUrl, SEND_NETWORK_IDS } from "../chains.js";
import { reportError } from "../errors.js";
import { getQuote, getStatus, type LifiQuote, LIFI_NATIVE_TOKEN } from "../lifi.js";
import { pickOrganisation, select } from "../prompts.js";
import { fetchAccountTokens } from "../token-balances.js";
import { encodeApprove, ERC20_ABI, KNOWN_TOKENS_BY_CHAIN } from "../uniswap.js";
import { type PreflightTx, resolvePolicies, submitAndTrack } from "./tx-preflight.js";
import type { SaltWalletClient } from "../wallet.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Source assets we let people bridge (native + mainstream ERC-20s the account holds). */
const MAINSTREAM_SYMBOLS = new Set(["USDC", "USDT", "DAI", "WETH", "WBTC", "MATIC", "POL"]);
/** How long to follow the cross-chain leg before handing off to the explorer link. */
const STATUS_POLL_MS = 4_000;
const STATUS_TIMEOUT_MS = 5 * 60_000;

const usd = (v?: string) => (v && Number(v) > 0 ? `~$${Number(v).toFixed(2)}` : null);

/**
 * Bridge assets across chains via LI.FI. The account signs one source-chain
 * transaction through a Salt MPC ceremony; LI.FI's chosen bridge delivers the
 * destination token (and, optionally, a slice of native gas) on the other side.
 * We never build the bridge calldata ourselves — the signed `to`/`data`/`value`
 * come verbatim from LI.FI's quote — so this stays correct as routes change.
 */
export async function bridgeFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  const organisationId = await pickOrganisation(salt, "Bridge from which organisation?");
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
    message: "Bridge from which account?",
    options: eligibleAccounts.map((account) => ({ value: account.id, label: account.name, hint: account.evmAddress })),
  });
  if (p.isCancel(accountId)) return;
  const account = eligibleAccounts.find((a) => a.id === accountId)!;
  const accountAddress = account.evmAddress as Address;

  // --- source chain ---
  const fromChainId = await select({
    message: "Bridge FROM which chain?",
    options: SEND_NETWORK_IDS.map((id) => ({ value: id, label: CHAIN_NAME_BY_ID[id] ?? id })),
  });
  if (p.isCancel(fromChainId)) return;
  const fromChainName = CHAIN_NAME_BY_ID[fromChainId] ?? fromChainId;
  const fromChain = CHAIN_BY_ID[fromChainId];
  const publicClient = createPublicClient({ chain: fromChain, transport: http(rpcUrl(fromChainId)) });

  // --- source asset (from the account's own balances on that chain) ---
  const s = p.spinner();
  s.start(`Fetching balances on ${fromChainName}`);
  let tokens;
  try {
    tokens = await fetchAccountTokens(accountAddress, { raw: true, networks: [fromChainId] });
    s.stop(`Found ${tokens.length} balance(s) on ${fromChainName}`);
  } catch (err) {
    s.stop("Failed to fetch balances");
    reportError(err);
    return;
  }

  const sendable = tokens.filter(
    (t) => t.balance > 0n && (t.address.toLowerCase() === NATIVE_ADDRESS || MAINSTREAM_SYMBOLS.has(t.symbol.toUpperCase())),
  );
  if (sendable.length === 0) {
    p.log.info(`No bridgeable balances on ${fromChainName} (native ${fromChain.nativeCurrency.symbol} or a mainstream token).`);
    return;
  }

  const sellIndex = await select({
    message: "Bridge which asset?",
    options: sendable.map((t, index) => ({ value: index, label: t.symbol, hint: formatUnits(t.balance, t.decimals) })),
  });
  if (p.isCancel(sellIndex)) return;
  const fromToken = sendable[sellIndex];
  const fromIsNative = fromToken.address.toLowerCase() === NATIVE_ADDRESS;
  const fromTokenParam = fromIsNative ? LIFI_NATIVE_TOKEN : (fromToken.address as Address);
  const maxFormatted = formatUnits(fromToken.balance, fromToken.decimals);

  // --- destination chain (any active chain other than the source) ---
  const toChainOptions = SEND_NETWORK_IDS.filter((id) => id !== fromChainId);
  const toChainId = await select({
    message: "Bridge TO which chain?",
    options: toChainOptions.map((id) => ({ value: id, label: CHAIN_NAME_BY_ID[id] ?? id })),
  });
  if (p.isCancel(toChainId)) return;
  const toChainName = CHAIN_NAME_BY_ID[toChainId] ?? toChainId;
  const toChain = CHAIN_BY_ID[toChainId];

  // --- destination token (curated for the chain, native, or a manual address) ---
  const MANUAL = "__manual";
  const NATIVE = "__native";
  const known = KNOWN_TOKENS_BY_CHAIN[toChainId] ?? [];
  const toChoice = await select({
    message: "Receive which token?",
    options: [
      ...known.map((t) => ({ value: t.address as string, label: t.symbol, hint: t.address })),
      { value: NATIVE, label: `${toChain.nativeCurrency.symbol} (native)`, hint: "native currency" },
      { value: MANUAL, label: "Other token (enter address)" },
    ],
  });
  if (p.isCancel(toChoice)) return;

  let toTokenParam: string;
  let toTokenLabel: string;
  if (toChoice === NATIVE) {
    toTokenParam = LIFI_NATIVE_TOKEN;
    toTokenLabel = toChain.nativeCurrency.symbol;
  } else if (toChoice === MANUAL) {
    const manual = await p.text({
      message: `Token address to receive on ${toChainName}`,
      validate: (v) => (!v || !ADDRESS_PATTERN.test(v) ? "Enter a valid 0x-prefixed address" : undefined),
    });
    if (p.isCancel(manual)) return;
    toTokenParam = manual;
    toTokenLabel = `${manual.slice(0, 6)}…${manual.slice(-4)}`;
  } else {
    toTokenParam = toChoice;
    toTokenLabel = known.find((t) => t.address === toChoice)?.symbol ?? toChoice;
  }
  const toIsNative = toTokenParam.toLowerCase() === LIFI_NATIVE_TOKEN.toLowerCase();

  // --- amount ---
  const amountInput = await p.text({
    message: `Amount of ${fromToken.symbol} to bridge (available: ${maxFormatted})`,
    placeholder: maxFormatted,
    validate: (value) => {
      if (!value) return "Amount is required";
      let parsed: bigint;
      try {
        parsed = parseUnits(value, fromToken.decimals);
      } catch {
        return "Not a valid amount";
      }
      if (parsed <= 0n) return "Amount must be greater than 0";
      if (parsed > fromToken.balance) return `Exceeds available balance (${maxFormatted} ${fromToken.symbol})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const fromAmount = parseUnits(amountInput, fromToken.decimals);
  if (fromIsNative && fromAmount === fromToken.balance) {
    p.log.warn(
      `You're bridging your entire ${fromToken.symbol} balance — the source transaction still needs a little ${fromToken.symbol} for gas, so leave a bit behind or this will fail.`,
    );
  }

  // --- optional gas-on-destination (carved out of the bridged amount) ---
  // Only meaningful when the destination token isn't already the native gas token.
  let fromAmountForGas: bigint | undefined;
  if (!toIsNative) {
    const wantGas = await p.confirm({
      message: `Also receive some native ${toChain.nativeCurrency.symbol} on ${toChainName} for gas? (carved out of your bridged amount)`,
      initialValue: true,
    });
    if (p.isCancel(wantGas)) return;
    if (wantGas) {
      const gasInput = await p.text({
        message: `How much ${fromToken.symbol} to convert to ${toChain.nativeCurrency.symbol} gas? (a small slice of your ${amountInput})`,
        validate: (value) => {
          if (!value) return undefined; // empty → skip
          let parsed: bigint;
          try {
            parsed = parseUnits(value, fromToken.decimals);
          } catch {
            return "Not a valid amount";
          }
          if (parsed <= 0n) return "Must be greater than 0";
          if (parsed >= fromAmount) return `Must be less than the amount you're bridging (${amountInput} ${fromToken.symbol})`;
          return undefined;
        },
      });
      if (p.isCancel(gasInput)) return;
      if (gasInput) fromAmountForGas = parseUnits(gasInput, fromToken.decimals);
    }
  }

  // --- slippage ---
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

  // --- quote ---
  const quoteSpinner = p.spinner();
  quoteSpinner.start("Finding the best route");
  let quote: LifiQuote;
  try {
    quote = await getQuote({
      fromChain: Number(fromChainId),
      toChain: Number(toChainId),
      fromToken: fromTokenParam,
      toToken: toTokenParam,
      fromAmount,
      fromAddress: accountAddress,
      toAddress: accountAddress,
      slippage,
      fromAmountForGas,
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
  const sendGasCost = usd(quote.estimate.gasCosts?.find((g) => g.type === "SEND" || g.type === "SUM")?.amountUSD);
  const totalFeesUsd = (quote.estimate.feeCosts ?? []).reduce((sum, f) => sum + (Number(f.amountUSD) || 0), 0);
  const gasSliceLine = fromAmountForGas
    ? `\n  + native ${toChain.nativeCurrency.symbol} for gas (from ${formatUnits(fromAmountForGas, fromToken.decimals)} ${fromToken.symbol})`
    : "";

  p.note(
    `Send ${amountInput} ${fromToken.symbol} on ${fromChainName}\n` +
      `Receive ~${toAmount} ${toTokenLabel} on ${toChainName}${gasSliceLine}\n` +
      `  bridge: ${quote.toolDetails?.name ?? quote.tool}\n` +
      `  min received (after ${slippageInput || "0.5"}% slippage): ${toAmountMin} ${toTokenLabel}\n` +
      `  est. time: ~${quote.estimate.executionDuration}s\n` +
      (sendGasCost ? `  source gas: ${sendGasCost}\n` : "") +
      (totalFeesUsd > 0 ? `  bridge fees: ~$${totalFeesUsd.toFixed(2)}` : "").trimEnd(),
    "Bridge quote",
  );

  // --- policy pre-check on the exact transactions we'll submit ---
  const bridgeTo = quote.transactionRequest.to;
  const bridgeData = quote.transactionRequest.data;
  const bridgeValue = BigInt(quote.transactionRequest.value ?? "0x0");

  // ERC-20 sources need an allowance to LI.FI's approvalAddress first; native doesn't.
  let approveData: `0x${string}` | undefined;
  if (!fromIsNative) {
    const approvalAddress = quote.estimate.approvalAddress as Address;
    try {
      const allowance = await publicClient.readContract({
        address: fromToken.address as Address,
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
      ? [{ label: `Approve ${fromToken.symbol}`, to: fromToken.address as Address, data: approveData, whitelistNickname: `${fromToken.symbol} token` }]
      : []),
    { label: "Bridge", to: bridgeTo, data: bridgeData, whitelistNickname: `LI.FI (${quote.toolDetails?.name ?? quote.tool})` },
  ];

  const decision = await resolvePolicies(salt, accountId, selfAddress, fromChainId, isOwner, txs, "bridge");
  if (decision === "abort") return;
  if (decision === "clear") {
    const confirmed = await p.confirm({ message: "Execute this bridge?" });
    if (p.isCancel(confirmed) || !confirmed) return;
  }

  const submitBase = {
    accountId,
    chainId: Number(fromChainId),
    userAddress: selfAddress,
    walletClient,
    publicClient,
  };

  let sourceHash: string | undefined;
  try {
    if (approveData) {
      await submitAndTrack(
        salt,
        { ...submitBase, to: fromToken.address as string, value: 0n, data: approveData },
        `Approving ${fromToken.symbol}`,
      );
    }
    sourceHash = await submitAndTrack(
      salt,
      { ...submitBase, to: bridgeTo, value: bridgeValue, data: bridgeData },
      `Bridging ${fromToken.symbol} → ${toChainName}`,
    );
  } catch (err) {
    reportError(err);
    return;
  }

  if (!sourceHash) {
    p.log.warn("Bridge submitted, but no source tx hash came back — check the account activity on the explorer.");
    return;
  }
  const sourceExplorer = explorerTxUrl(fromChainId, sourceHash);
  p.log.success(`Source transaction confirmed on ${fromChainName}` + (sourceExplorer ? `\n  ${sourceExplorer}` : `\n  ${sourceHash}`));

  // --- follow the cross-chain leg to delivery ---
  await trackBridgeStatus(sourceHash, Number(fromChainId), Number(toChainId), quote.tool, toTokenLabel, toChainName);
}

/** Poll LI.FI status until the destination transfer lands (or hand off to the explorer). */
async function trackBridgeStatus(
  txHash: string,
  fromChain: number,
  toChain: number,
  bridge: string,
  toTokenLabel: string,
  toChainName: string,
): Promise<void> {
  const s = p.spinner();
  s.start(`Bridging to ${toChainName} — waiting for delivery`);
  const deadline = Date.now() + STATUS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STATUS_POLL_MS));
    let status;
    try {
      status = await getStatus({ txHash, fromChain, toChain, bridge });
    } catch {
      continue; // transient — keep polling
    }

    if (status.status === "DONE") {
      const recv = status.receiving;
      const amount =
        recv?.amount && recv.token
          ? `${formatUnits(BigInt(recv.amount), recv.token.decimals)} ${recv.token.symbol}`
          : `your ${toTokenLabel}`;
      s.stop(`Delivered on ${toChainName}`);
      p.log.success(
        `Received ${amount} on ${toChainName}` +
          (recv?.txLink ? `\n  ${recv.txLink}` : recv?.txHash ? `\n  ${recv.txHash}` : "") +
          (status.lifiExplorerLink ? `\n  track: ${status.lifiExplorerLink}` : ""),
      );
      return;
    }
    if (status.status === "FAILED") {
      s.stop("Bridge failed");
      p.log.error(
        `The bridge reported FAILED${status.substatusMessage ? `: ${status.substatusMessage}` : ""}.` +
          (status.lifiExplorerLink ? `\n  ${status.lifiExplorerLink}` : ""),
      );
      return;
    }
    if (status.substatusMessage) s.message(`Bridging to ${toChainName} — ${status.substatusMessage}`);
  }

  s.stop("Still bridging");
  p.log.info(
    `The source tx is confirmed and the bridge is in progress — it can take a few minutes.\n` +
      `Check "View balances" on ${toChainName} shortly, or track it at https://scan.li.fi/tx/${txHash}`,
  );
}
