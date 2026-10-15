import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { createWalletClient, formatUnits, http, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID, rpcUrl } from "./chains.js";
import { network } from "./env.js";
import { stashAdd, stashCount, stashTake } from "./fee-stash.js";
import { readTokenBalance } from "./token-balances.js";
import type { SaltWalletClient } from "./wallet.js";

/**
 * x402 fees: paying for the calls that cost money.
 *
 * From salt-sdk 0.0.44, a Salt backend can charge a fee, paid in USDC over x402, for
 * `createAccount` and `submitTx`. A call that arrives without a payment is refused with a 402
 * (`PaymentRequiredError`). This module decides who pays, and how:
 *
 *   signer   your signing wallet pays from its own USDC                 (the default on testnet)
 *   wallet   a separate sponsor wallet pays                             (SALT_FEE_PAYER_KEY)
 *   account  one of your Salt accounts pays, co-signed in an MPC ceremony (SALT_FEE_ACCOUNT_ID)
 *   none     nobody pays, so a call that costs a fee is refused          (the default where funds are real)
 *
 * `presign` (SALT_FEE_PRESIGN=1) signs the payment up front with getFeeTerms + signPayment, so the
 * call succeeds in one request instead of a 402 and a retry.
 *
 * It is hooked in once, in `loadSalt()` via `installFees()`, so every createAccount / submitTx in the
 * app pays its fee with no changes at the call site. salt-sdk 0.0.43 and earlier have no fee API;
 * there this is a no-op and the app behaves exactly as before.
 *
 * Safety: a payment is signed without asking only on chains viem marks as testnets, and only up to
 * SALT_FEE_MAX_USDC. Any other chain needs an interactive "yes", and is refused when there is no
 * terminal to ask on.
 */

export type FeeOperation = "createAccount" | "submitTx";
export type FeeMode = "signer" | "wallet" | "account" | "none";
export const FEE_MODES: FeeMode[] = ["signer", "wallet", "account", "none"];

export interface FeeConfig {
  mode: FeeMode;
  /** Sign the payment ahead of the call (one request) instead of reacting to a 402 (two). */
  presign: boolean;
  /** Preferred fee chain id. Unset = the payer's own chain if the backend quotes it, else the first quote. */
  chainId?: number;
  /** Sponsor private key for `wallet` mode. */
  sponsorKey?: `0x${string}`;
  /** Salt account id for `account` mode. */
  accountId?: string;
  /** Refuse any single payment above this many USDC. */
  maxUsdc: number;
  /** Spend a pre-signed voucher from the stash (src/fee-stash.ts) when one matches, before signing a fresh payment. */
  useStash: boolean;
  /** Check the payer holds the fee before paying, and stop with a fix instead of a refused payment. */
  preflight: boolean;
}

/** The fields of a quoted or 402 fee that the guard looks at (a structural subset of the SDK's fee terms). */
export interface FeeTermsLike {
  network: string;
  chainId?: number;
  asset: string;
  amount: string;
  payTo: string;
}

const USDC_DECIMALS = 6; // fees are quoted in USDC

const isOff = (v: string | undefined) => ["0", "false", "no"].includes((v ?? "").toLowerCase());

/** The fee settings the SALT_FEE_* environment variables describe (see .env.example). */
export function feeConfigFromEnv(): FeeConfig {
  // Where funds are real, nothing picks a payer for you: SALT_FEE_PAYER must name one.
  const raw = (process.env.SALT_FEE_PAYER || (network.realFunds ? "none" : "signer")).toLowerCase();
  if (!FEE_MODES.includes(raw as FeeMode)) {
    throw new Error(`Invalid SALT_FEE_PAYER "${process.env.SALT_FEE_PAYER}". Expected one of: ${FEE_MODES.join(", ")}.`);
  }
  const presign = ["1", "true", "yes"].includes((process.env.SALT_FEE_PRESIGN ?? "").toLowerCase());
  const chainId = process.env.SALT_FEE_CHAIN ? Number(process.env.SALT_FEE_CHAIN) : undefined;
  if (chainId !== undefined && !Number.isInteger(chainId)) {
    throw new Error(`Invalid SALT_FEE_CHAIN "${process.env.SALT_FEE_CHAIN}" (expected a numeric chain id, e.g. 8453 for Base).`);
  }
  const maxUsdc = process.env.SALT_FEE_MAX_USDC ? Number(process.env.SALT_FEE_MAX_USDC) : 25;
  if (!Number.isFinite(maxUsdc) || maxUsdc < 0) throw new Error(`Invalid SALT_FEE_MAX_USDC "${process.env.SALT_FEE_MAX_USDC}".`);
  return {
    mode: raw as FeeMode,
    presign,
    chainId,
    sponsorKey: (process.env.SALT_FEE_PAYER_KEY as `0x${string}` | undefined) || undefined,
    accountId: process.env.SALT_FEE_ACCOUNT_ID || undefined,
    maxUsdc,
    useStash: !isOff(process.env.SALT_FEE_STASH),
    preflight: !isOff(process.env.SALT_FEE_PREFLIGHT),
  };
}

let config: FeeConfig | undefined;
export const getFeeConfig = (): FeeConfig => (config ??= feeConfigFromEnv());
export function setFeeConfig(patch: Partial<FeeConfig>): FeeConfig {
  config = { ...getFeeConfig(), ...patch };
  return config;
}

/** A chain by id: the app's own chains first, then anything viem knows (fees can be quoted on chains the app doesn't otherwise use). */
export const chainById = (id: number): Chain | undefined =>
  CHAIN_BY_ID[String(id)] ?? (Object.values(viemChains) as Chain[]).find((c) => c && typeof c === "object" && c.id === id);
export const chainName = (id?: number): string =>
  id === undefined ? "unknown chain" : (CHAIN_NAME_BY_ID[String(id)] ?? chainById(id)?.name ?? `chain ${id}`);

/** True when the installed salt-sdk has the fee API (0.0.44 and later; not 0.0.43 and earlier). */
export const supportsFees = (salt: unknown): boolean => typeof (salt as { getFeeTerms?: unknown })?.getFeeTerms === "function";

export interface FeeAssessment {
  display: string;
  amountUsdc: number;
  chain: string;
  /** viem marks the chain as a testnet, i.e. the USDC has no real value. Unknown chains are treated as real. */
  testnet: boolean;
  overCap: boolean;
}

export function assessFee(terms: FeeTermsLike, cfg: FeeConfig): FeeAssessment {
  const amountUsdc = Number(formatUnits(BigInt(terms.amount), USDC_DECIMALS));
  const chain = terms.chainId === undefined ? undefined : chainById(terms.chainId);
  return {
    display: `${amountUsdc} USDC`,
    amountUsdc,
    chain: chainName(terms.chainId),
    testnet: chain?.testnet === true,
    overCap: amountUsdc > cfg.maxUsdc,
  };
}

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const usdcText = (raw: bigint) => `${formatUnits(raw, USDC_DECIMALS)} USDC`;

/** Runs before anything is signed. Throws to stop the payment. */
export async function guardPayment(terms: FeeTermsLike, cfg: FeeConfig, interactive = Boolean(process.stdin.isTTY), who?: string): Promise<void> {
  const a = assessFee(terms, cfg);
  if (a.overCap) {
    throw new Error(`Refusing to pay ${a.display} on ${a.chain}: above the ${cfg.maxUsdc} USDC cap (SALT_FEE_MAX_USDC).`);
  }
  if (!a.testnet) {
    if (!interactive) {
      throw new Error(`Refusing to pay ${a.display} on ${a.chain}: not a testnet, so it may be real funds, and there is no terminal to confirm on.`);
    }
    const ok = await p.confirm({
      message: `Pay ${a.display} on ${a.chain} to ${terms.payTo}? This chain is NOT a testnet: it may be REAL FUNDS.`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) throw new Error("Fee payment declined.");
  }
  const by = who ? `, paid by ${who}` : ` (${cfg.mode})`;
  p.log.info(`Fee: ${a.display} on ${a.chain} → ${short(terms.payTo)}${by}${cfg.presign ? ", pre-signed" : ""}`);
}

type Payer = { account: unknown; signTypedData: unknown; chain?: { id: number } };
const accountPayers = new Map<string, Payer>();

/**
 * When the payer is a Salt account, paying runs a SECOND, full MPC signing ceremony on that account
 * (its Robo Guardians and your signer), inside whichever stage hit the 402. Its time is remembered so
 * a flow can split it out of its own stage timings rather than blame the operation being paid for.
 */
export interface FeeCeremony {
  who: string;
  ms: number;
}
let lastFeeCeremony: FeeCeremony | undefined;
/** Returns and clears the most recent fee ceremony, if one ran since the last call. */
export const takeFeeCeremony = (): FeeCeremony | undefined => {
  const f = lastFeeCeremony;
  lastFeeCeremony = undefined;
  return f;
};
/** e.g. ` (5.8s of that was the fee payment ceremony on Salt account "Treasury" (0x1234ab…cdef))`, or "" */
export function feeCeremonyNote(f: FeeCeremony | undefined = takeFeeCeremony()): string {
  return f ? ` (${(f.ms / 1000).toFixed(1)}s of that was the fee payment ceremony on ${f.who})` : "";
}

type AccountInfo = { label: string; name?: string; address?: string };
const accountInfos = new Map<string, AccountInfo>();
/** Name, address and a printable label for a Salt account, falling back to the bare id if it can't be looked up. */
export async function accountInfo(salt: Salt, accountId: string): Promise<AccountInfo> {
  const cached = accountInfos.get(accountId);
  if (cached) return cached;
  let info: AccountInfo = { label: `Salt account ${accountId}` };
  try {
    for (const org of await salt.getOrganisations()) {
      const hit = (await salt.getAccounts(org.id)).find((a) => a.id === accountId);
      if (hit) {
        const address = hit.evmAddress ?? undefined;
        info = { name: hit.name, address, label: `Salt account "${hit.name}"${address ? ` (${short(address)})` : ""}` };
        break;
      }
    }
  } catch {
    /* keep the id-only label */
  }
  accountInfos.set(accountId, info);
  return info;
}
const accountLabel = async (salt: Salt, accountId: string): Promise<string> => (await accountInfo(salt, accountId)).label;

/** Wrap a Salt-account payer so the MPC ceremony it runs for the payment is announced and timed. */
function narrate(payer: Payer, who: string): Payer {
  const inner = (payer.signTypedData as (a: unknown) => Promise<unknown>).bind(payer);
  return Object.create(payer, {
    signTypedData: {
      enumerable: true,
      value: async (args: { message?: { value?: unknown } }) => {
        const raw = args?.message?.value;
        const amount = typeof raw === "bigint" || typeof raw === "string" ? `${formatUnits(BigInt(raw), USDC_DECIMALS)} USDC ` : "";
        p.log.info(
          `Fee ceremony: an MPC signing ceremony is now running on ${who} (its Robo Guardians and your signer co-sign the ${amount}payment). ` +
            "This is separate from the transaction's own ceremony.",
        );
        const t0 = Date.now();
        try {
          const sig = await inner(args);
          const ms = Date.now() - t0;
          lastFeeCeremony = { who, ms };
          p.log.success(`Fee payment signed in ${(ms / 1000).toFixed(1)}s (ceremony on ${who})`);
          return sig;
        } catch (err) {
          p.log.error(`Fee ceremony on ${who} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
    },
  }) as Payer;
}

/** The wallet that signs the payment, per the configured mode. */
async function payerFor(salt: Salt, walletClient: SaltWalletClient, cfg: FeeConfig): Promise<Payer> {
  const chain = cfg.chainId === undefined ? walletClient.chain : chainById(cfg.chainId);
  if (cfg.chainId !== undefined && !chain) throw new Error(`Unknown fee chain id ${cfg.chainId}.`);
  const transport = http(chain ? rpcUrl(String(chain.id)) : undefined);

  if (cfg.mode === "signer") {
    if (cfg.chainId === undefined || walletClient.chain?.id === cfg.chainId) return walletClient as unknown as Payer;
    return createWalletClient({ account: walletClient.account, chain, transport }) as unknown as Payer;
  }
  if (cfg.mode === "wallet") {
    if (!cfg.sponsorKey) throw new Error("SALT_FEE_PAYER=wallet needs SALT_FEE_PAYER_KEY (a funded sponsor wallet's private key).");
    return createWalletClient({ account: privateKeyToAccount(cfg.sponsorKey), chain, transport }) as unknown as Payer;
  }
  if (cfg.mode === "account") {
    if (!cfg.accountId) throw new Error("SALT_FEE_PAYER=account needs SALT_FEE_ACCOUNT_ID (the Salt account that pays).");
    const chainId = chain?.id ?? network.shardRegistryChain.id;
    const key = `${cfg.accountId}:${chainId}:${walletClient.account.address}`;
    let payer = accountPayers.get(key);
    if (!payer) {
      const raw = await (salt as unknown as { accountAsPayer(a: unknown): Promise<Payer> }).accountAsPayer({
        accountId: cfg.accountId,
        signer: walletClient,
        chainId,
      });
      payer = narrate(raw, await accountLabel(salt, cfg.accountId));
      accountPayers.set(key, payer);
    }
    return payer;
  }
  throw new Error(`No payer for mode "${cfg.mode}".`);
}

type BalanceReader = (chainId: number, asset: string, owner: string) => Promise<bigint | undefined>;
const rpcBalance: BalanceReader = async (chainId, asset, owner) => {
  const chain = chainById(chainId);
  if (!chain) return undefined;
  try {
    return await readTokenBalance(chain, asset as Address, owner as Address);
  } catch {
    return undefined; // an unreadable balance must never block a payment
  }
};
let readBalance: BalanceReader = rpcBalance;
/** For tests: swap the on-chain balance reader. Pass undefined to restore the real one. */
export const setBalanceReader = (r?: BalanceReader) => void (readBalance = r ?? rpcBalance);

/** Thrown before any ceremony when the payer demonstrably can't cover the fee. */
export class FeePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeePreflightError";
  }
}

type QuoteLike = { accepts: (FeeTermsLike & Record<string, unknown>)[] };

/**
 * Before paying, check the payer holds at least the quoted fee on the fee chain. If it demonstrably
 * doesn't, stop with a message that says why and what would work (another quoted chain where this
 * payer is funded, or another wallet that can pay), instead of letting the backend refuse the payment
 * (and, for a Salt-account payer, after a wasted MPC ceremony). An unreadable balance never blocks.
 */
async function preflight(walletClient: SaltWalletClient, cfg: FeeConfig, payer: Payer, who: string, op: FeeOperation, quote: QuoteLike): Promise<void> {
  const chainId = payer.chain?.id;
  const owner = (payer.account as { address?: string } | undefined)?.address;
  if (chainId === undefined || !owner) return;
  const option = quote.accepts.find((o) => o.chainId === chainId);
  if (!option) return; // a chain mismatch is reported, with its own message, where the payment is built
  const fee = BigInt(option.amount);
  const have = await readBalance(chainId, option.asset, owner);
  if (have === undefined || have >= fee) return;

  const hints: string[] = [];
  for (const o of quote.accepts) {
    if (o.chainId === chainId) continue;
    const b = await readBalance(o.chainId as number, o.asset, owner);
    if (b !== undefined && b >= BigInt(o.amount)) hints.push(`it holds ${usdcText(b)} on ${chainName(o.chainId)}: set the fee chain to ${chainName(o.chainId)}`);
  }
  const others: { label: string; address: string }[] = [];
  if (cfg.mode !== "signer") others.push({ label: "the signer", address: walletClient.account.address });
  if (cfg.mode !== "wallet" && cfg.sponsorKey) others.push({ label: "the sponsor wallet", address: privateKeyToAccount(cfg.sponsorKey).address });
  for (const w of others) {
    // One hint per wallet: on the current fee chain if it can pay there, else on another quoted chain.
    for (const o of [option, ...quote.accepts.filter((x) => x.chainId !== chainId)]) {
      const b = await readBalance(o.chainId as number, o.asset, w.address);
      if (b !== undefined && b >= BigInt(o.amount)) {
        hints.push(
          `${w.label} ${short(w.address)} holds ${usdcText(b)} on ${chainName(o.chainId)}: switch the payer to it` +
            (o.chainId === chainId ? "" : ` and the fee chain to ${chainName(o.chainId)}`),
        );
        break;
      }
    }
  }
  const what = op === "submitTx" ? "transaction" : "account creation";
  const usdcKind = chainById(chainId)?.testnet ? "testnet USDC" : "USDC";
  throw new FeePreflightError(
    `Fee payer ${who} holds ${usdcText(have)} on ${chainName(chainId)}, but this ${what} fee is ${usdcText(fee)}, so the payment would be refused. ` +
      (hints.length > 0 ? `Options: ${hints.join("; ")}` : `Fund ${short(owner)} with ${usdcKind} on ${chainName(chainId)}, or choose another payer`) +
      " (Fees (x402) → Choose who pays). SALT_FEE_PREFLIGHT=0 attempts it anyway.",
  );
}

/** Stable identity of the paying wallet, used to match a stashed voucher only to the payer that signed it. */
export function payerKeyFor(cfg: FeeConfig, walletClient: SaltWalletClient): string {
  if (cfg.mode === "account") return `account:${cfg.accountId}`;
  if (cfg.mode === "wallet" && cfg.sponsorKey) return `eoa:${privateKeyToAccount(cfg.sponsorKey).address.toLowerCase()}`;
  return `eoa:${walletClient.account.address.toLowerCase()}`;
}

/** Who is paying, in words, for the "Fee:" line. */
async function describePayer(salt: Salt, walletClient: SaltWalletClient, cfg: FeeConfig): Promise<string> {
  if (cfg.mode === "signer") return `the signer ${short(walletClient.account.address)} (own wallet)`;
  if (cfg.mode === "wallet" && cfg.sponsorKey) return `the sponsor wallet ${short(privateKeyToAccount(cfg.sponsorKey).address)}`;
  if (cfg.mode === "account" && cfg.accountId) return `${await accountLabel(salt, cfg.accountId)} via an MPC ceremony on that account`;
  return cfg.mode;
}

type FeeApi = {
  getFeeTerms(a: { for: FeeOperation }): Promise<QuoteLike>;
  signPayment(a: { option: unknown; payer: unknown }): Promise<{ expiresAt?: number }>;
};

function noQuoteForPayer(q: QuoteLike, payerChain: number | undefined): Error {
  const quoted = q.accepts.map((o) => `${chainName(o.chainId)} (${o.chainId})`).join(", ");
  return new Error(`Can't pre-sign: the payer is on ${chainName(payerChain)} but the backend quotes ${quoted}. Set SALT_FEE_CHAIN to one of them.`);
}

/** Extra params to spread into a createAccount / submitTx call so it can pay its fee. `{}` = leave the call alone. */
export async function buildFee(salt: Salt, walletClient: SaltWalletClient, op: FeeOperation): Promise<Record<string, unknown>> {
  if (!supportsFees(salt)) return {};
  const cfg = getFeeConfig();
  if (cfg.mode === "none") return {};

  const payer = await payerFor(salt, walletClient, cfg);
  const who = await describePayer(salt, walletClient, cfg);
  const onPaymentRequired = (terms: FeeTermsLike) => guardPayment(terms, cfg, Boolean(process.stdin.isTTY), who);

  const s = salt as unknown as FeeApi;
  let quote: QuoteLike | undefined;
  const getQuote = async () => (quote ??= await s.getFeeTerms({ for: op }));

  // Stop before any ceremony or payment if the payer can't cover the fee. This applies to a stashed
  // voucher too: it only settles if the payer still holds the fee when it is spent.
  if (cfg.preflight) await preflight(walletClient, cfg, payer, who, op, await getQuote());

  // A voucher signed ahead of time wins: spending it needs no signing now (no ceremony for a
  // Salt-account payer), and it was guarded when it was signed. `payer` stays attached, so if the
  // backend refuses the voucher (expired, price moved) the SDK falls back to signing in reply to the 402.
  if (cfg.useStash && payer.chain?.id !== undefined) {
    const match = { operation: op, chainId: payer.chain.id, payerKey: payerKeyFor(cfg, walletClient) };
    const voucher = stashTake(match);
    if (voucher) {
      const left = stashCount(match);
      const exp = voucher.expiresAt === undefined ? "no stated expiry" : `expires in ${Math.round((voucher.expiresAt - Date.now() / 1000) / 3600)}h`;
      p.log.info(
        `Fee: spending a pre-signed ${formatUnits(BigInt(voucher.amount), USDC_DECIMALS)} USDC authorisation from the stash (${who}; ${exp}; ${left} left for this payer)`,
      );
      return { payer, payment: voucher.payment, onPaymentRequired };
    }
  }
  if (!cfg.presign) return { payer, onPaymentRequired };

  const q = await getQuote();
  const option = q.accepts.find((o) => o.chainId === payer.chain?.id);
  if (!option) throw noQuoteForPayer(q, payer.chain?.id);
  await guardPayment(option, cfg, Boolean(process.stdin.isTTY), who);
  const payment = await s.signPayment({ option, payer });
  // `payer` stays too, so a payment the backend refuses (expired, price moved) is re-signed in reply to the 402.
  return { payer, payment, onPaymentRequired };
}

export interface BatchResult {
  signed: number;
  failed?: string;
  expiresAt?: number;
  who: string;
}

/**
 * Sign `count` fee authorisations for `op` now and keep them in the stash for later. Signing is free
 * (only spending a voucher costs the fee) and each is bound to this payer, chain and operation. From a
 * Salt account every one is a full MPC ceremony, so they are signed one after another.
 *
 * Guarded as ONE payment of count x fee: the cap applies to the total, and a non-testnet chain needs an
 * explicit yes. A failure part-way keeps what was already signed.
 */
export async function signBatch(
  salt: Salt,
  walletClient: SaltWalletClient,
  op: FeeOperation,
  count: number,
  opts: { onProgress?: (done: number, total: number, ms: number) => void; interactive?: boolean } = {},
): Promise<BatchResult> {
  if (!supportsFees(salt)) throw new Error("This salt-sdk has no fee API, so there is nothing to pre-sign.");
  const cfg = getFeeConfig();
  if (cfg.mode === "none") throw new Error('The payer is set to "Nobody", so there is nobody to sign. Choose who pays first.');
  if (!Number.isInteger(count) || count < 1) throw new Error("Batch size must be a whole number of at least 1.");

  const payer = await payerFor(salt, walletClient, cfg);
  const who = await describePayer(salt, walletClient, cfg);
  const s = salt as unknown as FeeApi;
  const quote = await s.getFeeTerms({ for: op });
  const payerChain = payer.chain?.id;
  const option = quote.accepts.find((o) => o.chainId === payerChain);
  if (!option || payerChain === undefined) throw noQuoteForPayer(quote, payerChain);
  if (cfg.preflight) {
    const owner = (payer.account as { address?: string } | undefined)?.address;
    const have = owner ? await readBalance(payerChain, option.asset, owner) : undefined;
    const need = BigInt(option.amount) * BigInt(count);
    if (have !== undefined && have < need) {
      p.log.warn(
        `Note: ${who} holds ${usdcText(have)} on ${chainName(payerChain)}, less than the ${usdcText(need)} these ${count} would cost if all were spent. ` +
          "Signing is free and works; spending will be refused once the USDC runs out.",
      );
    }
  }
  // One guard for the whole batch: the cap and the confirmation apply to count x fee.
  await guardPayment({ ...option, amount: String(BigInt(option.amount) * BigInt(count)) }, cfg, opts.interactive ?? Boolean(process.stdin.isTTY), who);

  const payerKey = payerKeyFor(cfg, walletClient);
  const payerLabel = who.replace(/ via an MPC ceremony on that account$/, "");
  let signed = 0;
  let expiresAt: number | undefined;
  try {
    for (let i = 1; i <= count; i++) {
      const t0 = Date.now();
      const payment = await s.signPayment({ option, payer });
      stashAdd({ operation: op, chainId: payerChain, payerKey, payerLabel, amount: option.amount, signedAt: Math.floor(Date.now() / 1000), expiresAt: payment.expiresAt, payment });
      signed++;
      if (payment.expiresAt !== undefined) expiresAt = Math.min(expiresAt ?? Infinity, payment.expiresAt);
      opts.onProgress?.(signed, count, Date.now() - t0);
    }
  } catch (err) {
    return { signed, failed: err instanceof Error ? err.message : String(err), expiresAt, who };
  }
  return { signed, expiresAt, who };
}

/**
 * Wrap `createAccount` and `submitTx` on a Salt instance so they pay their x402 fee per the current
 * settings. A call that already passes its own `payer` / `payment` is left untouched. Idempotent, and
 * a no-op on a salt-sdk without the fee API.
 */
export function installFees<T extends Salt>(salt: T, walletClient: SaltWalletClient): T {
  const s = salt as unknown as Record<string, unknown> & { __feesInstalled?: boolean };
  if (s.__feesInstalled || !supportsFees(salt)) return salt;
  s.__feesInstalled = true;
  for (const op of ["createAccount", "submitTx"] as const) {
    const original = (s[op] as (params: unknown) => Promise<unknown>).bind(salt);
    s[op] = async (params: Record<string, unknown>) => {
      if (params?.payer || params?.payment) return original(params);
      return original({ ...params, ...(await buildFee(salt, walletClient, op)) });
    };
  }
  return salt;
}
