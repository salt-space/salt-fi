import { describe, expect, it } from "vitest";
import { installPolicyCompat, policiesNeedSigner } from "../src/policy-compat.js";

type Call = { name: string; args: unknown[]; self: unknown };
type FakeSalt = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Installable = Parameters<typeof installPolicyCompat>[0];
type Wallet = Parameters<typeof installPolicyCompat>[1];

const wallet = { account: { address: "0xabc" }, tag: "session wallet" } as unknown as Wallet;

/** A Salt whose policy writes record how they were called; `withSeals` adds the batch write newer releases have. */
function fakeSalt(withSeals: boolean) {
  const calls: Call[] = [];
  const salt: FakeSalt = {};
  for (const name of ["createAccountPolicy", "updateAccountPolicy", "deleteAccountPolicy"]) {
    salt[name] = function (this: unknown, ...args: unknown[]) {
      calls.push({ name, args, self: this });
      return Promise.resolve(name);
    };
  }
  if (withSeals) salt.createAccountPolicies = () => Promise.resolve([]);
  return { salt, calls, install: () => installPolicyCompat(salt as unknown as Installable, wallet) };
}

describe("installPolicyCompat", () => {
  it("needs a signer only on a salt-sdk with policy seals", () => {
    expect(policiesNeedSigner(fakeSalt(true).salt)).toBe(true);
    expect(policiesNeedSigner(fakeSalt(false).salt)).toBe(false);
  });

  it("leaves salt-sdk 0.0.43 and earlier completely alone", () => {
    const { salt, install } = fakeSalt(false);
    const before = salt.createAccountPolicy;
    install();
    expect(salt.createAccountPolicy).toBe(before);
  });

  it("appends the session's wallet to create / update / delete, once even if installed twice", async () => {
    const { salt, calls, install } = fakeSalt(true);
    install();
    install();
    await salt.createAccountPolicy({ type: "x" });
    await salt.updateAccountPolicy("id1", { limit: 1 });
    await salt.deleteAccountPolicy("id2");
    expect(calls.map((c) => [c.name, c.args.length])).toEqual([
      ["createAccountPolicy", 2],
      ["updateAccountPolicy", 3],
      ["deleteAccountPolicy", 2],
    ]);
    expect(calls.every((c) => c.args[c.args.length - 1] === wallet)).toBe(true);
  });

  it("still calls the methods on the Salt instance", async () => {
    const { salt, calls, install } = fakeSalt(true);
    install();
    await salt.createAccountPolicy({ type: "x" });
    await salt.updateAccountPolicy("id", {});
    await salt.deleteAccountPolicy("id");
    expect(calls.every((c) => c.self === salt)).toBe(true);
  });

  it("leaves a call that passes its own wallet client untouched", async () => {
    const { salt, calls, install } = fakeSalt(true);
    install();
    const mine = { tag: "caller's own" };
    await salt.createAccountPolicy({ type: "x" }, mine);
    await salt.updateAccountPolicy("id", {}, mine);
    await salt.deleteAccountPolicy("id", mine);
    expect(calls.map((c) => c.args.length)).toEqual([2, 3, 2]);
    expect(calls.every((c) => c.args[c.args.length - 1] === mine)).toBe(true);
  });
});
