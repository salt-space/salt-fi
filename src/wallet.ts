import * as p from "@clack/prompts";
import { createWalletClient, http, serializeSignature, toHex, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, network } from "./env.js";
import { ledgerAccount, usbConnection } from "./ledger.js";

/**
 * The signer's wallet, keyed by `SIGNER`: a raw key from PRIVATE_KEY, or a Ledger.
 * Either way the Salt SDK only asks it for signatures — EIP-191 messages and
 * EIP-712 typed data — never for key material.
 */
export async function createSaltWalletClient() {
  let account: LocalAccount;
  if (env.signer === "ledger") {
    const path = env.ledgerPath;
    const connection = usbConnection({
      debug: env.ledgerDebug,
      onWaiting: () =>
        p.log.warn(
          "Your Ledger isn't showing up over USB. Reconnect it (a loose cable can drop it), unlock it and open " +
            "the Ethereum app — waiting up to a minute.",
        ),
    });
    account = await ledgerAccount(path, connection);
    checkLedger = () => connection((eth) => eth.getAddress(path, false));
  } else {
    account = privateKeyToAccount(env.privateKey);
  }
  return createWalletClient({
    account,
    // The env's shard-registry chain (Arbitrum One on mainnet, Arbitrum Sepolia on
    // testnet). The signer only signs (SIWE + keygen shares, done locally / over the
    // websocket) and never sends a transaction, so viem's default public RPC is all
    // that's ever needed — and the signer never pays gas on this chain (Salt does).
    chain: network.shardRegistryChain,
    transport: http(),
  });
}

export type SaltWalletClient = Awaited<ReturnType<typeof createSaltWalletClient>>;

let checkLedger: (() => Promise<unknown>) | undefined;

/**
 * Make sure the signer can be reached before starting something that can't be
 * cleanly undone. For a Ledger that means talking to it (nothing to confirm on the
 * device), waiting for it if it dropped off USB; for a private key, nothing.
 */
export async function ensureSignerReachable(): Promise<void> {
  await checkLedger?.();
}

/**
 * Normalise the SDK's `{ r, s, v }` EvmSignature into a serialized hex string —
 * what `verifyMessage` and any external verifier expect. Shared by every flow that
 * consumes a Salt signing ceremony's result.
 */
export function toHexSig(s: unknown): Hex {
  if (typeof s === "string") return s as Hex;
  const o = s as { r: unknown; s: unknown; v?: unknown; yParity?: number };
  const hexify = (x: unknown): Hex => (typeof x === "bigint" ? toHex(x, { size: 32 }) : (x as Hex));
  return serializeSignature({ r: hexify(o.r), s: hexify(o.s), v: BigInt((o.v as number | bigint) ?? (o.yParity! + 27)) });
}
