import { concat, hashMessage, hashTypedData, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  deviceConnection,
  findLedgerError,
  LedgerError,
  ledgerAccount,
  type LedgerConnection,
  type LedgerEthApp,
} from "../src/ledger.js";

const PATH = "44'/60'/0'/0/0";

/** Signs a digest and returns it the way hw-app-eth does: r/s unprefixed hex, v as 27/28. */
async function deviceSig(hash: Hex, privateKey: Hex) {
  const { r, s, v } = await sign({ hash, privateKey });
  return { r: r.slice(2), s: s.slice(2), v: Number(v) };
}

/**
 * A stand-in for the Ethereum app, backed by a known key. `nanoS` mimics the
 * original Nano S, which rejects full EIP-712 with INS_NOT_SUPPORTED.
 */
function fakeDevice(privateKey: Hex, opts: { nanoS?: boolean } = {}) {
  const received: { typedData?: Parameters<LedgerEthApp["signEIP712Message"]>[1] } = {};
  const eth: LedgerEthApp = {
    getAddress: async () => ({ address: privateKeyToAccount(privateKey).address, publicKey: "" }),
    signPersonalMessage: async (_path, messageHex) => deviceSig(hashMessage({ raw: `0x${messageHex}` }), privateKey),
    signEIP712Message: async (_path, typedData) => {
      if (opts.nanoS) throw Object.assign(new Error("INS_NOT_SUPPORTED"), { statusCode: 0x6d00 });
      received.typedData = typedData;
      return deviceSig(hashTypedData(typedData as Parameters<typeof hashTypedData>[0]), privateKey);
    },
    signEIP712HashedMessage: async (_path, domainSeparatorHex, hashStructMessageHex) =>
      deviceSig(keccak256(concat(["0x1901", `0x${domainSeparatorHex}`, `0x${hashStructMessageHex}`])), privateKey),
  };
  const connection: LedgerConnection = (fn) => fn(eth);
  return { connection, received };
}

/** The `DeriveKey` struct the Salt SDK signs to unlock a signer's keyshare (salt-sdk 0.0.43). */
const deriveKey = (account: Hex) =>
  ({
    domain: { name: "salt.space", version: "1" },
    types: {
      DeriveKey: [
        { name: "account", type: "address" },
        { name: "id", type: "string" },
        { name: "action", type: "string" },
        { name: "version", type: "string" },
      ],
    },
    primaryType: "DeriveKey",
    message: { account, id: "507f1f77bcf86cd799439010", action: "derive-key", version: "v2" },
  }) as const;

/** A struct with a uint256 and a chainId, which reach the device as JSON. */
const transfer = {
  domain: { name: "Test", version: "1", chainId: 421614n, verifyingContract: "0x00000000000000000000000000000000000000aa" },
  types: { Transfer: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }] },
  primaryType: "Transfer",
  message: { to: "0x00000000000000000000000000000000000000bb", amount: 10n ** 30n },
} as const;

describe("ledgerAccount", () => {
  const privateKey = generatePrivateKey();
  const local = privateKeyToAccount(privateKey);

  it("uses the device's address", async () => {
    const account = await ledgerAccount(PATH, fakeDevice(privateKey).connection);
    expect(account.address).toBe(local.address);
  });

  it("signs EIP-191 messages exactly as the raw key would (SIWE)", async () => {
    const account = await ledgerAccount(PATH, fakeDevice(privateKey).connection);
    const siwe = "testnet.salt.space wants you to sign in with your Ethereum account:\n" + local.address;
    expect(await account.signMessage({ message: siwe })).toBe(await local.signMessage({ message: siwe }));
    const raw = { raw: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) };
    expect(await account.signMessage({ message: raw })).toBe(await local.signMessage({ message: raw }));
  });

  it("signs the SDK's DeriveKey struct exactly as the raw key would, so keyshares decrypt either way", async () => {
    const device = fakeDevice(privateKey);
    const account = await ledgerAccount(PATH, device.connection);
    const typedData = deriveKey(local.address);
    expect(await account.signTypedData(typedData)).toBe(await local.signTypedData(typedData));
    // The device needs EIP712Domain spelled out even when the caller leaves it implicit.
    expect(device.received.typedData?.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
    ]);
  });

  it("passes bigints to the device as JSON values", async () => {
    const device = fakeDevice(privateKey);
    const account = await ledgerAccount(PATH, device.connection);
    expect(await account.signTypedData(transfer)).toBe(await local.signTypedData(transfer));
    expect(device.received.typedData?.domain.chainId).toBe(421614);
    expect(device.received.typedData?.message.amount).toBe((10n ** 30n).toString());
  });

  it("falls back to hashed EIP-712 on the original Nano S", async () => {
    const account = await ledgerAccount(PATH, fakeDevice(privateKey, { nanoS: true }).connection);
    expect(await account.signTypedData(transfer)).toBe(await local.signTypedData(transfer));
    const typedData = deriveKey(local.address);
    expect(await account.signTypedData(typedData)).toBe(await local.signTypedData(typedData));
  });

  it("never signs a transaction", async () => {
    const account = await ledgerAccount(PATH, fakeDevice(privateKey).connection);
    await expect(account.signTransaction({ to: local.address, value: 1n, chainId: 1, type: "eip1559" })).rejects.toThrow(
      /never signs transactions/,
    );
  });
});

describe("deviceConnection", () => {
  const ethWith = (getAddress: LedgerEthApp["getAddress"]) => ({ getAddress }) as LedgerEthApp;
  const statusError = (statusCode: number) => Object.assign(new Error(`status ${statusCode}`), { statusCode });
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("opens once and reuses the device", async () => {
    let opens = 0;
    const connection = deviceConnection(async () => {
      opens++;
      return { eth: ethWith(async () => ({ address: "0x1", publicKey: "" })), transport: { disconnected: false, close: async () => {} } };
    });
    await connection((eth) => eth.getAddress(PATH));
    await connection((eth) => eth.getAddress(PATH));
    expect(opens).toBe(1);
  });

  it("reconnects and retries once when a reused handle has gone stale (app opened/closed)", async () => {
    let opens = 0;
    const connection = deviceConnection(async () => {
      const n = ++opens;
      // The first handle works once, then dies as the device re-enumerates.
      let calls = 0;
      const eth = ethWith(async () => {
        if (n === 1 && ++calls > 1) throw named("DisconnectedDeviceDuringOperation");
        return { address: `0x${n}`, publicKey: "" };
      });
      return { eth, transport: { disconnected: false, close: async () => {} } };
    });
    expect((await connection((eth) => eth.getAddress(PATH))).address).toBe("0x1");
    expect((await connection((eth) => eth.getAddress(PATH))).address).toBe("0x2");
    expect(opens).toBe(2);
  });

  it("runs one request at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const connection = deviceConnection(async () => ({
      eth: ethWith(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { address: "0x1", publicKey: "" };
      }),
      transport: { disconnected: false, close: async () => {} },
    }));
    await Promise.all([1, 2, 3].map(() => connection((eth) => eth.getAddress(PATH))));
    expect(maxInFlight).toBe(1);
  });

  it.each([
    [statusError(0x6985), /Rejected on the Ledger/, true],
    [statusError(0x5515), /locked/, false],
    [statusError(0x6511), /Ethereum app isn't open/, false],
    [statusError(0x6e00), /Ethereum app isn't open/, false],
    [Object.assign(new Error("NoDevice"), { id: "NoDevice" }), /No Ledger found/, false],
  ])("explains %s", async (error, message, rejected) => {
    const connection = deviceConnection(async () => ({
      eth: ethWith(async () => {
        throw error;
      }),
      transport: { disconnected: false, close: async () => {} },
    }));
    const failure = await connection((eth) => eth.getAddress(PATH)).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LedgerError);
    expect(failure).toMatchObject({ message: expect.stringMatching(message), rejected });
    // A failed request doesn't wedge the queue.
    await expect(connection((eth) => eth.getAddress(PATH))).rejects.toThrow(message);
  });

  it("passes unrecognised errors through as they are", async () => {
    const original = new Error("something else");
    const connection = deviceConnection(async () => ({
      eth: ethWith(async () => {
        throw original;
      }),
      transport: { disconnected: false, close: async () => {} },
    }));
    await expect(connection((eth) => eth.getAddress(PATH))).rejects.toBe(original);
  });

  it("explains a failure to open the device, without waiting on the first connect", async () => {
    let opens = 0;
    const connection = deviceConnection(async () => {
      opens++;
      throw Object.assign(new Error("NoDevice"), { id: "NoDevice" });
    });
    await expect(connection((eth) => eth.getAddress(PATH))).rejects.toThrow(/No Ledger found over USB/);
    expect(opens).toBe(1);
  });

  /** A device whose first handle answers once and then dies, as when it drops off USB. */
  function flakyUsb(opts: { absentFor: number }) {
    let opens = 0;
    const openDevice = async () => {
      const n = ++opens;
      if (n > 1 && n <= 1 + opts.absentFor) throw Object.assign(new Error("NoDevice"), { id: "NoDevice" });
      let calls = 0;
      const eth = ethWith(async () => {
        if (n === 1 && ++calls > 1) throw named("DisconnectedDeviceDuringOperation");
        return { address: `0x${n}`, publicKey: "" };
      });
      return { eth, transport: { disconnected: false, close: async () => {} } };
    };
    return { openDevice, opens: () => opens };
  }

  it("keeps looking for a Ledger that dropped off USB mid-session, saying so once", async () => {
    const usb = flakyUsb({ absentFor: 2 });
    let notices = 0;
    const connection = deviceConnection(usb.openDevice, { reconnectWaitMs: 1_000, pollMs: 1, onWaiting: () => notices++ });
    await connection((eth) => eth.getAddress(PATH));
    expect((await connection((eth) => eth.getAddress(PATH))).address).toBe("0x4");
    expect(usb.opens()).toBe(4);
    expect(notices).toBe(1);
  });

  it("gives up on a Ledger that doesn't come back, saying it was lost", async () => {
    const usb = flakyUsb({ absentFor: Infinity });
    const connection = deviceConnection(usb.openDevice, { reconnectWaitMs: 20, pollMs: 1 });
    await connection((eth) => eth.getAddress(PATH));
    const failure = await connection((eth) => eth.getAddress(PATH)).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LedgerError);
    expect((failure as Error).message).toMatch(/Lost your Ledger: it stopped showing up over USB/);
  });
});

describe("findLedgerError", () => {
  it("finds a Ledger refusal the SDK has wrapped in its own error", () => {
    const refusal = new LedgerError("Rejected on the Ledger.", true);
    const wrapped = new Error("Ceremony failed", { cause: new Error("join failed", { cause: refusal }) });
    expect(findLedgerError(wrapped)).toBe(refusal);
    expect(findLedgerError(refusal)).toBe(refusal);
  });

  it("finds nothing in an unrelated error", () => {
    expect(findLedgerError(new Error("fetch failed", { cause: new Error("ECONNRESET") }))).toBeUndefined();
    expect(findLedgerError("not an error")).toBeUndefined();
  });
});
