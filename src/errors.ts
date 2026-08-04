import * as p from "@clack/prompts";
import {
  ApiError,
  InsufficientFunds,
  InsufficientPermissions,
  InvalidAddress,
  InvalidAuthToken,
  InvalidSigner,
  RoboStatusError,
  SocketConnectError,
  ValidationError,
  WrongChain,
} from "salt-sdk";

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

export function formatSaltError(err: unknown): string {
  if (isAuthExpired(err)) {
    return "Auth token is invalid or expired. You'll need to sign in again.";
  }
  if (err instanceof InsufficientPermissions) {
    return "Your access level in this organisation doesn't permit that action.";
  }
  if (err instanceof InvalidSigner) {
    return "The wallet client has no attached signer account.";
  }
  if (err instanceof WrongChain) {
    return "Your wallet is connected to the wrong chain for this environment (expected Arbitrum Sepolia, 421614).";
  }
  if (err instanceof InsufficientFunds) {
    return "The signer doesn't have enough gas on Arbitrum Sepolia to complete this action.";
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
  if (err instanceof InvalidAddress) {
    return "That's not a valid address.";
  }
  if (err instanceof SocketConnectError) {
    return "Couldn't establish the websocket connection required for this action. Check your network and retry.";
  }
  if (err instanceof ValidationError) {
    return `Invalid input: ${err.message}`;
  }
  if (err instanceof ApiError) {
    return `API error: ${err.message}`;
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
