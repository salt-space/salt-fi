import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "node:crypto";
import type { LocalAccount } from "viem";

/**
 * An SSH key for the Aleph VM, derived from the Aleph wallet. An Ethereum key is secp256k1, which
 * OpenSSH can't use, so instead the wallet signs a fixed message and the signature's hash seeds an
 * ed25519 key. viem signs with RFC 6979, so the same wallet always gives the same SSH key: nothing to
 * back up beyond the wallet. The signature is effectively the SSH private key, so treat it as a secret.
 */
export const SSH_DERIVATION_MESSAGE =
  "Derive SSH key for Salt Robo Guardian on Aleph Cloud (v1). Signing this only creates a local SSH key; it does not authorise any transaction.";

const KEY_TYPE = "ssh-ed25519";

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
const sshString = (data: Uint8Array | string): Buffer => {
  const b = Buffer.from(data);
  return Buffer.concat([u32(b.length), b]);
};

export type SshKeyPair = { publicKey: string; privateKeyPem: string };

/** An OpenSSH ed25519 key pair from a 32-byte seed (unencrypted private key, OpenSSH PROTOCOL.key format). */
export function sshKeyFromSeed(seed: Uint8Array, comment: string): SshKeyPair {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const pub = ed25519.getPublicKey(seed);
  const pubBlob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
  const publicKey = `${KEY_TYPE} ${pubBlob.toString("base64")} ${comment}`;

  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([Buffer.from(seed), Buffer.from(pub)])),
    sshString(comment),
  ]);
  for (let i = 1; priv.length % 8 !== 0; i++) priv = Buffer.concat([priv, Buffer.from([i])]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = body.toString("base64").match(/.{1,70}/g)!.join("\n");
  return { publicKey, privateKeyPem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n` };
}

export async function deriveSshKey(account: LocalAccount, comment = "salt-robo-aleph"): Promise<SshKeyPair> {
  if (!account.signMessage) throw new Error("This wallet can't sign messages, so it can't derive an SSH key.");
  const sig = await account.signMessage({ message: SSH_DERIVATION_MESSAGE });
  return sshKeyFromSeed(sha256(Buffer.from(sig.slice(2), "hex")), comment);
}
