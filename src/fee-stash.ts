import fs from "node:fs";
import path from "node:path";
import { network } from "./env.js";

/**
 * A stash of pre-signed x402 fee authorisations ("vouchers").
 *
 * The SDK's `signPayment` produces a plain-data authorisation for ONE future fee that stays
 * spendable until its `expiresAt` (the backend sets the deadline). Signing is free; only spending
 * one costs the fee. Keeping a batch signed ahead of time lets each createAccount / submitTx spend
 * one instead of signing during the call, which for a Salt-account payer moves its MPC ceremony
 * out of the operation.
 *
 * Each entry is bound to an operation, a fee chain and a payer, and is used at most once (taking it
 * removes it). The file is re-read on every call, so two terminals sharing it don't hand out the
 * same entry. It holds bearer vouchers: anyone with the file can spend them, so it is written
 * owner-only and gitignored.
 */
export type StashOperation = "createAccount" | "submitTx";

export interface StashedPayment {
  id: string;
  operation: StashOperation;
  chainId: number;
  /** Who signed it: `eoa:<address>` or `account:<salt account id>`. A voucher is only used for the same payer. */
  payerKey: string;
  payerLabel: string;
  /** Raw token units, as quoted. */
  amount: string;
  signedAt: number;
  /** Unix seconds; undefined if the payment states no deadline. */
  expiresAt?: number;
  /** The SDK's signed payment, passed back verbatim as `payment`. */
  payment: unknown;
}

export type StashMatch = { operation: StashOperation; chainId: number; payerKey: string };

/** Never spend a voucher this close to its deadline: it could lapse before the backend settles it. */
export const SAFETY_MARGIN_S = 120;

/** `.fee-stash.<env>.json` in the working directory. SALT_FEE_STASH_FILE overrides it (the tests use this). */
export const stashFile = (): string => process.env.SALT_FEE_STASH_FILE || path.resolve(process.cwd(), `.fee-stash.${network.saltEnv}.json`);

function read(): StashedPayment[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(stashFile(), "utf-8"));
    return Array.isArray(parsed) ? (parsed as StashedPayment[]) : [];
  } catch {
    return [];
  }
}

function write(entries: StashedPayment[]): void {
  const file = stashFile();
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600); // `mode` only applies when the file is created
}

const nowS = () => Date.now() / 1000;
export const isUsable = (e: StashedPayment, now = nowS()): boolean => e.expiresAt === undefined || e.expiresAt - now > SAFETY_MARGIN_S;
const matches = (e: StashedPayment, m: Partial<StashMatch>): boolean =>
  (m.operation === undefined || e.operation === m.operation) &&
  (m.chainId === undefined || e.chainId === m.chainId) &&
  (m.payerKey === undefined || e.payerKey === m.payerKey);

let counter = 0;
export function stashAdd(entry: Omit<StashedPayment, "id">): StashedPayment {
  const full: StashedPayment = { ...entry, id: `${Date.now().toString(36)}-${(counter++).toString(36)}` };
  write([...read(), full]);
  return full;
}

/** Remove and return the usable voucher for `match` that expires soonest, so none is left to lapse unused. */
export function stashTake(match: StashMatch, now = nowS()): StashedPayment | undefined {
  const all = read();
  const candidates = all.filter((e) => matches(e, match) && isUsable(e, now));
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  const taken = candidates[0];
  write(all.filter((e) => e.id !== taken.id));
  return taken;
}

export const stashList = (): StashedPayment[] => read();

/** How many usable vouchers match (all of them when no filter is given). */
export const stashCount = (match: Partial<StashMatch> = {}, now = nowS()): number =>
  read().filter((e) => matches(e, match) && isUsable(e, now)).length;

/** Drop vouchers that are expired or too close to expiry to spend. Returns how many were removed. */
export function stashPrune(now = nowS()): number {
  const all = read();
  const keep = all.filter((e) => isUsable(e, now));
  if (keep.length !== all.length) write(keep);
  return all.length - keep.length;
}

/** Delete every voucher (or those matching the filter). Returns how many were removed. */
export function stashClear(match: Partial<StashMatch> = {}): number {
  const all = read();
  const keep = all.filter((e) => !matches(e, match));
  if (keep.length !== all.length) write(keep);
  return all.length - keep.length;
}
