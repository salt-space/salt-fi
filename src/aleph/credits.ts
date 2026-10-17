import { createPublicClient, createWalletClient, erc20Abi, fallback, getAddress, type Hex, http, type PrivateKeyAccount } from "viem";
import { mainnet } from "viem/chains";
import { rpcUrl } from "../chains.js";
import { ALEPH_API } from "./client.js";

/**
 * Buying Aleph credits (as Aleph's CLI, `aleph credit buy`, and app.aleph.cloud do it). There's no
 * purchase function: you send USDC, ETH or ALEPH to Aleph's credit contract on Ethereum mainnet (only),
 * and Aleph's indexer credits the address the payment came FROM, usually within a minute or so
 * (occasionally a few minutes, rarely hours). There's no recipient parameter, so the Aleph wallet
 * pays for itself.
 *
 *   USDC  a plain USDC.transfer(contract, amount), ~45k gas; exactly 1,000,000 credits per USDC
 *   ETH   a plain send to the contract, ~28k gas (more than 21k: it's a proxy); at the market price
 *
 * This is always Ethereum mainnet and real funds, whichever Salt environment the app is on. Sent to
 * that address on any other chain, the funds are lost: there's no contract there.
 */

/** Aleph's credit contract (AlephPaymentProcessor, an ERC1967 proxy) on Ethereum mainnet. */
export const CREDIT_CONTRACT = "0x6b55F32Ea969910838defd03746Ced5E2AE8cB8B" as const;
/** Its implementation when this was written; a different one is flagged before paying. */
const KNOWN_IMPLEMENTATION = "0x5c62734eca6c5f44f8aa122a05e5eef627eec0bd";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
export const CREDITS_PER_USDC = 1_000_000;

// The app's Ethereum RPC (SALT_RPC_1 overrides it; see src/chains.ts), then viem's default.
const transport = fallback([http(rpcUrl("1"), { timeout: 15_000 }), http(undefined, { timeout: 15_000 })]);
const publicClient = createPublicClient({ chain: mainnet, transport });

export interface PayerFunds {
  eth: bigint;
  usdc: bigint; // 6 decimals
  gasPrice?: bigint;
}

/** What the paying wallet holds on Ethereum, and the gas price now. */
export async function payerFunds(address: `0x${string}`): Promise<PayerFunds> {
  const [eth, usdc, gasPrice] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: USDC_ETHEREUM, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    publicClient.getGasPrice().catch(() => undefined),
  ]);
  return { eth, usdc, gasPrice };
}

/**
 * Is the credit contract where we expect it? Code at the address, and the implementation it points
 * to. Returns a warning to show (and confirm past) when the implementation has changed; throws when
 * there's no contract at all.
 */
export async function checkCreditContract(): Promise<string | undefined> {
  const code = await publicClient.getCode({ address: CREDIT_CONTRACT });
  if (!code || code === "0x") throw new Error(`No contract at Aleph's credit address ${CREDIT_CONTRACT} on Ethereum. Not paying.`);
  const slot = await publicClient.getStorageAt({ address: CREDIT_CONTRACT, slot: IMPLEMENTATION_SLOT });
  const impl = slot ? `0x${slot.slice(-40)}`.toLowerCase() : undefined;
  if (impl !== KNOWN_IMPLEMENTATION) {
    return `Aleph's credit contract now points at implementation ${impl ?? "unknown"} (this app knows ${KNOWN_IMPLEMENTATION}). Aleph may have upgraded it; check before paying.`;
  }
  return undefined;
}

/** Estimated gas for the payment (falls back to a generous fixed figure if the node won't estimate). */
export async function estimatePaymentGas(from: `0x${string}`, pay: { usdc: bigint } | { eth: bigint }): Promise<bigint> {
  try {
    return "usdc" in pay
      ? await publicClient.estimateContractGas({ account: from, address: USDC_ETHEREUM, abi: erc20Abi, functionName: "transfer", args: [CREDIT_CONTRACT, pay.usdc] })
      : await publicClient.estimateGas({ account: from, to: CREDIT_CONTRACT, value: pay.eth });
  } catch {
    return "usdc" in pay ? 65_000n : 40_000n;
  }
}

/** Pay Aleph's credit contract from `account` on Ethereum, and wait for it to be mined. Returns the tx hash. */
export async function payForCredits(account: PrivateKeyAccount, pay: { usdc: bigint } | { eth: bigint }): Promise<Hex> {
  const wallet = createWalletClient({ account, chain: mainnet, transport });
  const hash =
    "usdc" in pay
      ? await wallet.writeContract({ address: USDC_ETHEREUM, abi: erc20Abi, functionName: "transfer", args: [CREDIT_CONTRACT, pay.usdc] })
      : await wallet.sendTransaction({ to: CREDIT_CONTRACT, value: pay.eth, gas: await estimatePaymentGas(account.address, pay) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (receipt.status !== "success") throw new Error(`The payment ${hash} reverted.`);
  return hash;
}

/**
 * The credits Aleph granted for a payment, from the wallet's credit history (undefined if not there yet).
 * The endpoint 404s on a lower-case address, so the address is checksummed first.
 */
export async function creditsFor(address: string, txHash: string): Promise<number | undefined> {
  const res = await fetch(`${ALEPH_API}/api/v0/addresses/${getAddress(address)}/credit_history?page=1&pagination=50&direction=incoming`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { credit_history?: { tx_hash?: string | null; amount?: number | string }[] };
  const row = (body.credit_history ?? []).find((r) => r.tx_hash?.toLowerCase() === txHash.toLowerCase());
  return row ? Number(row.amount) : undefined;
}
