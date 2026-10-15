import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { Salt } from "salt-sdk";
import { env, network } from "./env.js";
import { isAuthExpired } from "./errors.js";
import { installFees } from "./fees.js";
import { installPolicyCompat } from "./policy-compat.js";
import type { SaltWalletClient } from "./wallet.js";

// Session cache is scoped per environment so a testnet token is never reused
// against mainnet (or vice-versa) when switching SALT_ENV.
const SESSION_FILE = path.resolve(process.cwd(), `.salt-session.${network.saltEnv}.json`);
const DOMAIN = network.domain;

type StoredSession = { authToken: string; refreshToken?: string };
type StoredSessions = Record<string, StoredSession>;

function readStoredSessions(): StoredSessions {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")) as StoredSessions;
  } catch {
    return {};
  }
}

function writeStoredSession(address: string, session: StoredSession): void {
  const sessions = readStoredSessions();
  sessions[address.toLowerCase()] = session;
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

export function clearStoredSession(address: string): void {
  const sessions = readStoredSessions();
  delete sessions[address.toLowerCase()];
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

/**
 * Reuses a cached auth token for this wallet's address if it still verifies
 * against the API, otherwise falls back to a fresh SIWE signature via
 * `walletClient` and caches the resulting token for next time. Sessions are
 * keyed by address so switching PRIVATE_KEY doesn't reuse another wallet's
 * cached token.
 *
 * We also persist and reuse the SDK's **refresh token** so a cached session can
 * auto-refresh an expired (~20-min) access token instead of failing on expiry.
 *
 * `savedSession` says whether the cached token was reused, i.e. nothing was signed.
 *
 * Either way the instance comes back with fee payment (src/fees.ts) and the policy-signing
 * shim (src/policy-compat.ts) hooked in. Both are no-ops on salt-sdk 0.0.43 and earlier.
 */
export async function loadSalt(walletClient: SaltWalletClient): Promise<{ salt: Salt; savedSession: boolean }> {
  const address = walletClient.account.address.toLowerCase();
  const stored = readStoredSessions()[address];

  if (stored) {
    // Pass the refresh token too so the SDK auto-refreshes an expired access
    // token; without it a cached session dies on expiry.
    const salt = new Salt({
      environment: network.environment,
      domain: DOMAIN,
      authToken: stored.authToken,
      refreshToken: stored.refreshToken,
    });
    try {
      await salt.getOrganisations();
      // A refresh may have rotated the refresh token — persist the latest.
      writeStoredSession(address, {
        authToken: stored.authToken,
        refreshToken: salt.getRefreshToken() ?? stored.refreshToken,
      });
      return { salt: withCompat(salt, walletClient), savedSession: true };
    } catch (err) {
      if (isAuthExpired(err)) {
        clearStoredSession(address);
      } else {
        throw err;
      }
    }
  }

  const salt = new Salt({ environment: network.environment, domain: DOMAIN });
  const authToken = await salt.authenticate(walletClient);
  writeStoredSession(address, { authToken, refreshToken: salt.getRefreshToken() ?? undefined });
  return { salt: withCompat(salt, walletClient), savedSession: false };
}

/** Hook in fee payment and the policy-signing shim, so no call site has to know about either. */
const withCompat = (salt: Salt, walletClient: SaltWalletClient): Salt =>
  installPolicyCompat(installFees(salt, walletClient), walletClient);

/**
 * Ensure this Salt instance has a **live-authenticated signer public key** before an
 * operation that backs up a keyshare — i.e. before {@link Salt.createAccount}.
 *
 * The SDK recovers the signer's public key during `authenticate()` (from the SIWE
 * signature). Older SDKs held it only IN MEMORY on the instance as
 * {@link Salt.userPublicKey}, so a session rehydrated from a cached token (the fast
 * path in {@link loadSalt}) had a valid JWT but no public key. salt-sdk 0.0.43 also
 * reads it from the token's claims, so this is usually a no-op now. Without it,
 * account creation's keyshare backup fails with:
 *
 *   "Cannot back up a keyshare without the owner public key. It is recovered during
 *    `Salt.authenticate`; a session restored from a stored auth token does not carry it."
 *
 * Calling this right before `createAccount` re-authenticates only when the public key
 * is missing, so token caching still speeds up ordinary read calls.
 */
export async function ensureSignerPublicKey(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  if (salt.userPublicKey) return;
  // Say so: after a saved-session start, this is the first signature of the run.
  const s = p.spinner();
  s.start(`Signing in again for your public key${env.signer === "ledger" ? " (confirm on your Ledger)" : ""}`);
  try {
    await salt.authenticate(walletClient);
    s.stop("Signed in");
  } catch (err) {
    s.error("Sign-in failed");
    throw err;
  }
}
