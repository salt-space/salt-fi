import { randomUUID } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { Salt } from "salt-sdk";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { toHexSig } from "./wallet.js";
import type { SaltWalletClient } from "./wallet.js";

/**
 * Hinkal client — confidential balances (shielded deposit / withdraw / transfer)
 * for a Salt account, via Hinkal's enclave API.
 *
 * ARCHITECTURE. Hinkal holds the *shielded* key (the one that decrypts UTXOs and
 * authorises ZK proofs) inside a GCP Confidential VM, encrypted at rest under Cloud
 * KMS. It never holds the wallet key. All it needs from us is proof that we control
 * the Salt account's address — so the whole integration is one signature, and every
 * Salt-side operation is something the app already does:
 *
 *   session open  →  salt.signPersonalMessage  (EIP-191, one MPC ceremony)
 *   deposit       →  salt.submitTx             (a plain contract call we broadcast)
 *   withdraw/xfer →  nothing on-chain from us  (Hinkal's relayer broadcasts)
 *
 * WHY SESSION MODE. Hinkal offers two auth modes. EIP-712 mode signs every single
 * operation with the wallet — which is what their Turnkey guide documents, and a bad
 * fit here: each of those nonces dies after 60 SECONDS, while a Salt signature is an
 * MPC ceremony waiting on Robo Guardians to join. One slow nudge round and the nonce
 * is dead. Normal mode (`useEIP712: false`) instead signs one consent message that
 * covers transactions too, and authenticates everything after it with an ephemeral
 * secp256k1 key held in this process. That's ONE ceremony per 24h and no deadline
 * anywhere. This module implements normal mode only; {@link HinkalSession.authMode}
 * exists to make that explicit if EIP-712 mode is ever added alongside it.
 *
 * The session key is generated per process and never persisted — losing it costs a
 * fresh signature, nothing more. It cannot move funds on its own: it only authorises
 * requests against a session already bound to the account's address.
 *
 * Verified live against api.hinkal.io (2026-08): `/supported-chains`,
 * `/supported-tokens`, `/contract-addresses`, and the request-signing scheme in
 * their Authentication doc. Nothing here has been exercised against a funded
 * mainnet account yet — see the caveats on {@link buildDeposit}.
 */

export const HINKAL_API = "https://api.hinkal.io";

/** Hinkal's native-asset sentinel — the same zero address the app uses elsewhere. */
export const HINKAL_NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/**
 * Chains Hinkal serves that Salt can also sign for. Hinkal's live `/supported-chains`
 * additionally lists BNB (56), Arc Testnet (5042002), Tempo (4217), Solana and Tron —
 * none of which are in the SDK's `SupportedChainId` — and does NOT list Optimism,
 * despite Hinkal's blog posts claiming it. Note what's absent: every testnet this app
 * runs on. There is no way to exercise this against play money, so every flow built on
 * it is mainnet-only, real funds, from the first commit.
 */
export const HINKAL_CHAIN_IDS = [1, 137, 8453, 42161] as const;
export type HinkalChainId = (typeof HINKAL_CHAIN_IDS)[number];

/** Arbitrum One — the overlap chain this module was prototyped against, and the one
 *  the app already routes Hyperliquid deposits through. */
export const HINKAL_DEFAULT_CHAIN: HinkalChainId = 42161;

export function isHinkalChain(chainId: number): chainId is HinkalChainId {
  return (HINKAL_CHAIN_IDS as readonly number[]).includes(chainId);
}

/**
 * An open Hinkal session. `privateKey` is the ephemeral secp256k1 key that signs
 * every subsequent request — in-memory only, never written to disk or logged.
 */
export interface HinkalSession {
  sessionId: string;
  privateKey: Uint8Array;
  clientPublicKey: string;
  /** The Salt account address the session is bound to. */
  address: Address;
  expiresAt: Date;
  authMode: "normal";
}

export interface HinkalBalance {
  chainId: number;
  tokenAddress: string;
  /** Balance in the token's smallest unit. */
  balance: string;
}

export interface HinkalToken {
  chainId: number;
  erc20TokenAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

/** Hinkal's per-chain contract set, from the public `/contract-addresses`. */
export interface HinkalContracts {
  hinkalAddress: Address;
  hinkalHelperAddress?: Address;
  hinkalWrapperAddress?: Address;
}

/**
 * An unsigned EVM transaction from `/deposit`, in ethers' `TransactionRequest`
 * shape. Amounts arrive as decimal strings; gas fields are advisory and dropped
 * by {@link depositCall} because Salt estimates its own.
 */
export interface HinkalTxData {
  to: string;
  data: string;
  value?: string;
  chainId?: number;
  gasLimit?: string;
}

// ---------------------------------------------------------------------------
// Request signing
// ---------------------------------------------------------------------------

/**
 * Compact secp256k1 signature over SHA-256 of `payload`, hex-encoded — the value
 * of the `x-hinkal-request-signature` header.
 *
 * Hinkal's docs write this as `.toBytes("compact")`, which is @noble/curves v2.
 * We're on v1.x, where the method is `toCompactRawBytes()`. Same 64 bytes either
 * way; if the dependency is ever bumped to v2 this one call has to change.
 */
function signPayload(privateKey: Uint8Array, payload: string): string {
  return bytesToHex(secp256k1.sign(sha256(utf8ToBytes(payload)), privateKey).toCompactRawBytes());
}

/**
 * `"<METHOD> <routePath>"` — bound into every signed digest so a signature captured
 * for `GET /balance` can't be replayed against `POST /withdraw`. `routePath` must be
 * the server's ROUTE PATTERN, not the concrete URL: `/private-send/:orderId`, never
 * `/private-send/abc123`.
 */
function actionBinding(method: "GET" | "POST", routePath: string): string {
  const withSlash = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${method} ${withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash}`;
}

async function hinkalError(res: Response, fallback: string): Promise<Error> {
  let msg = `${fallback} (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) msg = body.error;
  } catch {
    // non-JSON body — keep the status-based message
  }
  return new Error(msg);
}

/** Hinkal answers 200 with `{ success: false, error }` on some failures, so check both. */
async function readResult<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw await hinkalError(res, fallback);
  const body = (await res.json()) as { success: boolean; error?: string } & T;
  if (!body.success) throw new Error(body.error ?? fallback);
  return body;
}

/** Session-authenticated GET. Every request carries a fresh single-use nonce. */
async function hinkalGet<T>(
  session: HinkalSession,
  routePath: string,
  params: Record<string, string>,
  fallback: string,
): Promise<T> {
  const queryString = new URLSearchParams({
    ...params,
    sessionId: session.sessionId,
    nonce: randomUUID(),
    timestamp: String(Date.now()),
  }).toString();

  const res = await fetch(`${HINKAL_API}${routePath}?${queryString}`, {
    headers: { "x-hinkal-request-signature": signPayload(session.privateKey, `${actionBinding("GET", routePath)}\n${queryString}`) },
  });
  return readResult<T>(res, fallback);
}

/**
 * Session-authenticated POST. The signature covers the exact serialized body, so
 * the same string is signed and sent — never re-stringify between the two.
 */
async function hinkalPost<T>(
  session: HinkalSession,
  routePath: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const payload = JSON.stringify({
    ...body,
    sessionId: session.sessionId,
    nonce: randomUUID(),
    timestamp: Date.now(),
  });

  const res = await fetch(`${HINKAL_API}${routePath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hinkal-request-signature": signPayload(session.privateKey, `${actionBinding("POST", routePath)}\n${payload}`),
    },
    body: payload,
  });
  return readResult<T>(res, fallback);
}

// ---------------------------------------------------------------------------
// Public (unauthenticated) reads
// ---------------------------------------------------------------------------

/** Tokens Hinkal will shield on a chain. Keyless — safe to call before any session. */
export async function getSupportedTokens(chainId: number): Promise<HinkalToken[]> {
  const res = await fetch(`${HINKAL_API}/supported-tokens?chainId=${chainId}`);
  const { tokens } = await readResult<{ tokens: Record<string, HinkalToken[]> }>(res, "Hinkal token list unavailable");
  return tokens[String(chainId)] ?? [];
}

/**
 * Hinkal's deployed contracts for a chain. Keyless. Worth surfacing before anyone
 * builds a flow on this: `hinkalAddress` is the pool a deposit lands in, so it's the
 * address an `allowed_recipients` policy has to whitelist — and the moment it's
 * whitelisted, that policy stops constraining anything, because the account can then
 * pay any address on earth through the relayer. On Arbitrum One it's
 * 0x7cb60446d7635C68EDf1c568cac74A1f98c1Cfa4.
 */
export async function getContracts(chainId: number): Promise<HinkalContracts | undefined> {
  const res = await fetch(`${HINKAL_API}/contract-addresses`);
  const { addresses } = await readResult<{ addresses: Record<string, HinkalContracts> }>(res, "Hinkal contract lookup failed");
  return addresses[String(chainId)];
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** The exact message Hinkal's enclave rebuilds and verifies — byte-for-byte, or the session is refused. */
function sessionMessage(sessionId: string, clientPublicKey: string): string {
  return [
    "Authorize Hinkal session",
    `Session ID: ${sessionId}`,
    `Public Key: ${clientPublicKey}`,
    "This signature can also be used to submit transactions.",
  ].join("\n");
}

/**
 * Open a 24-hour Hinkal session for a Salt account.
 *
 * This is the only step that runs an MPC ceremony: the account's Robo Guardians
 * co-sign one EIP-191 message. Everything afterwards — balances, fees, deposits,
 * withdrawals, transfers — is authenticated by the ephemeral session key alone.
 *
 * We verify the ceremony's signature recovers to the account address before posting
 * it, the same check the "Sign a message" flow makes. Hinkal would reject a mismatch
 * anyway, but failing here names the real problem (wrong account) instead of
 * surfacing an opaque 401.
 */
export async function createSession(params: {
  salt: Salt;
  walletClient: SaltWalletClient;
  accountId: string;
  accountAddress: Address;
  /** Ceremony progress, for a spinner. */
  onProgress?: (message: string) => void;
  /** ISO-8601. Defaults to Hinkal's 24 hours. */
  expiresAt?: string;
}): Promise<HinkalSession> {
  const privateKey = new Uint8Array(randomBytes(32));
  const clientPublicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true));
  const sessionId = randomUUID();
  const address = getAddress(params.accountAddress);
  const message = sessionMessage(sessionId, clientPublicKey);

  const ceremony = await params.salt.signPersonalMessage({
    accountId: params.accountId,
    signer: params.walletClient,
    message,
  });
  ceremony.on("stateChanged", (event) => params.onProgress?.(`${event.stage}...`));
  ceremony.on("presence", (event) => params.onProgress?.(`waiting for signers: ${event.joined}/${event.total} joined`));
  const { signature: raw } = (await ceremony.wait()) as { signature: unknown };
  const signature = toHexSig(raw);

  if (!(await verifyMessage({ address, message, signature }))) {
    throw new Error("Session signature does not recover to the account address — wrong account?");
  }

  // `/create-session` is the one route signed with NO action binding: there's no
  // session yet to bind against, so the header covers the raw body only.
  const body = JSON.stringify({
    signature,
    address,
    sessionId,
    clientPublicKey,
    nonce: randomUUID(),
    useEIP712: false,
    ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
  });
  const res = await fetch(`${HINKAL_API}/create-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hinkal-request-signature": signPayload(privateKey, body),
    },
    body,
  });
  const { expiresAt } = await readResult<{ expiresAt: string }>(res, "Hinkal rejected the session");

  return { sessionId, privateKey, clientPublicKey, address, expiresAt: new Date(expiresAt), authMode: "normal" };
}

/** Whether a session is still usable. Hinkal answers `Session not found` once it isn't. */
export function sessionIsLive(session: HinkalSession): boolean {
  return session.expiresAt.getTime() > Date.now();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Shielded balances for the session's account. Zero-balance tokens are omitted. */
export async function getBalances(session: HinkalSession, chainId: HinkalChainId): Promise<HinkalBalance[]> {
  const { balances } = await hinkalGet<{ balances: HinkalBalance[] }>(
    session,
    "/balance",
    { chainId: String(chainId) },
    "Could not read shielded balance",
  );
  return balances;
}

/**
 * Shielded balance that is BLOCKED — "stuck" UTXOs, which Hinkal tracks separately
 * from {@link getBalances} and which a normal transfer or withdrawal cannot spend.
 * Recoverable only via `POST /withdraw-stuck-utxos`, straight to a public address.
 *
 * This matters for any "how much can I send?" arithmetic: if `/balance` counts notes
 * that `/transfer` refuses to spend, then balance minus fee overstates what is
 * actually spendable, and offering it as a maximum produces an insufficient-funds
 * failure at the enclave with a full-looking balance on screen.
 */
export async function getStuckBalances(session: HinkalSession, chainId: HinkalChainId): Promise<HinkalBalance[]> {
  const { balances } = await hinkalGet<{ balances: HinkalBalance[] }>(
    session,
    "/stuck-utxo-balance",
    { chainId: String(chainId) },
    "Could not read stuck UTXO balance",
  );
  return balances;
}

/**
 * This account's shielded receiving identifier, to hand to a sender for a
 * private→private {@link transfer}. It is NOT the account's public address and
 * Hinkal deliberately provides no way to look one up — it has to be shared
 * out-of-band, or the privacy is pointless.
 */
export async function getRecipientInfo(session: HinkalSession, chainId: HinkalChainId): Promise<string> {
  const { recipientInfo } = await hinkalGet<{ recipientInfo: string }>(
    session,
    "/recipient-info",
    { chainId: String(chainId) },
    "Could not read recipient info",
  );
  return recipientInfo;
}

/**
 * Relayer fee for an operation, in `feeToken`'s smallest unit — the price of having
 * Hinkal broadcast instead of us. Preview it before confirming, or pass the result
 * as `feeAmount` to lock it in; omit `feeAmount` at send time and the server
 * recomputes it. `externalActionId` is `"Transact"` for plain withdraw/transfer.
 */
export async function getFee(
  session: HinkalSession,
  params: { chainId: HinkalChainId; feeToken: Address; tokenAddresses: Address[]; externalActionId?: string },
): Promise<bigint> {
  const { feeAmount } = await hinkalGet<{ feeAmount: string }>(
    session,
    "/get-fee",
    {
      chainId: String(params.chainId),
      feeToken: getAddress(params.feeToken),
      tokenAddresses: params.tokenAddresses.map((t) => getAddress(t)).join(","),
      externalActionId: params.externalActionId ?? "Transact",
    },
    "Could not price the relayer fee",
  );
  return BigInt(feeAmount);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Token + amount pair, in the token's smallest unit. */
export interface HinkalAmount {
  token: Address;
  amount: bigint;
}

function splitAmounts(amounts: HinkalAmount[]): { tokenAddresses: string[]; amounts: string[] } {
  // Sorted by token address ascending — Hinkal's normalisation rule. Only load-bearing
  // for EIP-712 mode (the enclave rebuilds and re-hashes the struct), but keeping the
  // ordering canonical here means an EIP-712 path could reuse this untouched.
  const sorted = [...amounts].sort((a, b) => (getAddress(a.token) < getAddress(b.token) ? -1 : 1));
  return {
    tokenAddresses: sorted.map((a) => getAddress(a.token)),
    amounts: sorted.map((a) => a.amount.toString()),
  };
}

/**
 * PUBLIC → SHIELDED. Returns an unsigned transaction for the Salt account to
 * broadcast itself — this leg is deliberately public, and is the one link between
 * the account and its shielded balance that anyone can see on-chain.
 *
 * Two things to check before wiring this to a flow, neither verifiable without a
 * funded mainnet account:
 *   • ERC-20 deposits almost certainly need an `approve` to the Hinkal pool first
 *     (see {@link getContracts}); Hinkal documents the approval step for
 *     `/private-send` but not here. Check the allowance and approve if short, the
 *     way the swap and bridge flows already do.
 *   • Confirm whether `value` comes back decimal or hex. {@link depositCall} parses
 *     both, so this is a documentation question, not a bug risk.
 */
export async function buildDeposit(
  session: HinkalSession,
  params: { chainId: HinkalChainId; amounts: HinkalAmount[] },
): Promise<HinkalTxData> {
  const { txData } = await hinkalPost<{ txData: HinkalTxData }>(
    session,
    "/deposit",
    { chainId: params.chainId, ...splitAmounts(params.amounts) },
    "Hinkal could not build the deposit",
  );
  return txData;
}

/**
 * Reshape a `/deposit` response into `salt.submitTx` arguments — drop Hinkal's
 * advisory gas fields and let Salt estimate, exactly as the swap and bridge flows do
 * with LI.FI's `transactionRequest`. Pass the result straight to `submitAndTrack`.
 */
export function depositCall(txData: HinkalTxData): { to: Address; data: Hex; value: bigint } {
  return {
    to: getAddress(txData.to),
    data: (txData.data ?? "0x") as Hex,
    value: txData.value ? BigInt(txData.value) : 0n,
  };
}

/**
 * SHIELDED → PUBLIC. Hinkal's relayer broadcasts, so the account's address never
 * appears as the sender and `recipientAddress` gets funds with no on-chain link back.
 *
 * That is also the trap for the obvious "privately fund a Hyperliquid deposit" idea:
 * the HyperCore bridge credits whoever SENDS to it, so withdrawing straight into the
 * bridge would credit Hinkal's relayer, not the Salt account. Withdraw to the account
 * first, then deposit — which re-links the two and gives most of the privacy back.
 */
export async function withdraw(
  session: HinkalSession,
  params: {
    chainId: HinkalChainId;
    amounts: HinkalAmount[];
    recipientAddress: Address;
    /** Required on EVM. Which token the relayer takes its fee in. */
    feeToken: Address;
    /** Omit to let the server price it at send time; pass a {@link getFee} result to lock it. */
    feeAmount?: bigint;
  },
): Promise<string> {
  const { txHash } = await hinkalPost<{ txHash: string }>(
    session,
    "/withdraw",
    {
      chainId: params.chainId,
      ...splitAmounts(params.amounts),
      recipientAddress: getAddress(params.recipientAddress),
      feeToken: getAddress(params.feeToken),
      ...(params.feeAmount != null ? { feeAmount: params.feeAmount.toString() } : {}),
    },
    "Hinkal withdrawal failed",
  );
  return txHash;
}

/**
 * SHIELDED → SHIELDED. Nothing about this is publicly linkable: not the sender, not
 * the recipient, not the amount. `recipient` is the counterparty's
 * {@link getRecipientInfo} string (a plain address also works, but then the recipient
 * side is public and you've only hidden your own).
 */
export async function transfer(
  session: HinkalSession,
  params: {
    chainId: HinkalChainId;
    amounts: HinkalAmount[];
    recipient: string;
    feeToken: Address;
    feeAmount?: bigint;
  },
): Promise<string> {
  const { txHash } = await hinkalPost<{ txHash: string }>(
    session,
    "/transfer",
    {
      chainId: params.chainId,
      ...splitAmounts(params.amounts),
      recipientAddress: params.recipient,
      feeToken: getAddress(params.feeToken),
      ...(params.feeAmount != null ? { feeAmount: params.feeAmount.toString() } : {}),
    },
    "Hinkal transfer failed",
  );
  return txHash;
}
