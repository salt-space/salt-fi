import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { type Address, createPublicClient, erc20Abi, formatUnits, http, maxUint256, parseUnits } from "viem";
import { CHAIN_BY_ID, rpcUrl } from "../chains.js";
import { network } from "../env.js";
import { reportError } from "../errors.js";
import { getQuote } from "../lifi.js";
import { pickOrganisation, select } from "../prompts.js";
import {
  authDeadline,
  buildAddOrderTypedData,
  buildPermit2Permit,
  constantSpread,
  fetchTurbineConfig,
  NULL_ADDRESS,
  type OrderIntent,
  PERMIT2_ADDRESS,
  randomNonce,
  randomSalt,
  readPermit2Nonce,
  submitAddOrder,
  toPrimitiveSignature,
  type TurbineToken,
} from "../turbine.js";
import { encodeApprove, ERC20_ABI } from "../uniswap.js";
import { submitAndTrack } from "./tx-preflight.js";
import type { SaltWalletClient } from "../wallet.js";

const ETHEREUM = "1";

/**
 * "Slow swap (Turbine)" — submit a patient, Permit2-authorised order to
 * PropellerHeads' Turbine (Ethereum mainnet), signed entirely via Salt MPC (no
 * local key). Non-instant by design: solvers fill it over the order window as the
 * spread curve decays. See {@link buildAddOrderTypedData} for the signing model.
 */
export async function turbineSlowSwapFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  if (network.saltEnv !== "mainnet") {
    p.log.info("Turbine trades on Ethereum mainnet only — switch to the mainnet environment to use Slow swap.");
    return;
  }

  const cfgSpinner = p.spinner();
  cfgSpinner.start("Connecting to Turbine");
  let config;
  try {
    config = await fetchTurbineConfig();
    cfgSpinner.stop(`Turbine ready — ${config.tokens.length} tokens, min trade ~$${Number(config.minTradeSizeUsdc) / 1e6}`);
  } catch (err) {
    cfgSpinner.stop("Couldn't reach Turbine");
    reportError(err);
    return;
  }

  const selfAddress = walletClient.account.address;
  const organisationId = await pickOrganisation(salt, "Slow-swap from which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return;
  }
  const eligible = accounts.filter(
    (a) => Boolean(a.evmAddress) && a.signers.some((s) => s.toLowerCase() === selfAddress.toLowerCase()),
  );
  if (eligible.length === 0) {
    p.log.info("No accounts here are both fully set up and ones you're a signer on.");
    return;
  }
  const accountId = await select({
    message: "Slow-swap from which account?",
    options: eligible.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress })),
  });
  if (p.isCancel(accountId)) return;
  const account = eligible.find((a) => a.id === accountId)!;
  const owner = account.evmAddress as Address;

  const publicClient = createPublicClient({ chain: CHAIN_BY_ID[ETHEREUM], transport: http(rpcUrl(ETHEREUM)) });

  // --- sell token (from Turbine's token list, filtered to what the account holds) ---
  const s = p.spinner();
  s.start("Reading your Ethereum balances");
  let sellable: { token: TurbineToken; balance: bigint }[];
  try {
    const balances = await Promise.all(
      config.tokens.map(async (t) => {
        try {
          const bal = (await publicClient.readContract({
            address: t.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
          })) as bigint;
          return { token: t, balance: bal };
        } catch {
          return { token: t, balance: 0n };
        }
      }),
    );
    sellable = balances.filter((b) => b.balance > 0n);
    s.stop(`Found ${sellable.length} Turbine-listed token balance(s)`);
  } catch (err) {
    s.stop("Failed to read balances");
    reportError(err);
    return;
  }
  if (sellable.length === 0) {
    p.log.info("This account holds none of Turbine's listed tokens on Ethereum. Fund it first (e.g. USDC/WETH).");
    return;
  }

  const sellIdx = await select({
    message: "Sell which token?",
    options: sellable.map((b, i) => ({
      value: i,
      label: b.token.symbol,
      hint: formatUnits(b.balance, b.token.decimals),
    })),
  });
  if (p.isCancel(sellIdx)) return;
  const sell = sellable[sellIdx].token;
  const sellBalance = sellable[sellIdx].balance;
  const maxSell = formatUnits(sellBalance, sell.decimals);

  // --- buy token (any other listed token) ---
  const buyChoice = await select({
    message: "Buy which token?",
    options: config.tokens
      .filter((t) => t.address.toLowerCase() !== sell.address.toLowerCase())
      .map((t) => ({ value: t.address as string, label: t.symbol, hint: t.address })),
  });
  if (p.isCancel(buyChoice)) return;
  const buy = config.tokens.find((t) => t.address.toLowerCase() === (buyChoice as string).toLowerCase())!;

  // --- amount ---
  const amountInput = await p.text({
    message: `Amount of ${sell.symbol} to sell (available: ${maxSell})`,
    placeholder: maxSell,
    validate: (v) => {
      if (!v) return "Amount is required";
      let parsed: bigint;
      try {
        parsed = parseUnits(v, sell.decimals);
      } catch {
        return "Not a valid amount";
      }
      if (parsed <= 0n) return "Must be greater than 0";
      if (parsed > sellBalance) return `Exceeds balance (${maxSell} ${sell.symbol})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const sellAmount = parseUnits(amountInput, sell.decimals);

  // --- reference price (best-effort, via LI.FI same-chain quote) + slippage → minBuyAmount ---
  let referenceOut: bigint | undefined;
  const refSpinner = p.spinner();
  refSpinner.start("Fetching a reference price");
  try {
    const q = await getQuote({
      fromChain: 1,
      toChain: 1,
      fromToken: sell.address,
      toToken: buy.address,
      fromAmount: sellAmount,
      fromAddress: owner,
      toAddress: owner,
      slippage: 0.005,
    });
    referenceOut = BigInt(q.estimate.toAmount);
    refSpinner.stop(`Reference: ~${formatUnits(referenceOut, buy.decimals)} ${buy.symbol} (spot, for guidance)`);
  } catch {
    refSpinner.stop("No reference price available — you'll set the minimum manually");
  }

  let minBuyAmount: bigint;
  if (referenceOut !== undefined) {
    const slipInput = await p.text({
      message: `Max slippage % vs the reference (${formatUnits(referenceOut, buy.decimals)} ${buy.symbol})`,
      defaultValue: "1",
      placeholder: "1",
      validate: (v) => (v && (Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) >= 100) ? "Enter 0–100" : undefined),
    });
    if (p.isCancel(slipInput)) return;
    const slipBps = BigInt(Math.round(Number(slipInput || "1") * 100));
    minBuyAmount = (referenceOut * (10_000n - slipBps)) / 10_000n;
  } else {
    const minInput = await p.text({
      message: `Minimum ${buy.symbol} to accept (your floor)`,
      validate: (v) => {
        if (!v) return "Required";
        try {
          if (parseUnits(v, buy.decimals) <= 0n) return "Must be greater than 0";
        } catch {
          return "Not a valid amount";
        }
        return undefined;
      },
    });
    if (p.isCancel(minInput)) return;
    minBuyAmount = parseUnits(minInput, buy.decimals);
  }

  // --- spread curve + duration ---
  const spreadInput = await p.text({
    message: "Max spread % (how far below spot you'll let the order fill; higher = fills faster)",
    defaultValue: "0.5",
    placeholder: "0.5",
    validate: (v) => (v && (Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) >= 100) ? "Enter 0–100" : undefined),
  });
  if (p.isCancel(spreadInput)) return;
  const spreadCurve = constantSpread(Math.round(Number(spreadInput || "0.5") * 100));

  const durationInput = await p.text({
    message: "Order lifetime in minutes (it's cancelled/expired after this)",
    defaultValue: "10",
    placeholder: "10",
    validate: (v) => (v && (Number.isNaN(Number(v)) || Number(v) <= 0) ? "Enter a positive number" : undefined),
  });
  if (p.isCancel(durationInput)) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const endTime = now + BigInt(Math.round(Number(durationInput || "10") * 60));

  const intent: OrderIntent = {
    owner,
    sellToken: sell.address,
    buyToken: buy.address,
    sellAmount,
    minBuyAmount,
    spreadCurve,
    startTime: now,
    endTime,
    partialFill: true,
    callData: "0x",
    callDataTarget: NULL_ADDRESS,
    salt: randomSalt(),
  };

  p.note(
    `Sell ${amountInput} ${sell.symbol} → at least ${formatUnits(minBuyAmount, buy.decimals)} ${buy.symbol}\n` +
      `  type:     patient order (Turbine solvers fill over the window)\n` +
      `  spread:   up to ${spreadInput || "0.5"}%\n` +
      `  window:   ${durationInput || "10"} min\n` +
      `  settler:  ${config.turbineSettlerAddress}\n` +
      `  ⚠ pulled via Permit2 by the settler on fill — real funds, and account send-policies don't gate a Permit2 pull`,
    "Slow swap (Turbine)",
  );
  const confirmed = await p.confirm({ message: "Sign & submit this order?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  // --- 1) one-time ERC-20 approve(Permit2) on the sell token, if needed ---
  try {
    const allowance = (await publicClient.readContract({
      address: sell.address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, PERMIT2_ADDRESS],
    })) as bigint;
    if (allowance < sellAmount) {
      await submitAndTrack(
        salt,
        {
          accountId,
          to: sell.address,
          value: 0n,
          data: encodeApprove(PERMIT2_ADDRESS, maxUint256),
          chainId: 1,
          userAddress: selfAddress,
          walletClient,
          publicClient,
        },
        `Approving ${sell.symbol} for Permit2`,
      );
    } else {
      p.log.step(`${sell.symbol} already approved for Permit2 — skipping approval.`);
    }
  } catch (err) {
    reportError(err);
    return;
  }

  // --- 2) Permit2 AllowanceTransfer permit — signed via MPC ---
  let signedPermit;
  try {
    const nonce = await readPermit2Nonce(publicClient, owner, sell.address, config.turbineSettlerAddress);
    const { permit, typedData } = buildPermit2Permit({
      token: sell.address,
      spender: config.turbineSettlerAddress,
      nonce,
      deadline: endTime,
      chainId: 1,
    });
    const s2 = p.spinner();
    s2.start("Signing the Permit2 permit (MPC ceremony)");
    const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData });
    ceremony.on("presence", (e) => s2.message(`Signing Permit2 — waiting for signers: ${e.joined}/${e.total} joined`));
    const { signature } = await ceremony.wait();
    s2.stop("Permit2 permit signed");
    signedPermit = { signature: toPrimitiveSignature(signature), permit };
  } catch (err) {
    reportError(err);
    return;
  }

  // --- 3) AddOrder auth envelope — signed via MPC ---
  let auth;
  try {
    const nonce = randomNonce();
    const deadline = authDeadline(config.maxSignatureLifetimeS);
    const typedData = buildAddOrderTypedData(intent, nonce, deadline, config.eip712Domain);
    const s3 = p.spinner();
    s3.start("Signing the order (MPC ceremony)");
    const ceremony = await salt.signTypedData({ accountId, signer: walletClient, typedData });
    ceremony.on("presence", (e) => s3.message(`Signing order — waiting for signers: ${e.joined}/${e.total} joined`));
    const { signature } = await ceremony.wait();
    s3.stop("Order signed");
    auth = { signer: owner, nonce, deadline, signature: toPrimitiveSignature(signature) };
  } catch (err) {
    reportError(err);
    return;
  }

  // --- 4) submit ---
  const s4 = p.spinner();
  s4.start("Submitting to Turbine");
  try {
    const orderHash = await submitAddOrder({ intent, signedPermit, auth });
    s4.stop("Order submitted");
    p.log.success(
      `Slow swap submitted to Turbine\n` +
        `  order hash: ${orderHash}\n` +
        `  It fills patiently over ${durationInput || "10"} min — track it at https://app.turbine.exchange`,
    );
  } catch (err) {
    s4.stop("Submission failed");
    reportError(err);
  }
}
