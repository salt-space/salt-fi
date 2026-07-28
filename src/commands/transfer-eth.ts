import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { buildTransferTransaction, TransferType } from "salt-sdk";
import {
  createPublicClient,
  formatEther,
  http,
  parseEther,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type PublicClient,
} from "viem";
import {
  CHAIN_BY_ID,
  CHAIN_NAME_BY_ID,
  explorerTxUrl,
  SEND_NETWORK_IDS,
} from "../chains.js";
import { env } from "../env.js";
import { reportError } from "../errors.js";
import { pickOrganisation, select } from "../prompts.js";
import { loadSalt } from "../session.js";
import { createSaltWalletClient, type SaltWalletClient } from "../wallet.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ETH_NETWORK_IDS = SEND_NETWORK_IDS.filter(
  (id) => CHAIN_BY_ID[id]?.nativeCurrency.symbol === "ETH",
);

// TODO: Change these values before running `npm run transfer:eth`.
const RECIPIENT_ADDRESS = "0x53beBc978F5AfC70aC3bFfaD7bbD88A351123723";
const TRANSFER_AMOUNT_ETH = "0.000001";

const STAGE_LABEL: Record<string, string> = {
  proposing: "Proposing transaction...",
  signing: "Signing transaction...",
  broadcasting: "Broadcasting transaction...",
  confirming: "Waiting for transaction to be mined...",
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function getMaxSendableEth(
  publicClient: PublicClient,
  address: Address,
): Promise<bigint> {
  const balance = await publicClient.getBalance({ address });
  const gasPrice = await withTimeout(publicClient.getGasPrice(), 5000);
  const estimatedGasCost = gasPrice * 21_000n;
  return balance > estimatedGasCost ? balance - estimatedGasCost : 0n;
}

async function transferEthFlow(
  salt: Salt,
  walletClient: SaltWalletClient,
): Promise<void> {
  const selfAddress = walletClient.account.address;

  const organisationId = await pickOrganisation(
    salt,
    "Transfer ETH from which organisation?",
  );
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
      account.signers.some(
        (signer) => signer.toLowerCase() === selfAddress.toLowerCase(),
      ),
  );
  if (eligibleAccounts.length === 0) {
    p.log.info(
      "No accounts here are both fully set up and ones you're a signer on.",
    );
    return;
  }

  const accountId = await select({
    message: "Transfer ETH from which account?",
    options: eligibleAccounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint: account.evmAddress,
    })),
  });
  if (p.isCancel(accountId)) return;

  const account = eligibleAccounts.find(
    (candidate) => candidate.id === accountId,
  );
  if (!account?.evmAddress) return;
  const accountAddress = account.evmAddress as Address;

  const chainId = await select({
    message: "On which ETH network?",
    options: ETH_NETWORK_IDS.map((id) => ({
      value: id,
      label: CHAIN_NAME_BY_ID[id] ?? id,
    })),
  });
  if (p.isCancel(chainId)) return;

  const chain = CHAIN_BY_ID[chainId];
  const chainName = CHAIN_NAME_BY_ID[chainId] ?? chainId;
  const publicClient = createPublicClient({
    chain,
    transport: http(env.rpcUrl),
  });

  const balanceSpinner = p.spinner();
  balanceSpinner.start("Fetching ETH balance");
  let maxSendable: bigint;
  try {
    maxSendable = await getMaxSendableEth(publicClient, accountAddress);
    balanceSpinner.stop("Balance ready");
  } catch (err) {
    balanceSpinner.stop("Failed to fetch balance");
    reportError(err);
    return;
  }

  if (maxSendable <= 0n) {
    p.log.info(
      `No sendable ETH on ${chainName} after reserving estimated gas.`,
    );
    return;
  }

  const maxSendableFormatted = formatEther(maxSendable);
  if (!ADDRESS_PATTERN.test(RECIPIENT_ADDRESS)) {
    p.log.error(
      "RECIPIENT_ADDRESS must be a valid 0x-prefixed wallet address.",
    );
    return;
  }

  let value: bigint;
  try {
    value = parseEther(TRANSFER_AMOUNT_ETH);
  } catch {
    p.log.error('TRANSFER_AMOUNT_ETH must be a valid ETH amount, e.g. "0.01".');
    return;
  }
  if (value <= 0n) {
    p.log.error("TRANSFER_AMOUNT_ETH must be greater than 0.");
    return;
  }
  if (value > maxSendable) {
    p.log.error(
      `TRANSFER_AMOUNT_ETH exceeds available balance (${maxSendableFormatted} ETH).`,
    );
    return;
  }

  const confirmed = await p.confirm({
    message: `Transfer ${TRANSFER_AMOUNT_ETH} ETH on ${chainName} to ${RECIPIENT_ADDRESS}?`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const transferParams = buildTransferTransaction({
    type: TransferType.Native,
    accountId,
    to: RECIPIENT_ADDRESS,
    value,
    userAddress: selfAddress,
    walletClient,
    publicClient,
    chainId: Number(chainId),
  });

  const submitSpinner = p.spinner();
  submitSpinner.start("Submitting ETH transfer");
  try {
    const ceremony = await salt.submitTx(transferParams);
    ceremony.on("stateChanged", (event) => {
      submitSpinner.message(STAGE_LABEL[event.stage] ?? `${event.stage}...`);
    });
    ceremony.on("presence", (event) => {
      submitSpinner.message(
        `Waiting for signers: ${event.joined}/${event.total} joined`,
      );
    });

    const { transaction } = await ceremony.wait();
    submitSpinner.stop("ETH transfer complete");
    p.log.success(
      `Transferred ${TRANSFER_AMOUNT_ETH} ETH on ${chainName}\n` +
        `  transaction id: ${transaction.id}\n` +
        (transaction.broadcastReceipt
          ? `  tx hash: ${transaction.broadcastReceipt.transactionHash}`
          : "  (no broadcast receipt yet)"),
    );

    if (transaction.broadcastReceipt) {
      const explorer = explorerTxUrl(
        chainId,
        transaction.broadcastReceipt.transactionHash,
      );
      if (explorer) console.log(`  tx link: ${explorer}`);
    }
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      const hashMatch = err.message.match(/hash "(0x[0-9a-fA-F]+)"/);
      if (hashMatch) {
        const hash = hashMatch[1] as `0x${string}`;
        submitSpinner.message(
          "Local confirmation timed out — checking directly...",
        );
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            timeout: 120_000,
          });
          submitSpinner.stop(
            "ETH transfer complete (confirmation was just slow)",
          );
          p.log.success(
            `Transferred ${TRANSFER_AMOUNT_ETH} ETH on ${chainName}\n  tx hash: ${receipt.transactionHash}\n  status: ${receipt.status}`,
          );
          const explorer = explorerTxUrl(chainId, receipt.transactionHash);
          if (explorer) console.log(`  tx link: ${explorer}`);
          return;
        } catch {
          // Fall through to the standard error report.
        }
      }
    }
    submitSpinner.stop("ETH transfer failed");
    reportError(err);
  }
}

async function main() {
  p.intro("transfer ETH");

  const walletClient = createSaltWalletClient();
  const signInSpinner = p.spinner();
  signInSpinner.start("Signing in");
  const salt = await loadSalt(walletClient);
  signInSpinner.stop(`Signed in as ${walletClient.account.address}`);

  try {
    await transferEthFlow(salt, walletClient);
  } finally {
    salt.disconnect();
  }
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
