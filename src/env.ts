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
  /** Whether this deployment's chains carry real value. Code that spends money (like
   *  paying a fee) keys its defaults on this rather than on the environment's name. */
  realFunds: boolean;
}

const NETWORKS: Record<SaltEnv, Omit<SaltNetwork, "saltEnv">> = {
  testnet: {
    environment: "TESTNET",
    domain: "testnet.salt.space",
    shardRegistryChain: arbitrumSepolia,
    label: "Testnet",
    realFunds: false,
  },
  mainnet: {
    environment: "MAINNET",
    domain: "app.salt.space",
    // Public salt-sdk exposes MAINNET as of 0.0.39. Real funds — see README.
    shardRegistryChain: arbitrum,
    label: "Mainnet",
    realFunds: true,
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

/** Where the signer's key lives: a raw key in PRIVATE_KEY, or on a Ledger over USB. */
export type SignerKind = "private-key" | "ledger";

/** Ledger Live's first Ethereum account. Ledger Live's account N is `44'/60'/N'/0/0`. */
const DEFAULT_LEDGER_PATH = "44'/60'/0'/0/0";

export const env = {
  get signer(): SignerKind {
    const raw = (process.env.SIGNER ?? "private-key").toLowerCase();
    if (raw === "private-key" || raw === "ledger") return raw;
    throw new Error(`Invalid SIGNER "${process.env.SIGNER}". Expected one of: private-key, ledger (see .env.example)`);
  },
  /** BIP-32 derivation path of the Ledger account to sign with. */
  get ledgerPath(): string {
    const path = process.env.LEDGER_PATH || DEFAULT_LEDGER_PATH;
    if (!/^(m\/)?\d+'?(\/\d+'?)*$/.test(path)) {
      throw new Error(`Invalid LEDGER_PATH "${path}". Expected a derivation path like ${DEFAULT_LEDGER_PATH}`);
    }
    return path;
  },
  /** LEDGER_DEBUG=1 prints Ledger USB connection events to stderr. */
  get ledgerDebug(): boolean {
    return process.env.LEDGER_DEBUG === "1";
  },
  get privateKey(): `0x${string}` {
    const key = requireEnv("PRIVATE_KEY");
    if (!key.startsWith("0x")) {
      throw new Error("PRIVATE_KEY must be a 0x-prefixed hex string");
    }
    return key as `0x${string}`;
  },
};
