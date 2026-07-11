import fs from "node:fs";
import path from "node:path";
import { InvalidAuthToken, Salt } from "@kagamidigital/salt-sdk-mirror";
import type { SaltWalletClient } from "./wallet.js";

const SESSION_FILE = path.resolve(process.cwd(), ".salt-session.json");
const DOMAIN = "testnet.salt.space";

interface StoredSession {
  authToken: string;
}

function readStoredSession(): StoredSession | undefined {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")) as StoredSession;
  } catch {
    return undefined;
  }
}

function writeStoredSession(session: StoredSession): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

export function clearStoredSession(): void {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    // nothing to clear
  }
}

/**
 * Reuses a cached auth token if it still verifies against the API, otherwise
 * falls back to a fresh SIWE signature via `walletClient` and caches the
 * resulting token for next time.
 */
export async function loadSalt(walletClient: SaltWalletClient): Promise<Salt> {
  const stored = readStoredSession();
  if (stored) {
    const salt = new Salt({ environment: "TESTNET", domain: DOMAIN, authToken: stored.authToken });
    try {
      await salt.getOrganisations();
      return salt;
    } catch (err) {
      if (err instanceof InvalidAuthToken) {
        clearStoredSession();
      } else {
        throw err;
      }
    }
  }

  const salt = new Salt({ environment: "TESTNET", domain: DOMAIN });
  const authToken = await salt.authenticate(walletClient);
  writeStoredSession({ authToken });
  return salt;
}
