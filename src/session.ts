import fs from "node:fs";
import path from "node:path";
import { Salt } from "salt-sdk";
import { isAuthExpired } from "./errors.js";
import type { SaltWalletClient } from "./wallet.js";

const SESSION_FILE = path.resolve(process.cwd(), ".salt-session.json");
const DOMAIN = "testnet.salt.space";

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
 */
export async function loadSalt(walletClient: SaltWalletClient): Promise<Salt> {
  const address = walletClient.account.address.toLowerCase();
  const stored = readStoredSessions()[address];

  if (stored) {
    // Pass the refresh token too so the SDK auto-refreshes an expired access
    // token; without it a cached session dies on expiry.
    const salt = new Salt({
      environment: "TESTNET",
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
      return salt;
    } catch (err) {
      if (isAuthExpired(err)) {
        clearStoredSession(address);
      } else {
        throw err;
      }
    }
  }

  const salt = new Salt({ environment: "TESTNET", domain: DOMAIN });
  const authToken = await salt.authenticate(walletClient);
  writeStoredSession(address, { authToken, refreshToken: salt.getRefreshToken() ?? undefined });
  return salt;
}
