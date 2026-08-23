import { createWalletClient, http } from "viem";
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
