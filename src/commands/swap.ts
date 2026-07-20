import * as p from "@clack/prompts";
import type { Policy, Salt } from "salt-sdk";
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
import { formatSaltError, reportError } from "../errors.js";
import { POLICY_TYPE_LABEL } from "../policies.js";
import { pickOrganisation, select } from "../prompts.js";
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

/** A transaction the swap will submit, with the label to whitelist if a policy blocks its `to`. */
interface SwapTx {
  label: string;
  to: Address;
  data: `0x${string}`;
  whitelistNickname: string;
}

function dedupeById(policies: Policy[]): Policy[] {
  const seen = new Set<string>();
  const out: Policy[] = [];
  for (const pol of policies) {
    if (!seen.has(pol.id)) {
      seen.add(pol.id);
      out.push(pol);
    }
  }
  return out;
}

/**
 * Outcome of the pre-swap policy check:
 * - `clear`   — no breach (or an owner fixed the whitelist); ask the normal confirm.
 * - `proceed` — breach, but the user opted to submit anyway (already an explicit
 *               go-ahead, so skip the redundant confirm).
 * - `abort`   — cancelled; don't submit.
 */
type PolicyDecision = "clear" | "proceed" | "abort";

/** Offer to submit despite a policy breach — the swap will very likely be rejected. */
async function promptProceedAnyway(): Promise<PolicyDecision> {
  const anyway = await p.confirm({
    message: "Try the swap anyway? It will very likely be rejected — a Robo Guardian refuses to sign on a policy breach.",
    initialValue: false,
  });
  return !p.isCancel(anyway) && anyway === true ? "proceed" : "abort";
}

/**
 * Run Salt's policy check against each transaction the swap will submit and
 * surface the results. Salt evaluates each call's `to` against the account's
 * policies, so the common blocker is an allowed-recipients whitelist that
 * doesn't include the Uniswap router (and/or the sell token being approved).
 * An owner can add the missing addresses inline; anyone else can proceed and
 * see it fail. See {@link PolicyDecision} for the outcomes.
 */
async function resolveSwapPolicies(
  salt: Salt,
  accountId: string,
  selfAddress: string,
  chainId: string,
  isOwner: boolean,
  txs: SwapTx[],
): Promise<PolicyDecision> {
  const runChecks = async () => {
    const nonce = await salt.getAccountNonce(accountId, Number(chainId));
    const out: { tx: SwapTx; check: Awaited<ReturnType<Salt["runPoliciesCheck"]>> }[] = [];
    for (const tx of txs) {
      const check = await salt.runPoliciesCheck(accountId, {
        nonce,
        amount: "0",
        from: selfAddress,
        to: tx.to,
        network: chainId,
        data: tx.data,
      });
      out.push({ tx, check });
    }
    return out;
  };

  let results;
  try {
    results = await runChecks();
  } catch (err) {
    p.log.warn(`Couldn't check account policies (${(err as Error).message}). Proceeding without a policy check.`);
    return "clear";
  }

  // Surface every policy that applies to this swap, with a pass/fail mark.
  const rejectedIds = new Set(results.flatMap((r) => r.check.rejectedPolicies.map((pol) => pol.id)));
  const applicable = dedupeById(results.flatMap((r) => r.check.networkPolicies));
  if (applicable.length > 0) {
    p.note(
      applicable.map((pol) => `${rejectedIds.has(pol.id) ? "✗" : "✓"} ${POLICY_TYPE_LABEL[pol.type] ?? pol.type}`).join("\n"),
      "Account policies that apply to this swap",
    );
  }

  const rejected = dedupeById(results.flatMap((r) => r.check.rejectedPolicies));
  if (rejected.length === 0) return "clear";

  // Blockers other than the whitelist can't be auto-resolved here.
  const nonWhitelist = rejected.filter((pol) => pol.type !== "allowed_recipients");
  if (nonWhitelist.length > 0) {
    p.log.error(
      "This swap is blocked by policies that can't be resolved here:\n" +
        nonWhitelist.map((pol) => `  • ${POLICY_TYPE_LABEL[pol.type] ?? pol.type}`).join("\n") +
        '\nAn owner can adjust these via "Manage policies".',
    );
    return promptProceedAnyway();
  }

  // Only allowed-recipients blocks remain. A rejected tx's `to` is the address
  // that whitelist is missing — collect them per blocking policy.
  const fixes = new Map<string, { policy: Policy; additions: { address: string; nickname: string }[] }>();
  for (const { tx, check } of results) {
    for (const pol of check.rejectedPolicies) {
      if (pol.type !== "allowed_recipients") continue;
      const entry = fixes.get(pol.id) ?? { policy: pol, additions: [] };
      if (!entry.additions.some((a) => a.address.toLowerCase() === tx.to.toLowerCase())) {
        entry.additions.push({ address: tx.to, nickname: tx.whitelistNickname });
      }
      fixes.set(pol.id, entry);
    }
  }

  const neededList = [
    ...new Set([...fixes.values()].flatMap((f) => f.additions.map((a) => `${a.nickname} (${a.address})`))),
  ];
  p.log.warn(
    "This account has an allowed-recipients whitelist, and this swap needs these addresses on it:\n" +
      neededList.map((x) => `  • ${x}`).join("\n"),
  );

  if (!isOwner) {
    p.log.info(
      "You're not an owner of this organisation, so you can't change the whitelist. Ask an owner to add the " +
        'addresses above ("Manage policies" → the allowed-recipients policy), then run the swap again.',
    );
    return promptProceedAnyway();
  }

  const addNow = await p.confirm({ message: "You're an owner — add these to the whitelist now?" });
  if (p.isCancel(addNow)) return "abort";
  if (!addNow) return promptProceedAnyway();

  const s = p.spinner();
  s.start("Updating whitelist");
  try {
    for (const { policy, additions } of fixes.values()) {
      const existing = (policy.params as { recipients?: { address: string; nickname?: string }[] }).recipients ?? [];
      const merged = [...existing];
      for (const add of additions) {
        if (!merged.some((r) => r.address.toLowerCase() === add.address.toLowerCase())) merged.push(add);
      }
      await salt.updateAccountPolicy(policy.id, { recipients: merged });
    }
    s.stop("Whitelist updated");
  } catch (err) {
    s.stop("Failed to update whitelist");
    p.log.error(formatSaltError(err));
    return promptProceedAnyway();
  }

  // Re-check to confirm the swap is now allowed (e.g. in case another policy also applies).
  try {
    const recheck = await runChecks();
    const stillRejected = dedupeById(recheck.flatMap((r) => r.check.rejectedPolicies));
    if (stillRejected.length > 0) {
      p.log.error(
        "Still blocked after the whitelist update:\n" +
          stillRejected.map((pol) => `  • ${POLICY_TYPE_LABEL[pol.type] ?? pol.type}`).join("\n"),
      );
      return promptProceedAnyway();
    }
  } catch {
    // Whitelist was updated; if the re-check errors, let the submit be the source of truth.
  }
  p.log.success("Whitelist updated — the swap is now allowed.");
  return "clear";
}

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
    organisation.members.find((m) => m.address.toLowerCase() === selfAddress.toLowerCase())?.accessLevel === 1;

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

  const txs: SwapTx[] = [
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
  const decision = await resolveSwapPolicies(salt, accountId, selfAddress, chainId, isOwner, txs);
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
  } catch (err) {
    reportError(err);
  }
}
