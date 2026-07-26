import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { env } from "./env.js";

export function createSaltWalletClient() {
  const account = privateKeyToAccount(env.privateKey);
  return createWalletClient({
    account,
    chain: arbitrumSepolia,
    // No custom RPC: the signer only signs (SIWE + keygen shares, done locally /
    // over the websocket) and never sends a transaction, so viem's default
    // public RPC for the chain is all that's ever needed.
    transport: http(),
  });
}

export type SaltWalletClient = ReturnType<typeof createSaltWalletClient>;
