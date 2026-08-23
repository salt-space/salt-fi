import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { serializeSignature, toHex, verifyMessage, type Hex } from "viem";
import { reportError } from "../errors.js";
import { pickOrganisation, select } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";

/** Normalise the SDK's `{ r, s, v }` EvmSignature into a serialized hex string. */
function toHexSig(s: unknown): Hex {
  if (typeof s === "string") return s as Hex;
  const o = s as { r: unknown; s: unknown; v?: unknown; yParity?: number };
  const hexify = (x: unknown): Hex => (typeof x === "bigint" ? toHex(x, { size: 32 }) : (x as Hex));
  return serializeSignature({ r: hexify(o.r), s: hexify(o.s), v: BigInt((o.v as number | bigint) ?? (o.yParity! + 27)) });
}

/**
 * Sign an arbitrary message with a Salt account — EIP-191 `personal_sign`. Runs an
 * MPC threshold ceremony (you propose, the account's Robo Guardians co-sign) and
 * returns a standard EVM signature that recovers to the account's own address, so it
 * works anywhere `personal_sign` is accepted (proving ownership, SIWE-style login).
 * The counterpart to "Listen for account nudges", which co-signs a message ceremony a
 * teammate starts. Moves no funds and touches no chain — it's a pure off-chain signature.
 */
export async function signMessageFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Sign a message from which organisation?");
  if (!organisationId) return;

  let accounts;
  try {
    accounts = await salt.getAccounts(organisationId);
  } catch (err) {
    reportError(err);
    return;
  }
  const usable = accounts.filter((a) => Boolean(a.evmAddress));
  if (usable.length === 0) {
    p.log.info("No fully-set-up accounts to sign with.");
    return;
  }

  const accountId = await select({
    message: "Sign with which account?",
    options: usable.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress })),
  });
  if (p.isCancel(accountId)) return;
  const account = usable.find((a) => a.id === accountId);
  if (!account?.evmAddress) return;

  const message = await p.text({
    message: "Message to sign",
    placeholder: "gm from my Salt account",
    validate: (v) => (!v || v.trim().length === 0 ? "Message is required" : undefined),
  });
  if (p.isCancel(message)) return;

  const s = p.spinner();
  s.start("Signing — MPC ceremony (your Robo Guardians co-sign)");
  try {
    const ceremony = await salt.signPersonalMessage({ accountId: account.id, signer: walletClient, message });
    const result = (await ceremony.wait()) as { signature: unknown };
    const signature = toHexSig(result.signature);
    // Prove it's a real account signature: it must recover to the account's own address.
    const verified = await verifyMessage({ address: account.evmAddress as `0x${string}`, message, signature });
    s.stop("Message signed");
    p.note(
      `account:   ${account.evmAddress}\n` +
        `message:   ${message}\n` +
        `signature: ${signature}\n` +
        `verified:  ${verified ? "✓ recovers to the account" : "✗ does NOT recover to the account"}`,
      "personal_sign (EIP-191)",
    );
  } catch (err) {
    s.stop("Signing failed");
    reportError(err);
  }
}
