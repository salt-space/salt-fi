import { createRequire } from "node:module";
import {
  bytesToHex,
  getTypesForEIP712Domain,
  hashDomain,
  hashStruct,
  serializeSignature,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
  type SignableMessage,
  type TypedDataDefinition,
} from "viem";
import { toAccount } from "viem/accounts";

// Type-only: the classes are loaded with `require()` below, which yields each module's `default`.
type EthAppClass = (typeof import("@ledgerhq/hw-app-eth"))["default"];
type TransportClass = (typeof import("@ledgerhq/hw-transport-node-hid-noevents"))["default"];

/** The subset of `hw-app-eth` this module drives; a fake can stand in for it in tests. */
export type LedgerEthApp = Pick<
  InstanceType<EthAppClass>,
  "getAddress" | "signPersonalMessage" | "signEIP712Message" | "signEIP712HashedMessage"
>;

/** Runs one request against the device. */
export type LedgerConnection = <T>(fn: (eth: LedgerEthApp) => Promise<T>) => Promise<T>;

type LedgerSignature = Awaited<ReturnType<LedgerEthApp["signPersonalMessage"]>>;

/** Ledger APDU status words worth explaining (see `@ledgerhq/errors` StatusCodes). */
const STATUS = {
  LOCKED_DEVICE: 0x5515,
  USER_REFUSED_ON_DEVICE: 0x5501,
  CONDITIONS_OF_USE_NOT_SATISFIED: 0x6985, // the Ethereum app's "rejected on device"
  INS_NOT_SUPPORTED: 0x6d00,
  CLA_NOT_SUPPORTED: 0x6e00, // a different app is open
  APP_NOT_OPEN: 0x6511, // on the dashboard
} as const;

const isDisconnect = (err: unknown): boolean =>
  ["DisconnectedDevice", "DisconnectedDeviceDuringOperation"].includes((err as { name?: string }).name ?? "");

/** Turn a Ledger transport/status error into one that says what to do about it. */
function explain(err: unknown): Error {
  const e = err as { statusCode?: number; name?: string; id?: string };
  const openApp = "unlock it and open the Ethereum app, then try again.";
  switch (e.statusCode) {
    case STATUS.CONDITIONS_OF_USE_NOT_SATISFIED:
    case STATUS.USER_REFUSED_ON_DEVICE:
      return new Error("Rejected on the Ledger.", { cause: err });
    case STATUS.LOCKED_DEVICE:
      return new Error(`Your Ledger is locked — ${openApp}`, { cause: err });
    case STATUS.APP_NOT_OPEN:
    case STATUS.CLA_NOT_SUPPORTED:
      return new Error(`The Ethereum app isn't open on your Ledger — ${openApp}`, { cause: err });
    case STATUS.INS_NOT_SUPPORTED:
      return new Error(`Your Ledger's Ethereum app isn't open or needs updating in Ledger Live — ${openApp}`, { cause: err });
  }
  if (e.id === "NoDevice") return new Error(`No Ledger found over USB. Plug it in, ${openApp}`, { cause: err });
  if (isDisconnect(err)) return new Error(`Lost the connection to your Ledger. Reconnect it, ${openApp}`, { cause: err });
  if (e.name === "TransportRaceCondition") {
    return new Error("Your Ledger is busy with another request. Finish or reject it on the device, then try again.", { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

// Ledger's ESM builds (`lib-es`) use extensionless relative imports, which Node's
// own ESM loader rejects — so load their CommonJS builds. Required lazily so a
// private-key run never loads node-hid's native USB binding; they're
// optionalDependencies so a failed native build can't break `npm install`.
const require = createRequire(import.meta.url);

/** An open link to the device: the app client plus the transport underneath it. */
export interface LedgerDevice {
  eth: LedgerEthApp;
  transport: { readonly disconnected: boolean; close(): Promise<void> };
}

/**
 * A connection to the device, opened on first use and reopened when it drops.
 * Requests are queued, since the device handles one exchange at a time and
 * errors on overlap. Errors come back explained (see {@link explain}).
 */
export function deviceConnection(openDevice: () => Promise<LedgerDevice>): LedgerConnection {
  let device: LedgerDevice | undefined;
  const open = async () => {
    const stale = device;
    device = undefined;
    await stale?.transport.close().catch(() => {});
    device = await openDevice();
    return device;
  };

  const run = async <T>(fn: (eth: LedgerEthApp) => Promise<T>): Promise<T> => {
    const reused = device !== undefined && !device.transport.disconnected;
    const { eth } = reused ? device! : await open();
    try {
      return await fn(eth);
    } catch (err) {
      // Opening or closing an app on the device re-enumerates it on USB, which
      // kills the old handle — reconnect once and retry.
      if (!reused || !isDisconnect(err)) throw err;
      return fn((await open()).eth);
    }
  };

  let queue: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const next = queue.then(() => run(fn));
    queue = next.catch(() => {});
    return next.catch((err) => {
      throw explain(err);
    });
  };
}

/** The first Ledger on USB. */
export function usbConnection(): LedgerConnection {
  let Eth: EthAppClass;
  let Transport: TransportClass;
  try {
    Eth = (require("@ledgerhq/hw-app-eth") as { default: EthAppClass }).default;
    Transport = (require("@ledgerhq/hw-transport-node-hid-noevents") as { default: TransportClass }).default;
  } catch (err) {
    throw new Error(
      "Ledger support needs the optional @ledgerhq packages and node-hid's native USB binding, which didn't load. " +
        "Run `npm install` and check it didn't skip them.",
      { cause: err },
    );
  }
  return deviceConnection(async () => {
    const transport = await Transport.open("");
    return { eth: new Eth(transport), transport };
  });
}

function messageHex(message: SignableMessage): string {
  if (typeof message === "string") return stringToHex(message).slice(2);
  return (typeof message.raw === "string" ? message.raw : bytesToHex(message.raw)).slice(2);
}

function toHexSignature({ r, s, v }: LedgerSignature): Hex {
  return serializeSignature({ r: `0x${r}`, s: `0x${s}`, v: BigInt(v) });
}

/** JSON values for the device: bigints as decimal strings. */
const toJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));

async function signTypedDataOnLedger(eth: LedgerEthApp, path: string, parameters: TypedDataDefinition): Promise<Hex> {
  const { domain = {}, primaryType, message } = parameters as {
    domain?: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  // The device needs the EIP712Domain struct spelled out; viem derives it from the domain.
  const types = { EIP712Domain: getTypesForEIP712Domain({ domain }), ...parameters.types } as Record<
    string,
    { name: string; type: string }[]
  > & { EIP712Domain: { name: string; type: string }[] };

  const ledgerDomain = toJson(domain);
  if (domain.chainId !== undefined) ledgerDomain.chainId = Number(domain.chainId);
  try {
    return toHexSignature(
      await eth.signEIP712Message(path, { domain: ledgerDomain, types, primaryType, message: toJson(message) }),
    );
  } catch (err) {
    // The original Nano S can't parse EIP-712 structs; it can only sign the two hashes.
    if ((err as { statusCode?: number }).statusCode !== STATUS.INS_NOT_SUPPORTED) throw err;
    const domainSeparator = hashDomain({ domain, types });
    const messageHash = hashStruct({ data: message, primaryType, types });
    return toHexSignature(await eth.signEIP712HashedMessage(path, domainSeparator.slice(2), messageHash.slice(2)));
  }
}

/**
 * A viem account whose key stays on a Ledger. It signs what the Salt SDK asks a
 * signer for — EIP-191 messages (SIWE sign-in, robo activation) and EIP-712 typed
 * data (the `DeriveKey` signature that unlocks this signer's keyshare in each
 * keygen/signing ceremony) — with a confirmation on the device every time.
 *
 * Ledger signatures are deterministic (RFC 6979), so the device re-derives the
 * same keyshare encryption key each time, exactly as a raw private key would.
 */
export async function ledgerAccount(path: string, connection: LedgerConnection = usbConnection()): Promise<LocalAccount> {
  const { address } = await connection((eth) => eth.getAddress(path, false));

  return toAccount({
    address: address as Address,
    signMessage: ({ message }) =>
      connection(async (eth) => toHexSignature(await eth.signPersonalMessage(path, messageHex(message)))),
    signTypedData: (parameters) => connection((eth) => signTypedDataOnLedger(eth, path, parameters as TypedDataDefinition)),
    // The signer never sends a transaction: Salt pays the shard-registry gas, and
    // an MPC account's transactions are signed by its ceremony (see wallet.ts).
    signTransaction: () => Promise.reject(new Error("salt-fi's signer never signs transactions itself.")),
  });
}
