import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { env } from "./env.js";

export function createSaltWalletClient() {
  const account = privateKeyToAccount(env.privateKey);
  return createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(env.rpcUrl),
  });
}

export type SaltWalletClient = ReturnType<typeof createSaltWalletClient>;
