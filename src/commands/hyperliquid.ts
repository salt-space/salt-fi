import * as p from "@clack/prompts";
import type { Salt, SaltAccount } from "salt-sdk";
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, type Address } from "viem";
import { reportError } from "../errors.js";
import {
  buildApproveAgentTypedData,
  buildSendAssetTypedData,
  coreSystemAddress,
  fetchClearinghouseState,
  fetchExtraAgents,
  fetchOpenOrders,
  fetchSpotClearinghouseState,
  fetchUserFills,
  HYPE_CORE_SYSTEM_ADDRESS,
  HYPE_CORE_TOKEN_ID,
  HYPEREVM_CHAIN_ID,
  HYPEREVM_RPC_URL,
  saveAgentMetadata,
  submitApproveAgent,
  submitSendAsset,
  touchAgentVerified,
  USDC_CORE_TOKEN_ID,
  USDC_CORE_TOKEN_INDEX,
  USDC_HYPEREVM_ADDRESS,
  type HyperliquidSignature,
} from "../hyperliquid.js";
import { pickOrganisation, select } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Org -> eligible-account picker shared by every Hyperliquid flow: an
 * "eligible" account is one that's finished MPC setup (has an `evmAddress`)
 * and that the caller is a signer on. Mirrors swap.ts's `fastSwapFlow`.
 */
async function pickHyperliquidAccount(
  salt: Salt,
  walletClient: SaltWalletClient,
  message: string,
): Promise<{ accountId: string; account: SaltAccount } | undefined> {
  const selfAddress = walletClient.account.address;
  const organisationId = await pickOrganisation(salt, "Which organisation?");
  if (!organisationId) return undefined;

  let accounts: SaltAccount[];
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return undefined;
  }

  const eligible = accounts.filter(
    (a) => Boolean(a.evmAddress) && a.signers.some((s) => s.toLowerCase() === selfAddress.toLowerCase()),
  );
  if (eligible.length === 0) {
    p.log.info("No accounts here are both fully set up and ones you're a signer on.");
    return undefined;
  }

  const accountId = await select({
    message,
    options: eligible.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress })),
  });
  if (p.isCancel(accountId)) return undefined;
  const account = eligible.find((a) => a.id === accountId)!;
  return { accountId, account };
}

function signatureFromEvm(sig: { r: `0x${string}`; s: `0x${string}`; v: bigint }): HyperliquidSignature {
  return { r: sig.r, s: sig.s, v: Number(sig.v) };
}

// --- Getting Started ---------------------------------------------------------

export async function hyperliquidGettingStartedFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Set up Hyperliquid for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  p.note(
    "Salt is the vault: it owns the funds and positions on Hyperliquid.\n" +
      "An agent wallet is a trading badge — an address you authorize to place\n" +
      "and cancel orders on this account's behalf. It never holds funds, and\n" +
      "you can revoke it at any time. Approving (or revoking) an agent runs\n" +
      "Salt's MPC signing ceremony once; the agent itself trades without it.",
    "Owner vs. agent",
  );

  const s = p.spinner();
  s.start("Checking Hyperliquid account");
  let extraAgents;
  try {
    extraAgents = await fetchExtraAgents(userAddress);
    s.stop(
      extraAgents.length > 0
        ? `Found ${extraAgents.length} approved agent(s) already on this account`
        : "No agents approved yet on this account",
    );
  } catch (err) {
    s.stop("Couldn't reach Hyperliquid");
    reportError(err);
    return;
  }

  if (extraAgents.length > 0) {
    p.log.message(
      extraAgents
        .map((a) => `  • ${a.name || "(unnamed)"} — ${a.address}\n    valid until ${new Date(a.validUntil).toLocaleString()}`)
        .join("\n"),
    );
  }

  // Confirmed empirically against testnet: Hyperliquid rejects *any* signed
  // action, including approveAgent, with "Must deposit before performing
  // actions" until HyperCore has a deposit on record for this address. So
  // this has to be checked and short-circuited here, before offering to
  // approve — otherwise the ceremony succeeds but the submission fails with
  // a confusing API error after the (real, MPC) work is already done.
  if (extraAgents.length === 0) {
    const spot = await fetchSpotClearinghouseState(userAddress);
    const perp = await fetchClearinghouseState(userAddress);
    const hasDeposit =
      ((spot.balances as unknown[] | undefined)?.length ?? 0) > 0 ||
      Number((perp.marginSummary as { accountValue?: string } | undefined)?.accountValue ?? "0") > 0;
    if (!hasDeposit) {
      p.log.warn(
        "This account has no funds on HyperCore yet. Hyperliquid won't accept an agent approval (or any\n" +
          'signed action) until something has been deposited. Use "Move Funds" -> "Deposit" first, then come\n' +
          "back here.",
      );
      return;
    }
  }

  const proceed = await p.confirm({
    message: extraAgents.length > 0 ? "Approve another agent wallet?" : "Approve an agent wallet now?",
    initialValue: extraAgents.length === 0,
  });
  if (p.isCancel(proceed) || !proceed) return;

  const agentAddressInput = await p.text({
    message: "Agent wallet address to approve — an EOA you already control; salt-fi never sees or stores its private key",
    validate: (v) => (!v || !ADDRESS_PATTERN.test(v) ? "Enter a valid 0x-prefixed address" : undefined),
  });
  if (p.isCancel(agentAddressInput)) return;
  const agentAddress = agentAddressInput as Address;

  const agentNameInput = await p.text({
    message: "Name for this agent (shown in Hyperliquid's UI)",
    placeholder: "salt-fi agent",
    defaultValue: "salt-fi agent",
  });
  if (p.isCancel(agentNameInput)) return;
  const agentName = agentNameInput || "salt-fi agent";

  const confirmed = await p.confirm({
    message: `Approve ${agentAddress} as a trading agent for "${account.name}"? This starts an MPC signing ceremony.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const nonce = Date.now();
  const typedData = buildApproveAgentTypedData({ agentAddress, agentName, nonce });

  const ceremonySpinner = p.spinner();
  ceremonySpinner.start("Starting agent-approval signing ceremony");
  try {
    const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData });
    ceremony.on("presence", (event) => {
      ceremonySpinner.message(`Waiting for signers: ${event.joined}/${event.total} joined`);
    });
    const { signature } = await ceremony.wait();
    ceremonySpinner.message("Submitting approval to Hyperliquid");
    await submitApproveAgent({ agentAddress, agentName, nonce }, signatureFromEvm(signature));
    ceremonySpinner.stop("Agent approved");
  } catch (err) {
    ceremonySpinner.stop("Agent approval failed");
    reportError(err);
    return;
  }

  saveAgentMetadata(accountId, { agentAddress, agentName, approvedAt: Date.now() });

  const verifySpinner = p.spinner();
  verifySpinner.start("Verifying approval");
  try {
    const updated = await fetchExtraAgents(userAddress);
    const match = updated.find((a) => a.address.toLowerCase() === agentAddress.toLowerCase());
    if (match) {
      touchAgentVerified(accountId, Date.now());
      verifySpinner.stop("Verified — Hyperliquid confirms this agent is approved");
      p.log.success(
        `Active agent: ${match.name || "(unnamed)"} — ${match.address}\n  valid until ${new Date(match.validUntil).toLocaleString()}`,
      );
    } else {
      verifySpinner.stop("Hyperliquid doesn't show this agent yet — it may take a moment to propagate. Re-run Getting Started to re-check.");
    }
  } catch (err) {
    verifySpinner.stop("Couldn't verify");
    reportError(err);
  }
}

// --- Move Funds ---------------------------------------------------------------

async function depositFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Deposit to HyperCore from which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const accountAddress = account.evmAddress as Address;

  const asset = await select({
    message: "Deposit which asset?",
    options: [
      { value: "HYPE", label: "HYPE (native gas token)" },
      { value: "USDC", label: "USDC" },
    ],
  });
  if (p.isCancel(asset)) return;

  // Confirmed live against testnet spotMeta: HYPE is 18 decimals on HyperEVM
  // (native gas token), USDC is 6 (spotMeta's weiDecimals=8 + evm_extra_wei_decimals=-2).
  const decimals = asset === "HYPE" ? 18 : 6;

  const publicClient = createPublicClient({
    chain: { id: HYPEREVM_CHAIN_ID, name: "HyperEVM Testnet", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [HYPEREVM_RPC_URL] } } },
    transport: http(HYPEREVM_RPC_URL),
  });

  const amountInput = await p.text({
    message: `Amount of ${asset} to deposit`,
    validate: (v) => {
      if (!v) return "Amount is required";
      try {
        const parsed = parseUnits(v, decimals);
        if (parsed <= 0n) return "Amount must be greater than 0";
      } catch {
        return "Not a valid amount";
      }
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const amount = parseUnits(amountInput, decimals);

  const destination = asset === "HYPE" ? HYPE_CORE_SYSTEM_ADDRESS : coreSystemAddress(USDC_CORE_TOKEN_INDEX);

  const confirmed = await p.confirm({
    message: `Send ${amountInput} ${asset} from "${account.name}" (${accountAddress}) to ${destination} on HyperEVM testnet? This credits the same address's HyperCore balance.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Depositing to HyperCore");
  try {
    if (asset === "HYPE") {
      const ceremony = await salt.submitTx({
        accountId,
        to: destination,
        value: amount,
        data: "0x",
        chainId: HYPEREVM_CHAIN_ID,
        userAddress: walletClient.account.address,
        walletClient,
        publicClient,
      });
      ceremony.on("stateChanged", (event) => s.message(`Depositing — ${event.stage}...`));
      const { transaction } = await ceremony.wait();
      s.stop(`Deposited — tx hash: ${transaction.broadcastReceipt?.transactionHash ?? "(pending)"}`);
    } else {
      const data = encodeErc20Transfer(destination, amount);
      const ceremony = await salt.submitTx({
        accountId,
        to: USDC_HYPEREVM_ADDRESS,
        value: 0n,
        data,
        chainId: HYPEREVM_CHAIN_ID,
        userAddress: walletClient.account.address,
        walletClient,
        publicClient,
      });
      ceremony.on("stateChanged", (event) => s.message(`Depositing — ${event.stage}...`));
      const { transaction } = await ceremony.wait();
      s.stop(`Deposited — tx hash: ${transaction.broadcastReceipt?.transactionHash ?? "(pending)"}`);
    }
  } catch (err) {
    s.stop("Deposit failed");
    reportError(err);
  }
}

const ERC20_TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
function encodeErc20Transfer(to: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to, amount] });
}

async function withdrawFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Withdraw from HyperCore for which account?");
  if (!picked) return;
  const { accountId, account } = picked;
  const userAddress = account.evmAddress as Address;

  const asset = await select({
    message: "Withdraw which asset?",
    options: [
      { value: "HYPE", label: "HYPE" },
      { value: "USDC", label: "USDC" },
    ],
  });
  if (p.isCancel(asset)) return;

  const s = p.spinner();
  s.start("Checking spot balance");
  let available = "0";
  try {
    const spot = await fetchSpotClearinghouseState(userAddress);
    const balances = (spot.balances as { coin: string; total: string }[] | undefined) ?? [];
    available = balances.find((b) => b.coin === asset)?.total ?? "0";
    s.stop(`Available: ${available} ${asset} (spot)`);
  } catch (err) {
    s.stop("Couldn't check balance");
    reportError(err);
    return;
  }

  const amountInput = await p.text({
    message: `Amount of ${asset} to withdraw to HyperEVM`,
    validate: (v) => {
      if (!v) return "Amount is required";
      const parsed = Number.parseFloat(v);
      if (!Number.isFinite(parsed) || parsed <= 0) return "Enter a positive number";
      if (parsed > Number.parseFloat(available)) return `Exceeds available balance (${available} ${asset})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;

  const confirmed = await p.confirm({
    message: `Move ${amountInput} ${asset} from HyperCore back to "${account.name}"'s HyperEVM address? This runs an MPC signing ceremony.`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const destination = asset === "HYPE" ? HYPE_CORE_SYSTEM_ADDRESS : coreSystemAddress(USDC_CORE_TOKEN_INDEX);
  const tokenId = asset === "HYPE" ? HYPE_CORE_TOKEN_ID : USDC_CORE_TOKEN_ID;
  const nonce = Date.now();
  const params = {
    destination,
    token: `${asset}:${tokenId}`,
    amount: amountInput,
    sourceDex: "spot",
    destinationDex: "spot",
    fromSubAccount: "",
    nonce,
  };

  const ceremonySpinner = p.spinner();
  ceremonySpinner.start("Starting withdrawal signing ceremony");
  try {
    const typedData = buildSendAssetTypedData(params);
    const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData });
    ceremony.on("presence", (event) => {
      ceremonySpinner.message(`Waiting for signers: ${event.joined}/${event.total} joined`);
    });
    const { signature } = await ceremony.wait();
    ceremonySpinner.message("Submitting withdrawal to Hyperliquid");
    const sig: HyperliquidSignature = { r: signature.r, s: signature.s, v: Number(signature.v) };
    await submitSendAsset(params, sig);
    ceremonySpinner.stop(`Withdrawn — ${amountInput} ${asset} is on its way to ${userAddress} on HyperEVM`);
  } catch (err) {
    ceremonySpinner.stop("Withdrawal failed");
    reportError(err);
  }
}

export async function hyperliquidMoveFundsFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const choice = await select({
    message: "Move funds",
    options: [
      { value: "deposit", label: "Deposit", hint: "HyperEVM -> HyperCore" },
      { value: "withdraw", label: "Withdraw", hint: "HyperCore -> HyperEVM" },
    ],
  });
  if (p.isCancel(choice)) return;
  if (choice === "deposit") await depositFlow(salt, walletClient);
  else await withdrawFlow(salt, walletClient);
}

// --- Portfolio / Positions -----------------------------------------------------

export async function hyperliquidPortfolioFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Portfolio for which account?");
  if (!picked) return;
  const userAddress = picked.account.evmAddress as Address;

  const s = p.spinner();
  s.start("Fetching portfolio");
  try {
    const [perp, spot] = await Promise.all([fetchClearinghouseState(userAddress), fetchSpotClearinghouseState(userAddress)]);
    s.stop("Portfolio");

    const summary = perp.marginSummary as Record<string, unknown> | undefined;
    if (summary) {
      p.log.message(
        `Account value: ${summary.accountValue}\n` +
          `Total margin used: ${summary.totalMarginUsed}\n` +
          `Total position value: ${summary.totalNtlPos}`,
      );
    } else {
      p.log.info("No perp account state yet (this account hasn't deposited to HyperCore).");
    }

    const balances = spot.balances as { coin: string; total: string }[] | undefined;
    if (balances && balances.length > 0) {
      p.log.message("Spot balances:\n" + balances.map((b) => `  ${b.coin}: ${b.total}`).join("\n"));
    }
  } catch (err) {
    s.stop("Failed to fetch portfolio");
    reportError(err);
  }
}

export async function hyperliquidPositionsFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const picked = await pickHyperliquidAccount(salt, walletClient, "Positions for which account?");
  if (!picked) return;
  const userAddress = picked.account.evmAddress as Address;

  const s = p.spinner();
  s.start("Fetching positions");
  try {
    const [state, openOrders, fills] = await Promise.all([
      fetchClearinghouseState(userAddress),
      fetchOpenOrders(userAddress),
      fetchUserFills(userAddress),
    ]);
    s.stop("Positions");

    const positions = (state.assetPositions as { position: Record<string, unknown> }[] | undefined) ?? [];
    if (positions.length === 0) {
      p.log.info("No open positions.");
    } else {
      p.log.message(
        "Open positions:\n" +
          positions
            .map((p2) => `  ${p2.position.coin}: ${p2.position.szi} @ entry ${p2.position.entryPx} (uPnL ${p2.position.unrealizedPnl})`)
            .join("\n"),
      );
    }

    p.log.message(`${(openOrders as unknown[]).length} open order(s), ${(fills as unknown[]).length} recent fill(s).`);
  } catch (err) {
    s.stop("Failed to fetch positions");
    reportError(err);
  }
}

// --- Trade (stub) ---------------------------------------------------------------

/**
 * Deferred to a later phase — order placement, cancellation, leverage updates
 * and position management. The pieces this will build on already exist: the
 * agent-metadata store and the account picker above, plus the HTTP client and
 * EIP-712 builders in hyperliquid.ts.
 */
export async function hyperliquidTradeFlow(): Promise<void> {
  p.log.info("Trading isn't implemented yet — approve an agent wallet via Getting Started first.");
}
