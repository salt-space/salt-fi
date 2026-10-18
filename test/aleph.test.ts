import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alephWallet,
  type AlephVmRecord,
  dropVmRecord,
  rankNodeChoices,
  readVmRecords,
  saveVmRecord,
  signerAlephWallet,
  walletOwning,
} from "../src/aleph/client.js";
import { creditsFor } from "../src/aleph/credits.js";
import { deriveSshKey } from "../src/aleph/ssh-key.js";
import { fitNote, oneLine } from "../src/prompts.js";

// The Aleph Cloud robo hosting pieces that don't need the network: the SSH key, node ranking, the
// VM records, which wallet may be the Aleph wallet, and reading a payment's credits.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "salt-fi-aleph-test-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("deriveSshKey", () => {
  const wallet = privateKeyToAccount(generatePrivateKey());

  it("gives the same SSH key for the same wallet, and a different one for another", async () => {
    const a = await deriveSshKey(wallet);
    const b = await deriveSshKey(wallet);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ salt-robo-aleph$/);
    const other = await deriveSshKey(privateKeyToAccount(generatePrivateKey()));
    expect(other.publicKey).not.toBe(a.publicKey);
  });

  const hasSshKeygen = !spawnSync("ssh-keygen", ["-?"]).error;
  it.skipIf(!hasSshKeygen)("writes a private key OpenSSH reads, with the same public key", async () => {
    const key = await deriveSshKey(wallet);
    const keyFile = path.join(scratch, "id_ed25519");
    fs.writeFileSync(keyFile, key.privateKeyPem, { mode: 0o600 });
    const fromOpenSsh = execFileSync("ssh-keygen", ["-y", "-f", keyFile]).toString().trim().split(" ").slice(0, 2).join(" ");
    expect(fromOpenSsh).toBe(key.publicKey.split(" ").slice(0, 2).join(" "));
  });
});

describe("rankNodeChoices", () => {
  const node = (hash: string, score: number) => ({ hash, name: hash, url: `https://${hash}.example`, score });
  const roomy = { freeRamGB: 40, freeDiskGB: 500, load5: 0.5, cores: 8 };

  it("drops nodes without room or that didn't answer; recommended first, then where robos worked, then by score", () => {
    const nodes = [node("best-score", 0.99), node("recommended", 0.5), node("worked", 0.6), node("tight", 0.98), node("silent", 0.97)];
    const capacities = new Map([
      ["best-score", roomy],
      ["recommended", roomy],
      ["worked", roomy],
      ["tight", { freeRamGB: 2, freeDiskGB: 500 }], // under 2 GB × 1.25
      ["silent", undefined], // didn't answer
    ]);
    const ranked = rankNodeChoices(nodes, capacities, ["worked", "worked"], "recommended");
    expect(ranked.map((n) => n.hash)).toEqual(["recommended", "worked", "best-score"]);
    expect(ranked[0].recommended).toBe(true);
    expect(ranked[1].workedHere).toBe(2);
  });

  it("needs disk headroom as well as memory", () => {
    const ranked = rankNodeChoices([node("small-disk", 0.9)], new Map([["small-disk", { freeRamGB: 40, freeDiskGB: 24 }]]), [], "none");
    expect(ranked).toEqual([]);
  });
});

describe("VM records", () => {
  // Records live in the working directory, so point it at a scratch one.
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue(scratch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves a VM once (an update replaces it) and drops it on delete", () => {
    const rec: AlephVmRecord = {
      vm: "vm1",
      name: "salt-robo-org",
      nodeHash: "h",
      nodeUrl: "https://node.example",
      owner: "0x0000000000000000000000000000000000000001",
      organisationId: "org",
      organisationName: "Org",
      saltEnv: "testnet",
      createdAt: new Date().toISOString(),
    };
    expect(readVmRecords()).toEqual([]);
    saveVmRecord(rec);
    saveVmRecord({ ...rec, setupDone: true });
    expect(readVmRecords()).toHaveLength(1);
    expect(readVmRecords()[0].setupDone).toBe(true);
    expect(fs.existsSync(path.join(scratch, ".aleph-vms.json"))).toBe(true);
    dropVmRecord("vm1");
    expect(readVmRecords()).toEqual([]);
  });
});

describe("the Aleph wallet", () => {
  const VARS = ["SIGNER", "PRIVATE_KEY", "ALEPH_PRIVATE_KEY"];
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  const signingKey = generatePrivateKey();
  const alephKey = generatePrivateKey();
  beforeEach(() => VARS.forEach((k) => delete process.env[k]));
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("offers the signing wallet only when you sign with PRIVATE_KEY", () => {
    process.env.PRIVATE_KEY = signingKey;
    expect(signerAlephWallet()?.address).toBe(privateKeyToAccount(signingKey).address);
    process.env.SIGNER = "private-key";
    expect(signerAlephWallet()?.source).toBe("PRIVATE_KEY");
  });

  it("never uses PRIVATE_KEY with a Ledger signer, even when it's set", () => {
    process.env.SIGNER = "ledger";
    process.env.PRIVATE_KEY = signingKey;
    expect(signerAlephWallet()).toBeUndefined();
    expect(walletOwning(privateKeyToAccount(signingKey).address)).toBeUndefined();
  });

  it("uses ALEPH_PRIVATE_KEY whatever the signer, and finds a VM's owner by address", () => {
    process.env.SIGNER = "ledger";
    process.env.ALEPH_PRIVATE_KEY = alephKey;
    const address = privateKeyToAccount(alephKey).address;
    expect(alephWallet()?.address).toBe(address);
    expect(walletOwning(address.toLowerCase())?.source).toBe("ALEPH_PRIVATE_KEY");
  });

  it("refuses a malformed ALEPH_PRIVATE_KEY", () => {
    process.env.ALEPH_PRIVATE_KEY = "0x1234";
    expect(() => alephWallet()).toThrow(/ALEPH_PRIVATE_KEY must be/);
  });
});

describe("creditsFor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for a checksummed address and finds the payment by its hash, whatever its case", async () => {
    const address = "0x52908400098527886e0f7030069857d2e4169ee7";
    const tx = `0x${"ab".repeat(32)}`;
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ credit_history: [{ tx_hash: null, amount: 5 }, { tx_hash: tx.toUpperCase().replace("0X", "0x"), amount: "2000000" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await creditsFor(address, tx)).toBe(2_000_000);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/addresses/${getAddress(address)}/credit_history`);
    expect(await creditsFor(address, `0x${"cd".repeat(32)}`)).toBeUndefined();
  });

  it("says not yet (undefined) when Aleph doesn't answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    expect(await creditsFor("0x52908400098527886e0f7030069857d2e4169ee7", `0x${"ab".repeat(32)}`)).toBeUndefined();
  });
});

describe("oneLine", () => {
  it("leaves a message that fits alone, and clips one that doesn't to the terminal width with an ellipsis", () => {
    expect(oneLine("short", 80)).toBe("short");
    const clipped = oneLine("x".repeat(200), 40);
    expect(clipped).toHaveLength(33);
    expect(clipped.endsWith("…")).toBe(true);
    // with the spinner's frame before it and its dots after, the line still fits
    expect(`◒  ${clipped}...`.length).toBeLessThan(40);
  });
});

describe("fitNote", () => {
  const text = [
    "Send 0.007 ETH (about $16.87) to this address, on the Ethereum network:",
    "",
    "  · Robinhood, PayPal or Venmo: buy ETH, then send it to this address",
    "$10.26  Robo Guardian VM on Aleph Cloud, first month",
  ].join("\n");

  it("leaves text that fits alone", () => {
    expect(fitNote(text, 120)).toBe(text);
  });

  it("wraps to the box's width, keeping indents and hanging bullets and amounts under their text", () => {
    const lines = fitNote(text, 40).split("\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(34);
    expect(lines.filter((l) => l && !l.startsWith(" ")).every((l) => !l.endsWith(" "))).toBe(true);
    expect(lines.slice(0, 3)).toEqual(["Send 0.007 ETH (about $16.87) to", "this address, on the Ethereum", "network:"]);
    expect(lines.slice(4, 7)).toEqual(["  · Robinhood, PayPal or Venmo:", "    buy ETH, then send it to this", "    address"]);
    expect(lines.at(-2)).toBe("$10.26  Robo Guardian VM on Aleph");
    expect(lines.at(-1)).toBe("        Cloud, first month");
  });
});
