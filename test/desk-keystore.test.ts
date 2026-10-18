import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentAddress,
  createAgent,
  createOwner,
  decryptOwnerKey,
  deskPaths,
  type EncryptedOwnerKey,
  listDesks,
  loadAgent,
  ownerAddress,
  restoreOwner,
  unlockOwner,
} from "../src/desk/keystore.js";

const PASS = "correct horse battery staple";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-keystore-"));
  process.env.SALT_DESK_DIR = dir;
});
afterEach(() => {
  delete process.env.SALT_DESK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("desk owner key", () => {
  it("generates a 12-word recovery phrase and unlocks with the passphrase", () => {
    const { address, mnemonic } = createOwner("my-desk", PASS);
    expect(mnemonic.split(" ")).toHaveLength(12);
    expect(ownerAddress("my-desk")).toBe(address);
    expect(unlockOwner("my-desk", PASS).address).toBe(address);
  });

  it("stores only ciphertext: the recovery phrase isn't in the file", () => {
    const { mnemonic } = createOwner("my-desk", PASS);
    const raw = fs.readFileSync(deskPaths("my-desk").owner, "utf8");
    for (const word of mnemonic.split(" ")) expect(raw).not.toContain(` ${word} `);
    expect(raw).not.toContain(mnemonic);
  });

  it("refuses a wrong passphrase", () => {
    createOwner("my-desk", PASS);
    expect(() => unlockOwner("my-desk", "not the passphrase")).toThrow("Wrong passphrase.");
  });

  it("refuses a short passphrase", () => {
    expect(() => createOwner("my-desk", "short")).toThrow(/at least 10 characters/);
  });

  it("detects a file whose address doesn't match its key", () => {
    createOwner("my-desk", PASS);
    const file = JSON.parse(fs.readFileSync(deskPaths("my-desk").owner, "utf8")) as EncryptedOwnerKey;
    expect(() => decryptOwnerKey({ ...file, address: "0x0000000000000000000000000000000000000001" }, PASS)).toThrow(/doesn't match/);
  });

  it("is owner-only on disk and never overwritten", () => {
    createOwner("my-desk", PASS);
    const p = deskPaths("my-desk");
    expect(fs.statSync(p.owner).mode & 0o777).toBe(0o600);
    expect(fs.statSync(p.dir).mode & 0o777).toBe(0o700);
    expect(() => createOwner("my-desk", PASS)).toThrow(/already has an owner key/);
  });

  it("restores from the recovery phrase under a new passphrase", () => {
    const { address, mnemonic } = createOwner("my-desk", PASS);
    const restored = restoreOwner("my-desk-copy", `  ${mnemonic.toUpperCase()}  `, "a different long passphrase");
    expect(restored).toBe(address);
    expect(unlockOwner("my-desk-copy", "a different long passphrase").address).toBe(address);
  });
});

describe("desk trading agent key", () => {
  it("is separate from the owner's, owner-only, and loads unattended", () => {
    const { address: owner } = createOwner("my-desk", PASS);
    const agent = createAgent("my-desk");
    expect(agent).not.toBe(owner);
    expect(agentAddress("my-desk")).toBe(agent);
    expect(loadAgent("my-desk").address).toBe(agent);
    expect(fs.statSync(deskPaths("my-desk").agent).mode & 0o777).toBe(0o600);
    expect(() => createAgent("my-desk")).toThrow(/already has a trading agent key/);
  });
});

describe("desks", () => {
  it("lists desks that have an owner key, and validates names", () => {
    createOwner("b-desk", PASS);
    createOwner("a-desk", PASS);
    fs.mkdirSync(path.join(dir, "no-owner"));
    expect(listDesks()).toEqual(["a-desk", "b-desk"]);
    expect(() => deskPaths("../escape")).toThrow(/lower-case letters/);
    expect(() => deskPaths("My Desk")).toThrow(/lower-case letters/);
  });
});
