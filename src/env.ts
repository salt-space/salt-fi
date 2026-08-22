import "dotenv/config";
import type { Chain } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

/** The Salt deployments this app can run against, selected per-process via `SALT_ENV`. */
export type SaltEnv = "testnet" | "mainnet";

export interface SaltNetwork {
  saltEnv: SaltEnv;
  /** SDK `environment` string passed to `new Salt(...)`. */
  environment: "TESTNET" | "MAINNET";
  /** SIWE domain the session authenticates from. Robo/seed config is only returned
   *  to sessions on the environment's privileged domain, so this must match SALT_ENV. */
  domain: string;
  /** The chain the signer's walletClient is configured for — Salt's on-chain shard
   *  registry (Arbitrum One on mainnet, Arbitrum Sepolia on testnet). The signer never
   *  pays gas here; Salt does. Not where transactions execute (that's per-transfer). */
  shardRegistryChain: Chain;
  /** Human label for prompts/logs. */
  label: string;
}

const NETWORKS: Record<SaltEnv, Omit<SaltNetwork, "saltEnv">> = {
  testnet: {
    environment: "TESTNET",
    domain: "testnet.salt.space",
    shardRegistryChain: arbitrumSepolia,
    label: "Testnet",
  },
  mainnet: {
    environment: "MAINNET",
    domain: "app.salt.space",
    // Public salt-sdk exposes MAINNET as of 0.0.39. Real funds — see README.
    shardRegistryChain: arbitrum,
    label: "Mainnet",
  },
};

function resolveSaltEnv(): SaltEnv {
  const raw = (process.env.SALT_ENV ?? "testnet").toLowerCase();
  if (raw === "testnet" || raw === "mainnet") return raw;
  throw new Error(
    `Invalid SALT_ENV "${process.env.SALT_ENV}". Expected one of: testnet, mainnet ` +
      "(use the dev:testnet / dev:mainnet scripts).",
  );
}

/** The Salt deployment this process is running against (defaults to testnet). */
export const network: SaltNetwork = (() => {
  const saltEnv = resolveSaltEnv();
  return { saltEnv, ...NETWORKS[saltEnv] };
})();

export const env = {
  get privateKey(): `0x${string}` {
    const key = requireEnv("PRIVATE_KEY");
    if (!key.startsWith("0x")) {
      throw new Error("PRIVATE_KEY must be a 0x-prefixed hex string");
    }
    return key as `0x${string}`;
  },
};
