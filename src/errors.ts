import * as p from "@clack/prompts";
import {
  ApiError,
  InsufficientGas,
  InsufficientPermissions,
  InvalidAuthToken,
  InvalidSigner,
  SocketConnectError,
  ValidationError,
  WrongChain,
} from "@kagamidigital/salt-sdk-mirror";

export function formatSaltError(err: unknown): string {
  if (err instanceof InvalidAuthToken) {
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
  if (err instanceof InsufficientGas) {
    return "The signer doesn't have enough gas on Arbitrum Sepolia to complete this action.";
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
    return err.message;
  }
  return String(err);
}

/**
 * Logs a friendly message for command-level errors. Re-throws `InvalidAuthToken`
 * so the top-level menu loop can clear the cached session and prompt a restart,
 * instead of every command needing to special-case it.
 */
export function reportError(err: unknown): void {
  if (err instanceof InvalidAuthToken) {
    throw err;
  }
  p.log.error(formatSaltError(err));
}
