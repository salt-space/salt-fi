import * as p from "@clack/prompts";
import {
  ApiError,
  BroadcastRejectedError,
  InsufficientFunds,
  InsufficientPermissions,
  InvalidAddress,
  InvalidAuthToken,
  InvalidSigner,
  KeyshareBackupFailedError,
  KeyshareBackupUnavailableError,
  PaymentAuthorisationError,
  PolicyBreachError,
  RoboStatusError,
  SocketConnectError,
  TransactionPendingError,
  TransactionReplacedError,
  TransactionRevertedError,
  ValidationError,
} from "salt-sdk";
import { CHAIN_NAME_BY_ID } from "./chains.js";
import { MESSAGE_POLICY_TYPES, POLICY_TYPE_LABEL } from "./policies.js";

/**
 * Whether `err` means the current session's token is expired/rejected and a
 * fresh SIWE sign-in is needed. `InvalidAuthToken` covers client-side/malformed
 * tokens (e.g. caught by the constructor), but a server-rejected *expired*
 * token — the common case for a stale cached session — actually comes back
 * as a generic `ApiError` with `status === 401`, despite what some SDK doc
 * comments (e.g. on `getOrganisations`) claim.
 */
export function isAuthExpired(err: unknown): boolean {
  return err instanceof InvalidAuthToken || (err instanceof ApiError && err.status === 401);
}

/**
 * Whatever an API error's body says beyond its `message` and `code` — e.g. which
 * field failed validation — on its own line as compact JSON. The message alone
 * can be as vague as "Invalid payload structure".
 */
function apiErrorDetails(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "";
  const { message: _message, code: _code, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length === 0) return "";
  const json = JSON.stringify(rest);
  return `\n${json.length > 800 ? `${json.slice(0, 800)}…` : json}`;
}

export function formatSaltError(err: unknown): string {
  if (isAuthExpired(err)) {
    return "Auth token is invalid or expired. You'll need to sign in again.";
  }
  if (err instanceof InsufficientPermissions) {
    // A suspended collaborator is refused everything in the organisation, even reading it.
    // Newer Salt API releases say so with "unauthorized:suspended"; older ones send a bare
    // "unauthorized:no-role", the same as for someone with no role there at all.
    const reason = (err.body as { message?: unknown } | undefined)?.message;
    if (reason === "unauthorized:suspended") {
      return (
        "You're suspended in this organisation, so Salt won't let you do anything in it. " +
        "An owner has to restore you (Organisation → Manage collaborators → Restore)."
      );
    }
    if (reason === "unauthorized:no-role") {
      return (
        "Salt says you have no active role in this organisation, which usually means you've been suspended (or removed). " +
        "An owner can restore a suspended collaborator under Organisation → Manage collaborators."
      );
    }
    return "Your access level in this organisation doesn't permit that action.";
  }
  if (err instanceof InvalidSigner) {
    return "The wallet client has no attached signer account.";
  }
  if (err instanceof InsufficientFunds) {
    // The SDK's own error already names the real chain this transaction was for — this app now
    // submits transactions on more than just Arbitrum Sepolia (e.g. HyperEVM, chain 998, for
    // Hyperliquid deposits), so a chain-agnostic message here matters, not just a nicety. Falls
    // back to the bare chain id for anything not in CHAIN_NAME_BY_ID rather than guessing a name.
    const chainId = (err as { details?: { chainId?: number } }).details?.chainId;
    const chainName = chainId !== undefined ? (CHAIN_NAME_BY_ID[String(chainId)] ?? `chain ${chainId}`) : "the target chain";
    return `The signer doesn't have enough gas on ${chainName} to complete this action. Deposit native currency to the account to proceed.`;
  }
  if (err instanceof RoboStatusError) {
    // The SDK deliberately leaves `cause`/`code` empty and puts the actionable
    // detail in `message` — e.g. "… host is not active. Activate your host via
    // 2FA Flow" (needs activation) vs "robo quorum not met … (need N, M online)"
    // (offline). Surfacing our own generic "…offline…" text hid the activation
    // case entirely, which is the usual reason people get stuck. Pass it through,
    // with a pointer to where the fixes live.
    return `${err.message}\n(Robo Guardians → "Activate Robo Guardians" to complete 2FA, or "Check robo guardians" to see who's online.)`;
  }
  if (err instanceof PolicyBreachError) {
    // From salt-sdk 0.0.45 messages are policy-checked too, and the SDK's own text says
    // "Transaction blocked" for them as well.
    const types = [...new Set(err.rejectedPolicies.map((pol) => pol.type))];
    if (types.some((type) => MESSAGE_POLICY_TYPES.includes(type))) {
      return (
        `Message signing is blocked by this account's "${POLICY_TYPE_LABEL.denied_message_proposers}" policy. ` +
        'New accounts start with every signer on it; an owner can remove signers from it under Policies → "Manage policies".'
      );
    }
    return `Blocked by this account's policies: ${types.map((type) => POLICY_TYPE_LABEL[type] ?? type).join(", ")}. An owner can change them under Policies → "Manage policies".`;
  }
  if (err instanceof BroadcastRejectedError) {
    return `${err.message}\nThe transaction wasn't accepted. Submitting it again is safe: it reuses the same nonce, so at most one can execute.`;
  }
  if (err instanceof TransactionReplacedError) {
    return `${err.message}\nThis transaction can no longer execute. If the replacement was a resubmission of it, that one already went through.`;
  }
  if (err instanceof TransactionRevertedError) {
    return `${err.message}. Gas was spent; nothing else changed.`;
  }
  if (err instanceof PaymentAuthorisationError) {
    return `The fee payer (${err.payer}) couldn't sign Salt's fee, so nothing was created and starting again is a clean retry.\n${formatSaltError(err.cause)}`;
  }
  if (err instanceof KeyshareBackupFailedError) {
    return "Salt couldn't back up the new account's key share. This can be temporary: creating the account again may work.";
  }
  if (err instanceof KeyshareBackupUnavailableError) {
    return "Salt can't back up new accounts' key shares right now (it pays for that on-chain backup and currently can't). Nothing on your side can fix this: contact Salt, then create the account again.";
  }
  if (err instanceof InvalidAddress) {
    return "That's not a valid address.";
  }
  if (err instanceof SocketConnectError) {
    return "Couldn't establish the websocket connection required for this action. Check your network and retry.";
  }
  if (err instanceof ValidationError) {
    return `Invalid input: ${err.message}`;
  }
  if (err instanceof ApiError && err.status === 402) {
    // x402: Salt charges a fee for this call and no accepted payment came with it — usually
    // because nobody is set to pay (the default on mainnet). See src/fees.ts.
    return (
      `Salt charges a fee for this, and it wasn't paid (${err.message}). Choose who pays under ` +
      'Fees (x402) → "Choose who pays", or set SALT_FEE_PAYER in .env (see "Fees (x402)" in the README).'
    );
  }
  if (err instanceof ApiError) {
    return `API error: ${err.message}${err.code ? ` [${err.code}]` : ""}${apiErrorDetails(err.body)}`;
  }
  if (err instanceof Error) {
    // Node's fetch throws a generic "fetch failed" TypeError for any
    // network-level failure (DNS, connection reset, timeout, TLS, ...),
    // with the actual reason only available on `.cause` — surface it rather
    // than leaving just the opaque top-level message.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      return `${err.message}: ${cause.message}`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Logs a friendly message for command-level errors. Re-throws expired-session
 * errors (see `isAuthExpired`) so the top-level menu loop can clear the cached
 * session and prompt a restart, instead of every command needing to
 * special-case it.
 */
export function reportError(err: unknown): void {
  if (isAuthExpired(err)) {
    throw err;
  }
  p.log.error(formatSaltError(err));
}

/**
 * Recover a broadcast transaction hash from an error thrown while *waiting for
 * its receipt*. A ceremony broadcasts before it confirms, so such an error means
 * "couldn't read the receipt", NOT "the transaction failed"; callers use this to
 * report the hash instead of a misleading failure (which could trigger a
 * dangerous re-send).
 *
 * salt-sdk 0.0.45 says which case it is: `TransactionPendingError` carries the
 * hash, and a refused, replaced or reverted transaction is settled (its error
 * names the hash too, but there is nothing left to wait for). Anything else falls
 * back to the hash in the message — a viem receipt-timeout (`…hash "0x…"`) or a
 * failed `eth_getTransactionReceipt` call (the hash is in the request body),
 * matching exactly 64 hex chars not part of a longer hex blob (so it won't grab
 * calldata). Returns undefined if no hash is present.
 */
export function txHashFromError(err: unknown): `0x${string}` | undefined {
  if (err instanceof TransactionPendingError) return err.txHash;
  if (err instanceof BroadcastRejectedError || err instanceof TransactionReplacedError || err instanceof TransactionRevertedError) {
    return undefined;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/);
  return match ? (match[0] as `0x${string}`) : undefined;
}
