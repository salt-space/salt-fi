import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { buildTransferTransaction, TransferType } from "salt-sdk";
import { createPublicClient, formatUnits, http, parseUnits, WaitForTransactionReceiptTimeoutError } from "viem";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID, explorerTxUrl, SEND_NETWORK_IDS } from "../chains.js";
import { reportError } from "../errors.js";
import { pickOrganisation, select } from "../prompts.js";
import { fetchAccountTokens } from "../token-balances.js";
import type { SaltWalletClient } from "../wallet.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

// Native currency is always shown; beyond that, only these well-known
// symbols count as "mainstream" — testnet price data is unreliable enough
// that filtering on the API's `price` field risks either hiding everything
// or showing junk, so a small curated allowlist is the more predictable bar.
const MAINSTREAM_SYMBOLS = new Set(["USDC", "USDT", "DAI", "WETH", "WBTC", "MATIC", "POL"]);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
}

// Ongoing spinner text while currently in each stage.
const STAGE_LABEL: Record<string, string> = {
  proposing: "Transaction proposing...",
  signing: "Transaction signing...",
  broadcasting: "Transaction broadcasting...",
  confirming: "Waiting for the transaction to be mined...",
};

// Printed as a permanent line once a stage finishes (i.e. when the *next*
// stage starts) — so, e.g., broadcasting completing is still visible after
// the spinner has moved on to "confirming", making clear it's been handed
// off from Salt to the chain itself. No entry for "confirming": that's
// covered by the final success message once ceremony.wait() resolves. No
// entries for "proposing"/"signing" either — those get dynamic, per-stage
// timed messages instead (see the stateChanged handler).
const STAGE_COMPLETE_LABEL: Record<string, string> = {
  broadcasting: "Transaction broadcast successfully",
};

export async function sendTransactionFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const selfAddress = walletClient.account.address;

  const organisationId = await pickOrganisation(salt, "Send from which organisation?");
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

  const accountId = await select({
    message: "Send from which account?",
    options: eligibleAccounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: account.evmAddress ?? "pending setup",
    })),
  });
  if (p.isCancel(accountId)) return;
  const account = eligibleAccounts.find((a) => a.id === accountId)!;

  const s = p.spinner();
  s.start("Fetching balances");
  let tokens;
  try {
    tokens = await fetchAccountTokens(account.evmAddress as string, { raw: true, networks: SEND_NETWORK_IDS });
    s.stop(`Found ${tokens.length} token balance(s)`);
  } catch (err) {
    s.stop("Failed to fetch balances");
    reportError(err);
    return;
  }

  const sendable = tokens.filter(
    (token) =>
      token.balance > 0n && (token.address.toLowerCase() === NATIVE_ADDRESS || MAINSTREAM_SYMBOLS.has(token.symbol.toUpperCase())),
  );
  if (sendable.length === 0) {
    p.log.info(
      "No mainstream assets with a balance found across " + Object.values(CHAIN_NAME_BY_ID).join(", ") + ".",
    );
    return;
  }

  const tokenIndex = await select({
    message: "Send which asset?",
    options: sendable.map((token, index) => ({
      value: index,
      label: `${token.symbol} on ${CHAIN_NAME_BY_ID[token.chainId] ?? token.chainId}`,
      hint: formatUnits(token.balance, token.decimals),
    })),
  });
  if (p.isCancel(tokenIndex)) return;
  const token = sendable[tokenIndex];
  const isNative = token.address.toLowerCase() === NATIVE_ADDRESS;
  const chainName = CHAIN_NAME_BY_ID[token.chainId] ?? token.chainId;

  const chain = CHAIN_BY_ID[token.chainId];
  if (!chain) {
    p.log.error(`Unsupported chain ID: ${token.chainId}`);
    return;
  }
  const publicClient = createPublicClient({ chain, transport: http() });

  // For native sends, leave room for gas so the amount prompt doesn't offer
  // (or accept) the full balance only to fail submitting. Doesn't need to be
  // precise — a plain-transfer gas limit (21,000) at the current gas price is
  // a reasonable reserve; ERC20 balances aren't affected since gas is always
  // paid in the chain's native currency, not the token being sent.
  // Bounded with a timeout — a slow/unresponsive public RPC shouldn't be able
  // to hang the whole flow with no visible feedback.
  let maxSendable = token.balance;
  if (isNative) {
    const gasSpinner = p.spinner();
    gasSpinner.start("Estimating gas");
    try {
      const gasPrice = await withTimeout(publicClient.getGasPrice(), 5000);
      const estimatedGasCost = gasPrice * 21_000n;
      maxSendable = token.balance > estimatedGasCost ? token.balance - estimatedGasCost : 0n;
      gasSpinner.stop("Gas estimated");
    } catch {
      gasSpinner.stop("Couldn't estimate gas (RPC too slow) — using full balance");
    }
  }
  const maxSendableFormatted = formatUnits(maxSendable, token.decimals);

  const OTHER_ADDRESS = "__other" as const;
  const otherAccountsInOrg = accounts.filter((account) => account.id !== accountId && Boolean(account.evmAddress));

  let to: string | undefined;
  let recipientLabel: string | undefined;

  if (otherAccountsInOrg.length > 0) {
    const recipientChoice = await select({
      message: "Recipient",
      options: [
        ...otherAccountsInOrg.map((account) => ({
          value: account.id,
          label: account.name,
          hint: account.evmAddress,
        })),
        { value: OTHER_ADDRESS, label: "Other address (enter manually)" },
      ],
    });
    if (p.isCancel(recipientChoice)) return;
    if (recipientChoice !== OTHER_ADDRESS) {
      const recipientAccount = otherAccountsInOrg.find((account) => account.id === recipientChoice);
      to = recipientAccount?.evmAddress;
      recipientLabel = `${recipientAccount?.name} (${to})`;
    }
  }

  if (to === undefined) {
    const manualTo = await p.text({
      message: "Recipient address",
      placeholder: "0x1234567890123456789012345678901234567890",
      validate: (value) => (!value || !ADDRESS_PATTERN.test(value) ? "Enter a valid 0x-prefixed address" : undefined),
    });
    if (p.isCancel(manualTo)) return;
    to = manualTo;
    recipientLabel = to;
  }

  const amountInput = await p.text({
    message: `Amount of ${token.symbol} to send (available: ${maxSendableFormatted}${isNative ? ", after reserving estimated gas" : ""})`,
    placeholder: maxSendableFormatted,
    validate: (value) => {
      if (!value) return "Amount is required";
      let parsed: bigint;
      try {
        parsed = parseUnits(value, token.decimals);
      } catch {
        return "Not a valid amount";
      }
      if (parsed <= 0n) return "Amount must be greater than 0";
      if (parsed > maxSendable) return `Exceeds available balance (${maxSendableFormatted} ${token.symbol})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const value = parseUnits(amountInput, token.decimals);

  const confirmed = await p.confirm({
    message: `Send ${amountInput} ${token.symbol} on ${chainName} to ${recipientLabel}?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const baseTransferParams = {
    accountId,
    to,
    value,
    userAddress: selfAddress,
    walletClient,
    publicClient,
    chainId: Number(token.chainId),
  };
  const transferParams = buildTransferTransaction(
    isNative
      ? { type: TransferType.Native, ...baseTransferParams }
      : { type: TransferType.ERC20, tokenAddress: token.address, ...baseTransferParams },
  );

  const s2 = p.spinner();
  s2.start("Submitting transaction");
  try {
    const ceremony = await salt.submitTx(transferParams);

    let previousStage: string | undefined;
    const stageEnteredAt: Record<string, number> = {};
    // First `presence` event where every expected signer has joined — lets
    // "signed in Xs" be split further into nudge/huddle-join time vs. the
    // MPC signing rounds themselves.
    let huddleReadyAt: number | undefined;

    ceremony.on("stateChanged", (event) => {
      const now = Date.now();
      stageEnteredAt[event.stage] ??= now;

      if (previousStage === "proposing") {
        const seconds = ((now - stageEnteredAt.proposing) / 1000).toFixed(1);
        p.log.message(`Transaction proposed in ${seconds}s (tx record + policy check)`);
      } else if (previousStage === "signing") {
        const seconds = ((now - stageEnteredAt.signing) / 1000).toFixed(1);
        const cryptoNote =
          huddleReadyAt !== undefined ? ` (${((now - huddleReadyAt) / 1000).toFixed(1)}s of that was the MPC round)` : "";
        p.log.message(`Transaction signed in ${seconds}s${cryptoNote}`);
      } else if (previousStage) {
        const justCompleted = STAGE_COMPLETE_LABEL[previousStage];
        if (justCompleted) p.log.message(justCompleted);
      }

      previousStage = event.stage;
      s2.message(STAGE_LABEL[event.stage] ?? `Transaction ${event.stage}...`);
    });
    ceremony.on("presence", (event) => {
      if (huddleReadyAt === undefined && event.joined === event.total) {
        huddleReadyAt = Date.now();
      }
      s2.message(`Waiting for signers: ${event.joined}/${event.total} joined`);
    });

    const { transaction } = await ceremony.wait();
    s2.stop("Transaction complete");
    p.log.success(
      `Sent ${amountInput} ${token.symbol} on ${chainName}\n` +
        `  transaction id: ${transaction.id}\n` +
        (transaction.broadcastReceipt ? `  tx hash: ${transaction.broadcastReceipt.transactionHash}` : "  (no broadcast receipt yet)"),
    );
    if (transaction.broadcastReceipt) {
      // Labelled to match the lines above, but printed bare (outside clack's
      // box) so the URL stays a single clickable string — see faucet.ts.
      const explorer = explorerTxUrl(token.chainId, transaction.broadcastReceipt.transactionHash);
      if (explorer) console.log(`  tx link: ${explorer}`);
    }
  } catch (err) {
    // The ceremony itself broadcasts and confirms the transaction — this
    // timeout just means *our* wait gave up watching for the receipt, not
    // that the transaction failed. It may well have already been mined, so
    // check directly with a more patient timeout before reporting failure.
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      const hashMatch = err.message.match(/hash "(0x[0-9a-fA-F]+)"/);
      if (hashMatch) {
        const hash = hashMatch[1] as `0x${string}`;
        s2.message("Local confirmation timed out — checking directly...");
        try {
          const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
          s2.stop("Transaction complete (confirmation was just slow to arrive)");
          p.log.success(`Sent ${amountInput} ${token.symbol} on ${chainName}\n  tx hash: ${receipt.transactionHash}\n  status: ${receipt.status}`);
          const explorer = explorerTxUrl(token.chainId, receipt.transactionHash);
          if (explorer) console.log(`  tx link: ${explorer}`);
          return;
        } catch {
          // Genuinely not confirmed even with extra patience — fall through.
        }
      }
    }
    s2.stop("Transaction failed");
    reportError(err);
  }
}
