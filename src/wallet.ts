import { createWalletClient, http, serializeSignature, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, network } from "./env.js";

export function createSaltWalletClient() {
  const account = privateKeyToAccount(env.privateKey);
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

export type SaltWalletClient = ReturnType<typeof createSaltWalletClient>;

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
