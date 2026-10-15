import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia, base } from "viem/chains";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Fees = typeof import("../src/fees.js");
type Stash = typeof import("../src/fee-stash.js");
type SaltLike = Parameters<Fees["buildFee"]>[0];
type Wallet = Parameters<Fees["buildFee"]>[1];
type Params = Record<string, unknown>;

// Everything the fee settings read. Cleared before each test so a developer's .env can't leak in.
const FEE_VARS = [
  "SALT_FEE_PAYER",
  "SALT_FEE_PAYER_KEY",
  "SALT_FEE_ACCOUNT_ID",
  "SALT_FEE_CHAIN",
  "SALT_FEE_MAX_USDC",
  "SALT_FEE_PRESIGN",
  "SALT_FEE_PREFLIGHT",
  "SALT_FEE_STASH",
  "SALT_FEE_STASH_FILE",
  "SALT_ENV",
];
const savedEnv = Object.fromEntries(FEE_VARS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const clearFeeEnv = () => FEE_VARS.filter((k) => k !== "SALT_ENV" && k !== "SALT_FEE_STASH_FILE").forEach((k) => delete process.env[k]);

/** Load the fee modules fresh for one environment (`network` is fixed when env.ts loads). */
async function loadFor(saltEnv: "testnet" | "mainnet") {
  vi.resetModules();
  process.env.SALT_ENV = saltEnv;
  const env = await import("../src/env.js");
  const fees = await import("../src/fees.js");
  const stash = await import("../src/fee-stash.js");
  return { env, fees, stash };
}

/** Run `fn` with stdout captured (clack's log lines), and say what it printed (without colour codes) and how it ended. */
async function run<T>(fn: () => Promise<T>): Promise<{ out: string; result?: T; error?: Error }> {
  const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const write = stdout.write;
  let out = "";
  stdout.write = (chunk) => ((out += String(chunk)), true);
  const clean = () => out.replace(/\x1b\[[0-9;]*m/g, "");
  try {
    const result = await fn();
    return { out: clean(), result };
  } catch (error) {
    return { out: clean(), error: error as Error };
  } finally {
    stdout.write = write;
  }
}
/** Run `fn` quietly, expecting it to succeed. */
async function capture<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  const { out, result, error } = await run(fn);
  if (error) throw error;
  return { out, result: result as T };
}
/** Run `fn` quietly and return the error it throws. */
async function thrown(fn: () => Promise<unknown>): Promise<Error> {
  const { error } = await run(fn);
  if (!error) throw new Error("expected it to throw");
  return error;
}

const PAY_TO = "0x2222222222222222222222222222222222220402";
const terms = (chainId: number | undefined, amount = "10000000") => ({ network: `eip155:${chainId}`, chainId, asset: "0xasset", amount, payTo: PAY_TO });
// A transaction costs 0.1 USDC and an account 10 USDC in these fixtures; raw units have 6 decimals.
const priceFor = (op: string) => (op === "submitTx" ? "100000" : "10000000");
const quoteFor = async ({ for: op }: { for: string }) => ({
  accepts: [
    { ...terms(421614, priceFor(op)), source: {} },
    { ...terms(84532, priceFor(op)), source: {} },
  ],
});
const day = () => Math.floor(Date.now() / 1000) + 86_400;
const asSalt = (fake: object) => fake as unknown as SaltLike;
const walletOn = (chain: typeof arbitrumSepolia | typeof base) =>
  createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain, transport: http() }) as unknown as Wallet;

describe.each(["testnet", "mainnet"] as const)("fees (%s)", (saltEnv) => {
  let fees: Fees;
  let stash: Stash;
  let realFunds: boolean;
  const stashPath = path.join(os.tmpdir(), `salt-fi-fee-stash-${process.pid}-${saltEnv}.json`);
  const wallet = walletOn(arbitrumSepolia);
  const sponsorKey = generatePrivateKey();
  const sponsorAddr = privateKeyToAccount(sponsorKey).address;
  const defaults: Partial<ReturnType<Fees["getFeeConfig"]>> = {
    mode: "signer",
    presign: false,
    chainId: undefined,
    sponsorKey: undefined,
    accountId: undefined,
    maxUsdc: 25,
    useStash: true,
    preflight: true,
  };

  /** A Salt with the fee API whose createAccount / submitTx record what they were called with. */
  function feeSalt(extra: object = {}) {
    let n = 0;
    const calls: Params[] = [];
    const salt = {
      getFeeTerms: quoteFor,
      signPayment: async (a: { option: { chainId: number } }) => ({ signedFor: a.option.chainId, expiresAt: day(), n: ++n }),
      createAccount: async (params: Params) => (calls.push(params), "created"),
      submitTx: async (params: Params) => (calls.push(params), "sent"),
      ...extra,
    };
    return { salt, calls };
  }

  // A Salt account that can pay: "Treasury", whose payment signatures take a moment and can fail.
  const payerAcct = { address: "0x3333333333333333333333333333333333331234" };
  let robosOffline = false;
  const accountSalt = (extra: object = {}) =>
    feeSalt({
      getOrganisations: async () => [{ id: "org1" }],
      getAccounts: async () => [{ id: "acct1", name: "Treasury", evmAddress: payerAcct.address }],
      accountAsPayer: async () => ({
        account: payerAcct,
        chain: { id: 421614 },
        signTypedData: async () => {
          await new Promise((r) => setTimeout(r, 40));
          if (robosOffline) throw new Error("Robo Guardians offline");
          return "0xsig";
        },
      }),
      ...extra,
    }).salt;

  beforeAll(async () => {
    const loaded = await loadFor(saltEnv);
    fees = loaded.fees;
    stash = loaded.stash;
    realFunds = loaded.env.network.realFunds;
    process.env.SALT_FEE_STASH_FILE = stashPath;
  });
  afterAll(() => fs.rmSync(stashPath, { force: true }));
  beforeEach(() => {
    clearFeeEnv();
    fees.setFeeConfig(defaults);
    fees.setBalanceReader(async () => 10n ** 12n); // every wallet is rich unless a test says otherwise (no network here)
    stash.stashClear();
    robosOffline = false;
    fees.takeFeeCeremony();
  });

  describe("settings from the environment", () => {
    it(`defaults the payer to "${saltEnv === "mainnet" ? "none" : "signer"}"`, () => {
      expect(realFunds).toBe(saltEnv === "mainnet");
      expect(fees.feeConfigFromEnv()).toMatchObject({
        mode: saltEnv === "mainnet" ? "none" : "signer",
        presign: false,
        chainId: undefined,
        maxUsdc: 25,
        useStash: true,
        preflight: true,
      });
    });

    it("honours an explicit payer, case-insensitively, and the switches", () => {
      Object.assign(process.env, {
        SALT_FEE_PAYER: "Wallet",
        SALT_FEE_PAYER_KEY: sponsorKey,
        SALT_FEE_CHAIN: "84532",
        SALT_FEE_MAX_USDC: "5",
        SALT_FEE_PRESIGN: "yes",
        SALT_FEE_STASH: "0",
        SALT_FEE_PREFLIGHT: "false",
      });
      expect(fees.feeConfigFromEnv()).toMatchObject({ mode: "wallet", sponsorKey, chainId: 84532, maxUsdc: 5, presign: true, useStash: false, preflight: false });
    });

    it("rejects values it can't use", () => {
      process.env.SALT_FEE_PAYER = "everyone";
      expect(() => fees.feeConfigFromEnv()).toThrow(/Invalid SALT_FEE_PAYER "everyone"/);
      clearFeeEnv();
      process.env.SALT_FEE_CHAIN = "base";
      expect(() => fees.feeConfigFromEnv()).toThrow(/Invalid SALT_FEE_CHAIN/);
      clearFeeEnv();
      process.env.SALT_FEE_MAX_USDC = "-1";
      expect(() => fees.feeConfigFromEnv()).toThrow(/Invalid SALT_FEE_MAX_USDC/);
    });

    it(`keeps the stash in .fee-stash.${saltEnv}.json by default`, () => {
      delete process.env.SALT_FEE_STASH_FILE;
      try {
        expect(stash.stashFile()).toBe(path.resolve(process.cwd(), `.fee-stash.${saltEnv}.json`));
      } finally {
        process.env.SALT_FEE_STASH_FILE = stashPath;
      }
    });
  });

  describe("assessing and guarding a payment", () => {
    it("treats Arbitrum Sepolia and Base Sepolia as testnets", () => {
      const cfg = fees.getFeeConfig();
      expect([fees.assessFee(terms(421614), cfg).testnet, fees.assessFee(terms(84532), cfg).testnet]).toEqual([true, true]);
    });

    it("reads 10,000,000 raw units as 10 USDC", () => {
      expect(fees.assessFee(terms(421614), fees.getFeeConfig()).amountUsdc).toBe(10);
    });

    it("treats Ethereum, Base, Arbitrum One and an unknown chain as real money", () => {
      for (const id of [1, 8453, 42161, undefined]) expect(fees.assessFee(terms(id), fees.getFeeConfig()).testnet).toBe(false);
    });

    it("allows a testnet payment under the cap without a prompt", async () => {
      await capture(() => fees.guardPayment(terms(421614), fees.getFeeConfig(), false));
    });

    it("refuses a non-testnet payment when there is no terminal", async () => {
      expect((await thrown(() => fees.guardPayment(terms(8453), fees.getFeeConfig(), false))).message).toMatch(/may be real funds/);
    });

    it("refuses a payment above the cap (30 > 25)", async () => {
      expect((await thrown(() => fees.guardPayment(terms(421614, "30000000"), fees.getFeeConfig(), false))).message).toMatch(/above the 25 USDC cap/);
    });
  });

  describe("installFees", () => {
    it("detects the fee API", () => {
      expect(fees.supportsFees({})).toBe(false);
      expect(fees.supportsFees(feeSalt().salt)).toBe(true);
    });

    it("leaves a salt-sdk without the fee API (0.0.43 and earlier) untouched", () => {
      const plain = { createAccount: async (params: Params) => params };
      const original = plain.createAccount;
      fees.installFees(asSalt(plain), wallet);
      expect(plain.createAccount).toBe(original);
    });

    it("gives createAccount a payer and onPaymentRequired, keeps its params, and doesn't wrap twice", async () => {
      const { salt, calls } = feeSalt();
      fees.installFees(asSalt(salt), wallet);
      fees.installFees(asSalt(salt), wallet);
      await capture(() => salt.createAccount({ name: "a" }));
      expect(calls).toHaveLength(1);
      expect(calls[0].payer).toBeTruthy();
      expect(typeof calls[0].onPaymentRequired).toBe("function");
      expect(calls[0].payment).toBeUndefined();
      expect(calls[0].name).toBe("a");
    });

    it("leaves a call that brings its own payer alone", async () => {
      const { salt, calls } = feeSalt();
      fees.installFees(asSalt(salt), wallet);
      await salt.submitTx({ payer: "mine" });
      expect(calls[0]).toEqual({ payer: "mine" });
    });

    it('leaves calls alone when nobody pays ("none"), so a fee is refused', async () => {
      const { salt, calls } = feeSalt();
      fees.installFees(asSalt(salt), wallet);
      fees.setFeeConfig({ mode: "none" });
      await salt.submitTx({ x: 1 });
      expect(calls[0]).toEqual({ x: 1 });
    });

    it("pre-signs the quoted option on the payer's chain, keeping the payer as a fallback", async () => {
      const { salt, calls } = feeSalt();
      fees.installFees(asSalt(salt), wallet);
      fees.setFeeConfig({ presign: true });
      await capture(() => salt.createAccount({}));
      expect(calls[0].payment).toMatchObject({ signedFor: 421614 });
      expect(calls[0].payer).toBeTruthy();
    });

    it("pays on the chain SALT_FEE_CHAIN names (Base Sepolia)", async () => {
      const { salt, calls } = feeSalt();
      fees.installFees(asSalt(salt), wallet);
      fees.setFeeConfig({ presign: true, chainId: 84532 });
      await capture(() => salt.createAccount({}));
      expect(calls[0].payment).toMatchObject({ signedFor: 84532 });
    });

    it("explains a pre-sign on a chain Salt doesn't quote", async () => {
      const { salt } = feeSalt();
      fees.installFees(asSalt(salt), wallet);
      fees.setFeeConfig({ presign: true, chainId: 11155111 });
      expect((await thrown(() => salt.createAccount({}))).message).toMatch(/Can't pre-sign.*quotes/);
    });

    it("explains a sponsor wallet with no key, or a Salt account with no id", async () => {
      fees.setFeeConfig({ mode: "wallet" });
      expect((await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "createAccount"))).message).toMatch(/SALT_FEE_PAYER_KEY/);
      fees.setFeeConfig({ mode: "account" });
      expect((await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "createAccount"))).message).toMatch(/SALT_FEE_ACCOUNT_ID/);
    });

    it("pays from the sponsor wallet, not the signer, in wallet mode", async () => {
      fees.setFeeConfig({ mode: "wallet", sponsorKey });
      const { result } = await capture(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "createAccount"));
      expect((result.payer as { account: { address: string } }).account.address).toBe(sponsorAddr);
    });
  });

  describe("a Salt account paying", () => {
    beforeEach(() => void fees.setFeeConfig({ mode: "account", accountId: "acct1" }));

    it("returns the account as payer with onPaymentRequired, still exposing its account and chain", async () => {
      const { result } = await capture(() => fees.buildFee(asSalt(accountSalt()), wallet, "submitTx"));
      const payer = result.payer as { account: unknown; chain: unknown };
      expect(typeof result.onPaymentRequired).toBe("function");
      expect(payer.account).toBe(payerAcct);
      expect(payer.chain).toEqual({ id: 421614 });
    });

    it("announces and times the payment's MPC ceremony, and splits it out once", async () => {
      const { result } = await capture(() => fees.buildFee(asSalt(accountSalt()), wallet, "submitTx"));
      const payer = result.payer as { signTypedData(a: unknown): Promise<string> };
      const { out, result: sig } = await capture(() => payer.signTypedData({ message: { value: 100000n } }));
      expect(sig).toBe("0xsig");
      expect(out).toMatch(/Fee ceremony: an MPC signing ceremony is now running on Salt account "Treasury" \(0x333333…1234\)/);
      expect(out).toMatch(/co-sign the 0\.1 USDC payment/);
      expect(out).toMatch(/separate from the transaction's own ceremony/);
      expect(out).toMatch(/Fee payment signed in \d+\.\ds \(ceremony on Salt account "Treasury"/);
      expect(fees.feeCeremonyNote()).toMatch(/^ \(\d+\.\ds of that was the fee payment ceremony on Salt account "Treasury"/);
      expect(fees.feeCeremonyNote()).toBe("");
    });

    it("reports a failed ceremony against its account, still throws, and records no timing", async () => {
      const { result } = await capture(() => fees.buildFee(asSalt(accountSalt()), wallet, "submitTx"));
      const payer = result.payer as { signTypedData(a: unknown): Promise<string> };
      robosOffline = true;
      const { out, error } = await run(() => payer.signTypedData({ message: { value: 100000n } }));
      expect(error?.message).toMatch(/Robo Guardians offline/);
      expect(out).toMatch(/Fee ceremony on Salt account "Treasury" \(0x333333…1234\) failed after \d+\.\ds: Robo Guardians offline/);
      expect(fees.takeFeeCeremony()).toBeUndefined();
    });

    it('says who pays on the "Fee:" line', async () => {
      const who = 'Salt account "Treasury" (0x333333…1234) via an MPC ceremony on that account';
      const { out } = await capture(() => fees.guardPayment(terms(421614, "100000"), fees.getFeeConfig(), false, who));
      expect(out).toMatch(/Fee: 0\.1 USDC on Arbitrum Sepolia → 0x222222…0402, paid by Salt account "Treasury"/);
    });
  });

  describe("the pre-signed stash", () => {
    const key = () => ({ operation: "submitTx" as const, chainId: 421614, payerKey: fees.payerKeyFor(fees.getFeeConfig(), wallet) });
    const add = (over: Partial<Parameters<Stash["stashAdd"]>[0]> = {}) =>
      stash.stashAdd({ operation: "submitTx", chainId: 421614, payerKey: key().payerKey, payerLabel: "x", amount: "100000", signedAt: 1, expiresAt: day(), payment: { v: "ok" }, ...over });
    const spend = async (salt: object = feeSalt().salt) => (await capture(() => fees.buildFee(asSalt(salt), wallet, "submitTx"))).result;

    it("signs a batch into an owner-only file", async () => {
      const { result } = await capture(() => fees.signBatch(asSalt(feeSalt().salt), wallet, "submitTx", 3, { interactive: false }));
      expect(result.signed).toBe(3);
      expect(stash.stashCount(key())).toBe(3);
      expect(fs.statSync(stashPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(stashPath, "utf-8"))).toHaveLength(3);
    });

    it("spends one per call, keeps the live payer as a fallback, and says so", async () => {
      await capture(() => fees.signBatch(asSalt(feeSalt().salt), wallet, "submitTx", 3, { interactive: false }));
      const { out, result } = await capture(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"));
      expect(result.payment).toMatchObject({ signedFor: 421614 });
      expect(result.payer).toBeTruthy();
      expect(typeof result.onPaymentRequired).toBe("function");
      expect(stash.stashCount(key())).toBe(2);
      expect(out).toMatch(/spending a pre-signed 0\.1 USDC authorisation from the stash/);
      expect(out).toMatch(/2 left/);
    });

    it("falls back to the live payer once the stash is empty", async () => {
      add();
      await spend();
      const result = await spend();
      expect(result.payment).toBeUndefined();
      expect(result.payer).toBeTruthy();
    });

    it("never spends one within two minutes of its expiry, and prune removes it", async () => {
      add({ expiresAt: Math.floor(Date.now() / 1000) + 30, payment: { v: "near-expiry" } });
      expect(stash.stashCount(key())).toBe(0);
      expect((await spend()).payment).toBeUndefined();
      expect(stash.stashPrune()).toBe(1);
      expect(stash.stashList()).toHaveLength(0);
    });

    it("only spends one signed by the same payer, for the same operation and chain", async () => {
      add({ payerKey: "eoa:0xsomeoneelse", payment: { v: "other-payer" } });
      add({ operation: "createAccount", amount: "10000000", payment: { v: "other-op" } });
      add({ chainId: 84532, payment: { v: "other-chain" } });
      expect((await spend()).payment).toBeUndefined();
      expect(stash.stashList()).toHaveLength(3);
    });

    it("clears by filter, or everything", () => {
      add({ payerKey: "eoa:0xsomeoneelse" });
      add();
      add();
      expect(stash.stashClear({ payerKey: "eoa:0xsomeoneelse" })).toBe(1);
      expect(stash.stashClear()).toBe(2);
      expect(stash.stashList()).toHaveLength(0);
    });

    it("leaves the stash alone with SALT_FEE_STASH=0, and spends it again when it's back on", async () => {
      add();
      fees.setFeeConfig({ useStash: false });
      expect((await spend()).payment).toBeUndefined();
      expect(stash.stashCount(key())).toBe(1);
      fees.setFeeConfig({ useStash: true });
      expect((await spend()).payment).toEqual({ v: "ok" });
    });

    it("guards a batch as one payment: over the cap (3 x 10 = 30 > 25) it signs nothing", async () => {
      const err = await thrown(() => fees.signBatch(asSalt(feeSalt().salt), wallet, "createAccount", 3, { interactive: false }));
      expect(err.message).toMatch(/above the 25 USDC cap/);
      expect(stash.stashList()).toHaveLength(0);
    });

    it("refuses a batch on a non-testnet chain without a terminal", async () => {
      fees.setFeeConfig({ chainId: 8453 });
      const { salt } = feeSalt({ getFeeTerms: async () => ({ accepts: [{ ...terms(8453, "100000"), source: {} }] }) });
      expect((await thrown(() => fees.signBatch(asSalt(salt), wallet, "submitTx", 1, { interactive: false }))).message).toMatch(/may be real funds/);
      expect(stash.stashList()).toHaveLength(0);
    });

    it("keeps what was signed when a batch fails part-way, and reports it", async () => {
      let n = 0;
      const { salt } = feeSalt({
        signPayment: async (a: { option: { chainId: number } }) => {
          if (++n === 3) throw new Error("Robo Guardians offline");
          return { signedFor: a.option.chainId, expiresAt: day() };
        },
      });
      const { result } = await capture(() => fees.signBatch(asSalt(salt), wallet, "submitTx", 5, { interactive: false }));
      expect(result.signed).toBe(2);
      expect(result.failed).toMatch(/Robo Guardians offline/);
      expect(stash.stashList()).toHaveLength(2);
    });

    it('refuses a batch when the payer is "Nobody", or the size is below 1', async () => {
      fees.setFeeConfig({ mode: "none" });
      expect((await thrown(() => fees.signBatch(asSalt(feeSalt().salt), wallet, "submitTx", 1, { interactive: false }))).message).toMatch(/Nobody/);
      fees.setFeeConfig(defaults);
      expect((await thrown(() => fees.signBatch(asSalt(feeSalt().salt), wallet, "submitTx", 0, { interactive: false }))).message).toMatch(/whole number/);
    });

    it("keys a Salt account's batch to that account, and spends it only when that account pays", async () => {
      fees.setFeeConfig({ mode: "account", accountId: "acct1" });
      await capture(() => fees.signBatch(asSalt(accountSalt()), wallet, "submitTx", 2, { interactive: false }));
      expect(stash.stashList()).toHaveLength(2);
      expect(stash.stashList().every((e) => e.payerKey === "account:acct1" && /Salt account "Treasury"/.test(e.payerLabel))).toBe(true);

      fees.setFeeConfig(defaults);
      expect((await spend()).payment).toBeUndefined();
      expect(stash.stashList()).toHaveLength(2);

      fees.setFeeConfig({ mode: "account", accountId: "acct1" });
      expect((await spend(accountSalt())).payment).toMatchObject({ signedFor: 421614 });
      expect(stash.stashList()).toHaveLength(1);
    });
  });

  describe("checking the payer can pay, before paying", () => {
    const sponsorOnly = (amount: bigint, chainId?: number) => async (cid: number, _asset: string, owner: string) =>
      owner.toLowerCase() === sponsorAddr.toLowerCase() && (chainId === undefined || cid === chainId) ? amount : 0n;

    it("stops an unfunded payer before paying, naming the payer, its balance, the fee and a fix", async () => {
      fees.setBalanceReader(async () => 0n);
      const err = await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"));
      expect(err).toBeInstanceOf(fees.FeePreflightError);
      expect(err.message).toMatch(
        /Fee payer the signer 0x[0-9a-fA-F]+….* \(own wallet\) holds 0 USDC on Arbitrum Sepolia, but this transaction fee is 0\.1 USDC, so the payment would be refused/,
      );
      expect(err.message).toMatch(/Fund 0x[0-9a-fA-F]+….* with testnet USDC on Arbitrum Sepolia, or choose another payer \(Fees \(x402\) → Choose who pays\)/);
    });

    it("names the operation and its price", async () => {
      fees.setBalanceReader(async () => 0n);
      expect((await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "createAccount"))).message).toMatch(/this account creation fee is 10 USDC/);
    });

    it("says USDC, not testnet USDC, on a chain with real value", async () => {
      fees.setBalanceReader(async () => 0n);
      const { salt } = feeSalt({ getFeeTerms: async () => ({ accepts: [{ ...terms(8453, "100000"), source: {} }] }) });
      const err = await thrown(() => fees.buildFee(asSalt(salt), walletOn(base), "submitTx"));
      expect(err.message).toMatch(/Fund 0x[0-9a-fA-F]+….* with USDC on Base, or choose another payer/);
    });

    it("suggests another quoted chain where the payer is funded", async () => {
      fees.setBalanceReader(async (cid) => (cid === 84532 ? 20_000_000n : 0n));
      expect((await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"))).message).toMatch(
        /it holds 20 USDC on Base Sepolia: set the fee chain to Base Sepolia/,
      );
    });

    it("suggests another wallet that can pay (the signer is empty, the sponsor isn't)", async () => {
      fees.setFeeConfig({ sponsorKey });
      fees.setBalanceReader(sponsorOnly(19_900_000n));
      expect((await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"))).message).toMatch(
        /the sponsor wallet 0x[0-9a-fA-F]+….* holds 19\.9 USDC on Arbitrum Sepolia: switch the payer to it/,
      );
    });

    it("skips the payer that already failed, and points at the signer when the sponsor is the empty one", async () => {
      fees.setFeeConfig({ mode: "wallet", sponsorKey });
      fees.setBalanceReader(async (_cid, _asset, owner) => (owner.toLowerCase() === wallet.account.address.toLowerCase() ? 5_000_000n : 0n));
      const err = await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"));
      expect(err.message).toMatch(/the signer 0x[0-9a-fA-F]+….* holds 5 USDC on Arbitrum Sepolia: switch the payer to it/);
      expect(err.message.split("Options:")[1]).not.toMatch(/sponsor/);
    });

    it("says to switch both the payer and the chain when the other wallet is funded only elsewhere", async () => {
      fees.setFeeConfig({ sponsorKey });
      fees.setBalanceReader(sponsorOnly(20_000_000n, 84532));
      expect((await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "createAccount"))).message).toMatch(
        /the sponsor wallet 0x[0-9a-fA-F]+….* holds 20 USDC on Base Sepolia: switch the payer to it and the fee chain to Base Sepolia/,
      );
    });

    it("never blocks on a balance it can't read", async () => {
      fees.setBalanceReader(async () => undefined);
      await capture(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"));
    });

    it("passes exactly the fee, and stops one unit short", async () => {
      fees.setBalanceReader(async () => 100_000n);
      await capture(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"));
      fees.setBalanceReader(async () => 99_999n);
      expect(await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"))).toBeInstanceOf(fees.FeePreflightError);
    });

    it("attempts the payment anyway with SALT_FEE_PREFLIGHT=0", async () => {
      fees.setBalanceReader(async () => 0n);
      fees.setFeeConfig({ preflight: false });
      await capture(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"));
    });

    it("applies to a stashed voucher too, without using it up", async () => {
      stash.stashAdd({
        operation: "submitTx",
        chainId: 421614,
        payerKey: fees.payerKeyFor(fees.getFeeConfig(), wallet),
        payerLabel: "x",
        amount: "100000",
        signedAt: 1,
        expiresAt: day(),
        payment: { v: "kept" },
      });
      fees.setBalanceReader(async () => 0n);
      expect(await thrown(() => fees.buildFee(asSalt(feeSalt().salt), wallet, "submitTx"))).toBeInstanceOf(fees.FeePreflightError);
      expect(stash.stashList()).toHaveLength(1);
    });

    it("only warns when a batch costs more than the payer holds (signing is free)", async () => {
      fees.setBalanceReader(async () => 150_000n);
      const { out, result } = await capture(() => fees.signBatch(asSalt(feeSalt().salt), wallet, "submitTx", 3, { interactive: false }));
      expect(result.signed).toBe(3);
      expect(out).toMatch(/Note: the signer .* holds 0\.15 USDC .* less than the 0\.3 USDC these 3 would cost/);
    });

    it("checks a Salt-account payer's own address, before any MPC ceremony", async () => {
      fees.setFeeConfig({ mode: "account", accountId: "acct1" });
      fees.setBalanceReader(async (_cid, _asset, owner) => (owner === payerAcct.address ? 0n : 10n ** 12n));
      expect((await thrown(() => fees.buildFee(asSalt(accountSalt()), wallet, "submitTx"))).message).toMatch(
        /Fee payer Salt account "Treasury" \(0x333333…1234\) via an MPC ceremony on that account holds 0 USDC/,
      );
    });
  });
});
