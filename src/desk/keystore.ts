import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { english, generateMnemonic, generatePrivateKey, type HDAccount, mnemonicToAccount, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/**
 * Keys for a trading desk, generated on this machine for someone who doesn't have a wallet yet.
 *
 * Two keys, two roles, kept apart on purpose:
 *
 *   owner  The desk owner's key: creates the organisation, activates the Robo Guardians, seals
 *          policies, enables or stops the trading agent. Generated as a 12-word recovery phrase,
 *          shown once to write down, and stored ENCRYPTED with a passphrase only the owner types.
 *          An AI agent helping with setup must never see that passphrase: with the owner key and
 *          its own, it could sign around the Robo Guardians and the policies.
 *   agent  The trading agent's key: proposes trades, nothing else. Stored unencrypted (owner-only
 *          file) because the agent uses it unattended; the policies and the Robo Guardians are
 *          what limit it.
 *
 * Both live outside the repo, in ~/.salt-fi/desks/<desk>/ (SALT_DESK_DIR moves it), so they
 * can't be committed by accident.
 */

export const desksDir = (): string => process.env.SALT_DESK_DIR ?? path.join(os.homedir(), ".salt-fi", "desks");

export interface DeskPaths {
  dir: string;
  owner: string;
  agent: string;
  state: string;
}

const DESK_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function deskPaths(name: string): DeskPaths {
  if (!DESK_NAME.test(name)) throw new Error(`A desk name is lower-case letters, digits and dashes (up to 40), e.g. "my-desk"; not "${name}".`);
  const dir = path.join(desksDir(), name);
  return { dir, owner: path.join(dir, "owner.json"), agent: path.join(dir, "agent.json"), state: path.join(dir, "desk.json") };
}

/** Desks set up on this machine (those with an owner key). */
export function listDesks(): string[] {
  try {
    return fs
      .readdirSync(desksDir())
      .filter((d) => DESK_NAME.test(d) && fs.existsSync(path.join(desksDir(), d, "owner.json")))
      .sort();
  } catch {
    return [];
  }
}

// --- the owner key: a recovery phrase, encrypted with a passphrase ---------------------------------

/** scrypt cost: ~128 MB and a few hundred ms per guess, so a stolen file resists brute force. */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLen: 32 } as const;
export const MIN_PASSPHRASE = 10;

export interface EncryptedOwnerKey {
  version: 1;
  address: `0x${string}`;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  /** The 12-word recovery phrase, encrypted. */
  ciphertext: string;
}

const kdfKey = (passphrase: string, salt: Buffer, k: { N: number; r: number; p: number }) =>
  scryptSync(passphrase.normalize("NFKC"), salt, SCRYPT.keyLen, { N: k.N, r: k.r, p: k.p, maxmem: 256 * 1024 * 1024 });

export function passphraseProblem(passphrase: string | undefined): string | undefined {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters (a short sentence works well).`;
  return undefined;
}

/** Encrypt a recovery phrase with a passphrase. */
export function encryptOwnerKey(mnemonic: string, passphrase: string): EncryptedOwnerKey {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const account = mnemonicToAccount(mnemonic);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kdfKey(passphrase, salt, SCRYPT), iv);
  const ciphertext = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
  return {
    version: 1,
    address: account.address,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("hex") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") },
    ciphertext: ciphertext.toString("hex"),
  };
}

/** Decrypt the recovery phrase; throws "Wrong passphrase" when it doesn't match. */
export function decryptOwnerKey(file: EncryptedOwnerKey, passphrase: string): string {
  const salt = Buffer.from(file.kdf.salt, "hex");
  const decipher = createDecipheriv("aes-256-gcm", kdfKey(passphrase, salt, file.kdf), Buffer.from(file.cipher.iv, "hex"));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "hex"));
  let mnemonic: string;
  try {
    mnemonic = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Wrong passphrase.");
  }
  if (mnemonicToAccount(mnemonic).address !== file.address) throw new Error("The decrypted key doesn't match this desk's owner address.");
  return mnemonic;
}

function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" }); // never overwrite a key
}

/** Generate the owner's key for a new desk. Returns the recovery phrase, to show once. */
export function createOwner(name: string, passphrase: string): { address: `0x${string}`; mnemonic: string } {
  const paths = deskPaths(name);
  if (fs.existsSync(paths.owner)) throw new Error(`Desk "${name}" already has an owner key (${paths.owner}).`);
  const mnemonic = generateMnemonic(english);
  const file = encryptOwnerKey(mnemonic, passphrase);
  writePrivate(paths.owner, file);
  return { address: file.address, mnemonic };
}

/** Rebuild a desk's owner key from its recovery phrase, under a new passphrase (e.g. on a new machine). */
export function restoreOwner(name: string, mnemonic: string, passphrase: string): `0x${string}` {
  const paths = deskPaths(name);
  if (fs.existsSync(paths.owner)) throw new Error(`Desk "${name}" already has an owner key (${paths.owner}).`);
  const file = encryptOwnerKey(mnemonic.trim().toLowerCase().split(/\s+/).join(" "), passphrase);
  writePrivate(paths.owner, file);
  return file.address;
}

export function ownerAddress(name: string): `0x${string}` {
  return (JSON.parse(fs.readFileSync(deskPaths(name).owner, "utf8")) as EncryptedOwnerKey).address;
}

/** Unlock the owner's key with the passphrase (typed by the owner, never stored). */
export function unlockOwner(name: string, passphrase: string): HDAccount {
  const file = JSON.parse(fs.readFileSync(deskPaths(name).owner, "utf8")) as EncryptedOwnerKey;
  return mnemonicToAccount(decryptOwnerKey(file, passphrase));
}

// --- the trading agent's key ----------------------------------------------------------------------

interface AgentKeyFile {
  version: 1;
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

/** Generate the trading agent's key for a desk. */
export function createAgent(name: string): `0x${string}` {
  const paths = deskPaths(name);
  if (fs.existsSync(paths.agent)) throw new Error(`Desk "${name}" already has a trading agent key (${paths.agent}).`);
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  writePrivate(paths.agent, { version: 1, address, privateKey } satisfies AgentKeyFile);
  return address;
}

export function agentAddress(name: string): `0x${string}` | undefined {
  try {
    return (JSON.parse(fs.readFileSync(deskPaths(name).agent, "utf8")) as AgentKeyFile).address;
  } catch {
    return undefined;
  }
}

export function loadAgent(name: string): PrivateKeyAccount {
  const file = JSON.parse(fs.readFileSync(deskPaths(name).agent, "utf8")) as AgentKeyFile;
  return privateKeyToAccount(file.privateKey);
}
