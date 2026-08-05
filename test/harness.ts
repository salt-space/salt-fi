import "dotenv/config";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { Salt } from "salt-sdk";

/**
 * Shared setup for the testnet integration suite. These tests drive the REAL
 * Salt SDK against `testnet.salt.space`, so they need a funded testnet identity
 * and (for the deeper flows) an online robo host. They self-skip when the
 * required credentials aren't present, so `npm test` stays green without them.
 *
 * Keys are read from env (via dotenv / `.env`):
 *   PRIVATE_KEY        — the primary test identity (owner)
 *   TEST_COLLAB_KEY    — a second identity, for invite/accept + multi-signer
 *                        account creation (optional; those tests skip without it)
 */
export const DOMAIN = "testnet.salt.space";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** A 0x-prefixed 32-byte private key from `name`, or undefined if absent/invalid. */
export function testKey(name: string): `0x${string}` | undefined {
  const k = process.env[name];
  return k && HEX32.test(k) ? (k as `0x${string}`) : undefined;
}

/** True when the primary test identity is configured (gates the suite). */
export const hasOwnerKey = (): boolean => Boolean(testKey("PRIVATE_KEY"));
/** True when a second identity is configured (gates invite/account tests). */
export const hasCollabKey = (): boolean => Boolean(testKey("TEST_COLLAB_KEY"));
/**
 * Opt-in for *write* tests that create real testnet state (orgs, invites, robo
 * hosts, accounts). Off by default so `npm test` stays read-only and doesn't
 * litter testnet — set `SALT_INTEGRATION_WRITE=1` to include them.
 */
export const canWrite = (): boolean => process.env.SALT_INTEGRATION_WRITE === "1";

export function walletFor(key: `0x${string}`) {
  return createWalletClient({ account: privateKeyToAccount(key), chain: arbitrumSepolia, transport: http() });
}

export interface SaltContext {
  salt: Salt;
  address: `0x${string}`;
}

/** Build a fresh Salt client for TESTNET and complete SIWE authentication. */
export async function authedSalt(key: `0x${string}`): Promise<SaltContext> {
  const wallet = walletFor(key);
  const salt = new Salt({ environment: "TESTNET", domain: DOMAIN });
  await salt.authenticate(wallet);
  return { salt, address: wallet.account.address };
}
