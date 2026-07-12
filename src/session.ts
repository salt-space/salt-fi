import fs from "node:fs";
import path from "node:path";
import { Salt } from "@kagamidigital/salt-sdk-mirror";
import { isAuthExpired } from "./errors.js";
import type { SaltWalletClient } from "./wallet.js";

const SESSION_FILE = path.resolve(process.cwd(), ".salt-session.json");
const DOMAIN = "testnet.salt.space";

type StoredSessions = Record<string, { authToken: string }>;

function readStoredSessions(): StoredSessions {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")) as StoredSessions;
  } catch {
    return {};
  }
}

function writeStoredSession(address: string, authToken: string): void {
  const sessions = readStoredSessions();
  sessions[address.toLowerCase()] = { authToken };
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
 */
export async function loadSalt(walletClient: SaltWalletClient): Promise<Salt> {
  const address = walletClient.account.address.toLowerCase();
  const stored = readStoredSessions()[address];

  if (stored) {
    const salt = new Salt({ environment: "TESTNET", domain: DOMAIN, authToken: stored.authToken });
    try {
      await salt.getOrganisations();
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
  writeStoredSession(address, authToken);
  return salt;
}
