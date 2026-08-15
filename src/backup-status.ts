import type { Salt, SaltAccount } from "salt-sdk";
import type { SaltWalletClient } from "./wallet.js";

/**
 * Is an account's keyshare backup complete?
 *
 * Salt's HTTP API briefly exposed a `keysharesBackedUp` boolean, but it was a
 * raw backend field — never part of the SDK's typed `SaltAccount` — and it has
 * since been removed from the responses (as of 2026-08 it's absent from both
 * `getAccount` and `getAccounts`). Don't depend on it: the durable, typed signal
 * is the account object itself.
 *
 * A finalized, backed-up account has:
 *   • a non-empty {@link SaltAccount.publicKey} (set only once keygen completes;
 *     `evmAddress` is derived from it, and is `undefined` while still mid-setup), and
 *   • a {@link SaltAccount.keyshares} map carrying a backup record for every signer.
 *
 * This is a *passive* check — it reads state the API already returns, no network
 * round-trip. For an *active* integrity check (does a threshold of the shares
 * actually produce a valid signature?) use {@link verifyKeyshareBackup}.
 */
export function isKeyshareBackedUp(
  account: Pick<SaltAccount, "publicKey" | "keyshares" | "signers">,
): boolean {
  // Not finalized yet — keygen hasn't produced the account key.
  if (!account.publicKey) return false;

  // Every signer should have at least one backed-up keyshare record. Compare
  // case-insensitively: the map is keyed by signer address and checksum casing
  // can differ between the `signers` list and the `keyshares` keys.
  const backedUp = new Set(Object.keys(account.keyshares ?? {}).map((a) => a.toLowerCase()));
  return account.signers.length > 0 && account.signers.every((s) => backedUp.has(s.toLowerCase()));
}

/** A short human label for an account's backup state — for lists and confirmations. */
export function backupStatusLabel(
  account: Pick<SaltAccount, "publicKey" | "keyshares" | "signers">,
): string {
  if (!account.publicKey) return "setup incomplete";
  return isKeyshareBackedUp(account) ? "backed up ✓" : "backup incomplete";
}

/**
 * Actively verify an account's keyshare backup by asking Salt to exercise the
 * shares: {@link Salt.verifyAccount} runs a recovery-path and a regular-path
 * signing ceremony, and returns both signatures. If it resolves, the shares are
 * valid and the account is recoverable; if the backup is broken it rejects.
 *
 * Needs a `signer` that is one of the account's signers (the same wallet client
 * used to create/join it). Returns `true` on success, `false` if verification
 * fails — the caller can surface the thrown reason for detail.
 */
export async function verifyKeyshareBackup(
  salt: Salt,
  accountId: string,
  signer: SaltWalletClient,
): Promise<boolean> {
  try {
    await salt.verifyAccount({ accountId, signer });
    return true;
  } catch {
    return false;
  }
}
