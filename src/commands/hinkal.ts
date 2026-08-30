import * as p from "@clack/prompts";
import type { Policy, Salt } from "salt-sdk";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { CHAIN_BY_ID, CHAIN_NAME_BY_ID, explorerTxUrl, rpcUrl } from "../chains.js";
import { network } from "../env.js";
import { reportError } from "../errors.js";
import {
  buildDeposit,
  createSession,
  depositCall,
  getBalances,
  getFee,
  getRecipientInfo,
  getStuckBalances,
  getSupportedTokens,
  HINKAL_CHAIN_IDS,
  sessionIsLive,
  transfer,
  withdraw,
  type HinkalChainId,
  type HinkalSession,
  type HinkalToken,
} from "../hinkal.js";
import { getTokenPriceUsd } from "../lifi.js";
import { pickOrganisation, select } from "../prompts.js";
import { fetchAccountTokens } from "../token-balances.js";
import { encodeApprove, ERC20_ABI } from "../uniswap.js";
import type { SaltWalletClient } from "../wallet.js";
import { type PreflightTx, resolvePolicies, submitAndTrack } from "./tx-preflight.js";

/**
 * Hinkal — confidential balances for a Salt account. Deposit shields funds, then
 * withdrawals and transfers out of that shielded balance carry no public link back
 * to the account.
 *
 * TWO THINGS THAT MAKE THIS UNLIKE EVERY OTHER FLOW IN THE APP.
 *
 * 1. Only the deposit is a Salt transaction. Withdraw and transfer are broadcast by
 *    Hinkal's relayer, from Hinkal's own address — the account submits nothing, so
 *    there is no ceremony, no gas, and, crucially, NO POLICY CHECK. Salt evaluates
 *    policies against transactions the account submits, and these aren't. Every flow
 *    below that moves money without a policy check says so on screen; see
 *    {@link renderPolicyGap}.
 * 2. There is no testnet. Hinkal serves Ethereum, Polygon, Base and Arbitrum One and
 *    nothing this app can reach on testnet, so this menu is mainnet-only and always
 *    real funds. {@link requireMainnet} is the gate.
 */

/**
 * Open sessions, by account id. Deliberately in-memory and process-scoped: in normal
 * mode this key can authorise a withdrawal for the next 24 hours, so writing it to
 * disk would leave a spendable credential lying in the working directory. Losing it
 * on exit costs one signature.
 */
const sessions = new Map<string, HinkalSession>();

/**
 * What using Hinkal has actually cost, per account and chain, for this process.
 *
 * The cost of a shielded round trip is split across two legs that never appear on
 * screen together — gas on the deposit, a relayer fee on the way out — and the two
 * are charged in different places by different parties, so neither flow alone can
 * answer "what did that cost me". This tallies both so the balance view can.
 *
 * Session-scoped like {@link sessions}: it describes this sitting, not all time.
 */
interface CostLedger {
  /** Native gas the account paid to submit deposits (and any approvals). */
  gasWei: bigint;
  /** Relayer fees paid out of the shielded balance, per token. */
  relayFees: Map<string, { symbol: string; decimals: number; amount: bigint }>;
}

const costs = new Map<string, CostLedger>();

function ledgerFor(ctx: HinkalContext): CostLedger {
  const key = `${ctx.accountId}:${ctx.chainId}`;
  const existing = costs.get(key);
  if (existing) return existing;
  const fresh: CostLedger = { gasWei: 0n, relayFees: new Map() };
  costs.set(key, fresh);
  return fresh;
}

function recordRelayFee(ctx: HinkalContext, token: HinkalToken, amount: bigint): void {
  const ledger = ledgerFor(ctx);
  const key = token.erc20TokenAddress.toLowerCase();
  const entry = ledger.relayFees.get(key) ?? { symbol: token.symbol, decimals: token.decimals, amount: 0n };
  entry.amount += amount;
  ledger.relayFees.set(key, entry);
}

/**
 * Gas actually burnt by the given transactions, best-effort — 0 if a receipt can't
 * be read, since a cost report is decoration and must never fail an operation that
 * already succeeded.
 *
 * `gasUsed * effectiveGasPrice` is the whole story on Arbitrum, which folds its L1
 * data cost into gasUsed. OP-stack chains (Base) bill that part separately as
 * `l1Fee`, so add it where viem's receipt carries one.
 */
async function gasSpent(ctx: HinkalContext, hashes: (string | undefined)[]): Promise<bigint> {
  let total = 0n;
  for (const hash of hashes) {
    if (!hash) continue;
    try {
      const receipt = await ctx.publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
      total += receipt.gasUsed * receipt.effectiveGasPrice + ((receipt as { l1Fee?: bigint }).l1Fee ?? 0n);
    } catch {
      // Receipt not indexed yet, or a chain whose RPC won't serve it — skip this leg.
    }
  }
  return total;
}

/** `0.0021 ETH (~$8.14)`, or just the amount when no price is available. */
async function withUsd(chainId: number, tokenAddress: string, amount: bigint, decimals: number, symbol: string): Promise<string> {
  const formatted = `${formatUnits(amount, decimals)} ${symbol}`;
  const price = await getTokenPriceUsd(chainId, tokenAddress);
  if (!price) return formatted;
  return `${formatted} (~$${(Number(formatUnits(amount, decimals)) * price).toFixed(2)})`;
}

/** The native asset of a chain, as Hinkal and the app both address it. */
function nativeAsset(ctx: HinkalContext): { symbol: string; address: string } {
  return {
    symbol: CHAIN_BY_ID[String(ctx.chainId)]?.nativeCurrency.symbol ?? "ETH",
    address: "0x0000000000000000000000000000000000000000",
  };
}

/** Everything this account has spent on Hinkal this session, or undefined if nothing. */
async function renderCosts(ctx: HinkalContext): Promise<string | undefined> {
  const ledger = costs.get(`${ctx.accountId}:${ctx.chainId}`);
  if (!ledger || (ledger.gasWei === 0n && ledger.relayFees.size === 0)) return undefined;

  const lines: string[] = [];
  if (ledger.gasWei > 0n) {
    const native = nativeAsset(ctx);
    lines.push(`deposit gas:  ${await withUsd(ctx.chainId, native.address, ledger.gasWei, 18, native.symbol)}`);
  }
  for (const [address, fee] of ledger.relayFees) {
    lines.push(`relayer fee:  ${await withUsd(ctx.chainId, address, fee.amount, fee.decimals, fee.symbol)}`);
  }
  return lines.join("\n");
}

/**
 * Gas a Hinkal deposit burns, for when it can't be simulated. The proof verification
 * runs on-chain, which is why it's ~40x a plain transfer. Measured live:
 *
 *   781,091  native ETH deposit  (Ethereum)
 *   852,567  ERC-20 USDC deposit (Arbitrum One)
 *
 * The ERC-20 case costs more — an extra `transferFrom` plus its storage writes — and
 * is also the ONLY case that reaches this constant, since a native deposit simulates
 * fine and an ERC-20 one can't until its approval lands. So this is sized off the
 * ERC-20 measurement with headroom, not the cheaper native one.
 */
const DEPOSIT_GAS_REFERENCE = 900_000n;

/** Fallback for an ERC-20 approval we likewise can't simulate. */
const APPROVE_GAS_REFERENCE = 60_000n;

interface GasForecast {
  weiCost: bigint;
  /** Set when a leg couldn't be simulated and a reference figure stood in. */
  approximate: boolean;
}

/**
 * What the deposit will cost to submit, before the user commits to it.
 *
 * Worth showing because on Ethereum this is the LARGER of the two costs and by far
 * the more variable: the same deposit is a few dollars at 1.5 gwei and forty at 20.
 * The relayer fee, which the app already shows, is the small predictable one.
 *
 * Best-effort — returns undefined rather than blocking a deposit over a failed
 * estimate. An ERC-20 deposit usually CAN'T be simulated, because the approval it
 * depends on hasn't landed yet, so that case falls back to {@link DEPOSIT_GAS_REFERENCE}
 * and says so.
 */
async function forecastDepositGas(
  ctx: HinkalContext,
  params: { token: Address; call: { to: Address; data: `0x${string}`; value: bigint }; approveData?: `0x${string}` },
): Promise<GasForecast | undefined> {
  const estimate = async (to: Address, data: `0x${string}`, value: bigint): Promise<bigint | undefined> => {
    try {
      return await ctx.publicClient.estimateGas({ account: ctx.accountAddress, to, data, value });
    } catch {
      return undefined;
    }
  };

  // Likely effective price = next block's base fee + the tip. viem's maxFeePerGas
  // carries deliberate headroom, so using it here would overstate the cost.
  let gasPrice: bigint | undefined;
  try {
    const [block, fees] = await Promise.all([ctx.publicClient.getBlock(), ctx.publicClient.estimateFeesPerGas().catch(() => undefined)]);
    gasPrice = block.baseFeePerGas != null ? block.baseFeePerGas + (fees?.maxPriorityFeePerGas ?? 0n) : await ctx.publicClient.getGasPrice();
  } catch {
    return undefined;
  }
  if (!gasPrice) return undefined;

  let totalGas = 0n;
  let approximate = false;
  if (params.approveData) {
    const approveGas = await estimate(params.token, params.approveData, 0n);
    totalGas += approveGas ?? APPROVE_GAS_REFERENCE;
    if (approveGas === undefined) approximate = true;
  }
  const depositGas = await estimate(params.call.to, params.call.data, params.call.value);
  totalGas += depositGas ?? DEPOSIT_GAS_REFERENCE;
  if (depositGas === undefined) approximate = true;

  return { weiCost: totalGas * gasPrice, approximate };
}

/** USD value of a token amount, or null when the price isn't available. */
async function usdValue(chainId: number, tokenAddress: string, amount: bigint, decimals: number): Promise<number | null> {
  const price = await getTokenPriceUsd(chainId, tokenAddress);
  return price ? Number(formatUnits(amount, decimals)) * price : null;
}

const FEE_ACTION = "Transact";

/** Mainnet-only, and the reason is worth stating rather than just greying the menu out. */
function requireMainnet(): boolean {
  if (network.saltEnv === "mainnet") return true;
  p.log.warn(
    "Hinkal has no testnet this app can reach — it serves Ethereum, Polygon, Base and\n" +
      "Arbitrum One, and none of the testnets salt-fi runs on. There is no way to rehearse\n" +
      "these flows with play money.\n\n" +
      "Run with SALT_ENV=mainnet (npm run dev:mainnet) to use them, with real funds.",
  );
  return false;
}

/**
 * How much headroom to leave over a quoted fee when computing a spendable maximum.
 *
 * `/get-fee` is quoted per-token with the generic `"Transact"` action, so it can't tell
 * a transfer from a withdrawal — and a transfer burns ~2.3x the gas (1,226,703 vs
 * 533,477, measured on Arbitrum). The quote under-prices accordingly: a transfer quoted
 * at 0.045437 USDC was charged 0.050387, 10.9% more. Passing `feeAmount` does not cap
 * it. So an amount computed as `balance - quotedFee` can exceed what the enclave will
 * allow, and the operation is refused with the balance looking ample.
 *
 * 25% covers the drift observed with room to spare, at a cost of a fraction of a cent
 * held back.
 */
const FEE_HEADROOM_PERCENT = 125n;

/**
 * The relay fee actually taken, read back from the relayer's transaction: the pool pays
 * itself out to the relayer in `feeToken`, so the fee is the transfer whose recipient is
 * the account that broadcast. Falls back to the quote when the receipt can't be read.
 *
 * Worth the extra round trip because the quote and the charge genuinely differ, and
 * reporting the quote as though it were the charge is how a cost display lies.
 *
 * A native-asset fee moves by internal call and emits no log, so that case falls back
 * to the quote — the same graceful path as an unreadable receipt.
 */
async function actualRelayFee(ctx: HinkalContext, txHash: string, feeToken: Address, quoted: bigint): Promise<bigint> {
  try {
    const hash = txHash as `0x${string}`;
    const [tx, receipt] = await Promise.all([
      ctx.publicClient.getTransaction({ hash }),
      ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }),
    ]);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== feeToken.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (event.eventName !== "Transfer") continue;
        const args = event.args as unknown as { to: string; value: bigint };
        if (args.to.toLowerCase() === tx.from.toLowerCase()) return args.value;
      } catch {
        // Not a Transfer we can decode — keep looking.
      }
    }
  } catch {
    // Receipt not available yet, or a flaky RPC.
  }
  return quoted;
}

/**
 * Warn — specifically, not generically — when a deposit is about to ask an owner to add
 * the Hinkal pool to an allowed-recipients whitelist.
 *
 * `resolvePolicies` already offers to add a blocked `to` address, and its prompt reads
 * the same whether the address is a swap router or this. It isn't the same. Whitelisting
 * a router lets the account swap; whitelisting the pool lets the account pay anyone
 * alive, forever, because everything after the deposit is relayed by Hinkal and never
 * reaches Salt's policy engine at all. One keystroke, wearing the costume of a routine
 * unblock — so the person with the authority to approve it should be told what it does
 * before the generic prompt appears, not after.
 *
 * Only fires when the decision is actually live: a whitelist exists for this chain and
 * the pool is not already on it. Best-effort; a failed policy read must not block a
 * deposit that the preflight is about to check properly anyway.
 */
async function warnIfWideningWhitelist(salt: Salt, ctx: HinkalContext, pool: Address): Promise<void> {
  let policies: Policy[];
  try {
    policies = await salt.listAccountPolicies(ctx.accountId);
  } catch {
    return;
  }

  // `chain` is an exact string match against the transaction's network, or '*' for all.
  const applicable = policies.filter(
    (policy) => policy.type === "allowed_recipients" && (policy.chain === "*" || policy.chain === String(ctx.chainId)),
  );
  if (applicable.length === 0) return;

  const alreadyListed = applicable.some((policy) =>
    ((policy.params as { recipients?: { address: string }[] }).recipients ?? []).some(
      (recipient) => recipient.address.toLowerCase() === pool.toLowerCase(),
    ),
  );
  if (alreadyListed) return;

  p.log.warn(
    "You are about to be asked to whitelist the Hinkal pool. That is not the same kind of\n" +
      "decision as whitelisting a swap router, and the prompt below looks identical.\n\n" +
      `Once ${pool} is on the list, anything this account\n` +
      "shields can be paid out to ANY address by Hinkal's relayer. Withdrawals and transfers\n" +
      "are broadcast by Hinkal, not by this account, so Salt never sees a transaction and the\n" +
      "whitelist never applies to them.\n\n" +
      "Adding this one address effectively retires the whitelist as a constraint on anything\n" +
      "routed through Hinkal. It persists until an owner removes it, and every signer on the\n" +
      "account can use it." +
      (ctx.isOwner ? "" : "\n\nYou're not an owner, so you can't add it — but whoever you ask should see this too."),
  );
}

/**
 * Explain an insufficient-funds refusal, which is confusing when the balance on screen
 * looks ample. Two causes we know of, and the app can't currently tell them apart from
 * the enclave's response: blocked notes inflating the reported balance, and the pool
 * declining to leave zero change when an operation consumes a holding exactly.
 */
function explainInsufficientFunds(err: unknown, holding: ShieldedHolding): void {
  if (!/insufficient/i.test((err as Error)?.message ?? "")) return;
  const symbol = holding.token.symbol;
  p.log.info(
    `Hinkal reports ${formatUnits(holding.balance, holding.token.decimals)} ${symbol} shielded` +
      (holding.stuck > 0n ? `, of which ${formatUnits(holding.stuck, holding.token.decimals)} is stuck` : "") +
      ".\nThe fee is re-priced when the operation executes and can exceed the quote, so an amount right\n" +
      "at the maximum can tip over the balance. Try a little less. Nothing was broadcast — a refusal\n" +
      "costs no gas.",
  );
}

/** Shown before anything that moves money without passing through Salt's policy engine. */
function renderPolicyGap(operation: string): void {
  p.log.warn(
    `Account policies do NOT apply to this ${operation}.\n` +
      "Hinkal's relayer broadcasts it, not your account, so Salt never sees a transaction to\n" +
      "check — an allowed-recipients whitelist or per-transaction limit will not constrain it.",
  );
}

interface HinkalContext {
  session: HinkalSession;
  accountId: string;
  accountName: string;
  accountAddress: Address;
  chainId: HinkalChainId;
  chainName: string;
  publicClient: PublicClient;
  selfAddress: Address;
  isOwner: boolean;
  /** Hinkal's supported tokens on this chain, for symbols and decimals. */
  tokens: Map<string, HinkalToken>;
  /** Other accounts in this organisation the caller signs for — transfer targets
   *  whose receiving code the app can derive instead of asking for a paste. */
  siblings: { id: string; name: string; address: Address }[];
}

/**
 * Pick an organisation, account and chain, then open (or reuse) a Hinkal session for
 * that account. The session is where the MPC ceremony happens — once per 24 hours,
 * covering every operation after it — so a reused session means the rest of this
 * menu runs with no Robo Guardian involvement at all.
 */
async function openContext(salt: Salt, walletClient: SaltWalletClient, verb: string): Promise<HinkalContext | undefined> {
  const selfAddress = walletClient.account.address;

  const organisationId = await pickOrganisation(salt, `${verb} from which organisation?`);
  if (!organisationId) return undefined;

  let accounts;
  let organisation;
  try {
    [accounts, { organisation }] = await Promise.all([
      salt.getAccounts(organisationId),
      salt.getOrganisationById(organisationId),
    ]);
  } catch (err) {
    reportError(err);
    return undefined;
  }

  const isOwner =
    organisation.collaborators.find((m) => m.address.toLowerCase() === selfAddress.toLowerCase())?.accessLevel === 1;

  const eligibleAccounts = accounts.filter(
    (account) =>
      Boolean(account.evmAddress) &&
      account.signers.some((signer) => signer.toLowerCase() === selfAddress.toLowerCase()),
  );
  if (eligibleAccounts.length === 0) {
    p.log.info("No accounts here are both fully set up and ones you're a signer on.");
    return undefined;
  }

  const accountId = await select({
    message: `${verb} from which account?`,
    options: eligibleAccounts.map((a) => ({ value: a.id, label: a.name, hint: a.evmAddress })),
  });
  if (p.isCancel(accountId)) return undefined;
  const account = eligibleAccounts.find((a) => a.id === accountId)!;
  const accountAddress = getAddress(account.evmAddress as string);

  const chainId = await select({
    message: "On which chain?",
    options: HINKAL_CHAIN_IDS.map((id) => ({ value: id, label: CHAIN_NAME_BY_ID[String(id)] ?? String(id) })),
  });
  if (p.isCancel(chainId)) return undefined;
  const chainName = CHAIN_NAME_BY_ID[String(chainId)] ?? String(chainId);

  const cached = sessions.get(accountId);
  let session = cached && sessionIsLive(cached) ? cached : undefined;
  if (!session) {
    const s = p.spinner();
    s.start("Opening a Hinkal session — MPC ceremony (your Robo Guardians co-sign)");
    try {
      session = await createSession({
        salt,
        walletClient,
        accountId,
        accountAddress,
        onProgress: (message) => s.message(`Opening a Hinkal session — ${message}`),
      });
      sessions.set(accountId, session);
      s.stop(`Session open until ${session.expiresAt.toLocaleString()} — no further signing needed until then`);
    } catch (err) {
      s.stop("Could not open a Hinkal session");
      reportError(err);
      return undefined;
    }
  }

  let tokens: HinkalToken[];
  try {
    tokens = await getSupportedTokens(chainId);
  } catch (err) {
    reportError(err);
    return undefined;
  }

  return {
    session,
    accountId,
    accountName: account.name,
    accountAddress,
    chainId,
    chainName,
    publicClient: createPublicClient({ chain: CHAIN_BY_ID[String(chainId)], transport: http(rpcUrl(String(chainId))) }),
    selfAddress,
    isOwner,
    tokens: new Map(tokens.map((t) => [t.erc20TokenAddress.toLowerCase(), t])),
    siblings: eligibleAccounts
      .filter((a) => a.id !== accountId)
      .map((a) => ({ id: a.id, name: a.name, address: getAddress(a.evmAddress as string) })),
  };
}

/**
 * A sibling account's shielded receiving code.
 *
 * Hinkal only ever hands out the code for the address whose session is asking — there
 * is no lookup by address — so this opens a second session, as that account. That
 * means a second MPC ceremony, with THAT account's Robo Guardians, which is worth
 * saying out loud before it starts rather than letting a surprise signing round
 * appear. It is cached like any other session, so switching to that account later in
 * the sitting is free.
 */
async function siblingReceivingCode(
  salt: Salt,
  walletClient: SaltWalletClient,
  ctx: HinkalContext,
  sibling: { id: string; name: string; address: Address },
): Promise<string | undefined> {
  const s = p.spinner();
  const cached = sessions.get(sibling.id);
  let session = cached && sessionIsLive(cached) ? cached : undefined;

  if (!session) {
    s.start(`Deriving ${sibling.name}'s receiving code — ${sibling.name}'s Robo Guardians co-sign`);
    try {
      session = await createSession({
        salt,
        walletClient,
        accountId: sibling.id,
        accountAddress: sibling.address,
        onProgress: (message) => s.message(`Opening ${sibling.name}'s session — ${message}`),
      });
      sessions.set(sibling.id, session);
    } catch (err) {
      s.stop(`Could not open a session as ${sibling.name}`);
      reportError(err);
      return undefined;
    }
  } else {
    s.start(`Reading ${sibling.name}'s receiving code`);
  }

  try {
    const code = await getRecipientInfo(session, ctx.chainId);
    s.stop(`Resolved ${sibling.name}'s receiving code`);
    return code;
  } catch (err) {
    s.stop(`Could not read ${sibling.name}'s receiving code`);
    reportError(err);
    return undefined;
  }
}

/** A shielded holding, joined against Hinkal's token list so it has a symbol. */
interface ShieldedHolding {
  token: HinkalToken;
  /** Everything Hinkal reports as shielded, stuck notes included. */
  balance: bigint;
  /** Blocked notes — counted in `balance` but not spendable by transfer or withdraw. */
  stuck: bigint;
  /** `balance - stuck`: what an operation can actually draw on, before fees. */
  spendable: bigint;
}

/**
 * Non-zero shielded balances, largest first, with the blocked portion separated out.
 *
 * `/balance` and `/stuck-utxo-balance` are distinct endpoints, and the totals the
 * first returns include notes the second reports as stuck — notes a transfer will
 * refuse to spend. Treating the headline balance as spendable is what produces an
 * insufficient-funds failure against a full-looking balance, so the split happens
 * here, once, and every caller works from `spendable`.
 */
async function loadShielded(ctx: HinkalContext): Promise<ShieldedHolding[] | undefined> {
  const s = p.spinner();
  s.start(`Reading shielded balance on ${ctx.chainName}`);
  try {
    // Stuck notes are the unusual case; never let that lookup fail the whole read.
    const [balances, stuckList] = await Promise.all([
      getBalances(ctx.session, ctx.chainId),
      getStuckBalances(ctx.session, ctx.chainId).catch(() => [] as Awaited<ReturnType<typeof getStuckBalances>>),
    ]);
    const stuckByToken = new Map(stuckList.map((b) => [b.tokenAddress.toLowerCase(), BigInt(b.balance)]));
    s.stop("Shielded balance read");
    return balances
      .map((b) => {
        const key = b.tokenAddress.toLowerCase();
        const balance = BigInt(b.balance);
        const stuck = stuckByToken.get(key) ?? 0n;
        return { token: ctx.tokens.get(key), balance, stuck, spendable: balance - stuck };
      })
      .filter((h): h is ShieldedHolding => h.token !== undefined && h.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : -1));
  } catch (err) {
    s.stop("Could not read shielded balance");
    reportError(err);
    return undefined;
  }
}

/**
 * The account's PUBLIC balances of tokens Hinkal can shield on this chain, keyed by
 * lowercased token address. Best-effort — a balance view is worth showing even if the
 * public side can't be read, so this returns an empty map rather than failing.
 */
async function loadPublic(ctx: HinkalContext): Promise<Map<string, bigint>> {
  try {
    const tokens = await fetchAccountTokens(ctx.accountAddress, { raw: true, networks: [String(ctx.chainId)] });
    return new Map(
      tokens
        .filter((t) => ctx.tokens.has(t.address.toLowerCase()))
        .map((t) => [t.address.toLowerCase(), t.balance as bigint]),
    );
  } catch {
    return new Map();
  }
}

/**
 * View shielded balances alongside the public ones. Read-only — nothing is signed and
 * nothing moves.
 *
 * Both columns, because either number alone leaves you guessing: the shielded side
 * says what you can send or withdraw, the public side says what you could still
 * shield, and the whole point of visiting this screen is usually to decide between
 * those. Only tokens Hinkal supports here are listed — a public balance it can't
 * shield isn't an option, so it would just be noise.
 */
async function balanceFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const ctx = await openContext(salt, walletClient, "Read balances");
  if (!ctx) return;

  const holdings = await loadShielded(ctx);
  if (!holdings) return;

  const s = p.spinner();
  s.start("Reading public balances");
  const publicBalances = await loadPublic(ctx);
  s.stop("Balances read");

  // Union of both sides: a token can be shielded with nothing public left, or sitting
  // public with nothing shielded yet. Rows that are zero on both are dropped.
  const shieldedByToken = new Map(holdings.map((h) => [h.token.erc20TokenAddress.toLowerCase(), h.balance]));
  const stuckByToken = new Map(holdings.map((h) => [h.token.erc20TokenAddress.toLowerCase(), h.stuck]));
  const rows = [...new Set([...shieldedByToken.keys(), ...publicBalances.keys()])]
    .map((address) => {
      const token = ctx.tokens.get(address)!;
      return {
        symbol: token.symbol,
        shielded: shieldedByToken.get(address) ?? 0n,
        stuck: stuckByToken.get(address) ?? 0n,
        unshielded: publicBalances.get(address) ?? 0n,
        decimals: token.decimals,
      };
    })
    .filter((r) => r.shielded > 0n || r.unshielded > 0n)
    .sort((a, b) => (b.shielded > a.shielded ? 1 : b.shielded < a.shielded ? -1 : a.symbol.localeCompare(b.symbol)));

  if (rows.length === 0) {
    p.log.info(`Nothing on ${ctx.chainName} that Hinkal shields — neither shielded nor available to shield.`);
    return;
  }

  const fmt = (v: bigint, d: number) => formatUnits(v, d);
  // The stuck column only earns its width when something is actually stuck.
  const anyStuck = rows.some((r) => r.stuck > 0n);
  const w = {
    symbol: Math.max(6, ...rows.map((r) => r.symbol.length)),
    shielded: Math.max(8, ...rows.map((r) => fmt(r.shielded, r.decimals).length)),
    stuck: Math.max(5, ...rows.map((r) => fmt(r.stuck, r.decimals).length)),
    unshielded: Math.max(10, ...rows.map((r) => fmt(r.unshielded, r.decimals).length)),
  };
  const header =
    `${"".padEnd(w.symbol)}  ${"shielded".padStart(w.shielded)}` +
    (anyStuck ? `  ${"stuck".padStart(w.stuck)}` : "") +
    `  ${"unshielded".padStart(w.unshielded)}`;
  const body = rows.map(
    (r) =>
      `${r.symbol.padEnd(w.symbol)}  ${fmt(r.shielded, r.decimals).padStart(w.shielded)}` +
      (anyStuck ? `  ${fmt(r.stuck, r.decimals).padStart(w.stuck)}` : "") +
      `  ${fmt(r.unshielded, r.decimals).padStart(w.unshielded)}`,
  );

  p.note([header, ...body].join("\n"), `${ctx.accountName} on ${ctx.chainName}`);
  if (anyStuck) {
    p.log.warn(
      "Some shielded balance is in stuck notes. It counts toward the shielded total but cannot be\n" +
        "spent by a transfer or withdrawal, so the spendable maximum in those flows is lower.",
    );
  }

  if (publicBalances.size === 0) {
    p.log.warn("Couldn't read public balances just now — the unshielded column may be understated.");
  } else if (rows.some((r) => r.symbol === CHAIN_BY_ID[String(ctx.chainId)]?.nativeCurrency.symbol && r.unshielded > 0n)) {
    p.log.info("Not all unshielded native balance is shieldable — gas for the deposit comes out of it too.");
  }

  const spent = await renderCosts(ctx);
  if (spent) p.note(spent, "What Hinkal has cost this session");
}

/**
 * Show this account's shielded receiving code, for someone else to send to with
 * {@link transferFlow}. It is not the account's public address, and Hinkal offers no
 * directory to look one up — share it out of band or the privacy is moot.
 */
async function receiveFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const ctx = await openContext(salt, walletClient, "Receive");
  if (!ctx) return;

  try {
    const recipientInfo = await getRecipientInfo(ctx.session, ctx.chainId);
    p.note(
      `${recipientInfo}\n\n` +
        "Share this out of band with whoever is paying you. It is not your public address,\n" +
        "and it cannot be looked up from one.",
      `${ctx.accountName} — shielded receiving code on ${ctx.chainName}`,
    );
  } catch (err) {
    reportError(err);
  }
}

/**
 * PUBLIC → SHIELDED. The one leg the account submits itself, and therefore the one
 * leg that is publicly visible and policy-checked: anyone watching the chain sees
 * this account fund Hinkal, but nothing after it.
 */
async function depositFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const ctx = await openContext(salt, walletClient, "Deposit");
  if (!ctx) return;

  const s = p.spinner();
  s.start(`Fetching public balances on ${ctx.chainName}`);
  let depositable;
  try {
    const tokens = await fetchAccountTokens(ctx.accountAddress, { raw: true, networks: [String(ctx.chainId)] });
    depositable = tokens.filter((t) => t.balance > 0n && ctx.tokens.has(t.address.toLowerCase()));
    s.stop(`Found ${depositable.length} depositable balance(s) on ${ctx.chainName}`);
  } catch (err) {
    s.stop("Failed to fetch balances");
    reportError(err);
    return;
  }
  if (depositable.length === 0) {
    p.log.info(`Nothing on ${ctx.chainName} that Hinkal shields. It supports ${ctx.tokens.size} tokens on this chain.`);
    return;
  }

  const index = await select({
    message: "Deposit which asset?",
    options: depositable.map((t, i) => ({
      value: i,
      label: t.symbol,
      hint: `${formatUnits(t.balance, t.decimals)} available`,
    })),
  });
  if (p.isCancel(index)) return;
  const asset = depositable[index];
  const max = formatUnits(asset.balance, asset.decimals);

  const amountInput = await p.text({
    message: `How much ${asset.symbol}? (max ${max})`,
    validate: (v) => {
      if (!v || Number.isNaN(Number(v)) || Number(v) <= 0) return "Enter a positive amount";
      if (parseUnits(v, asset.decimals) > asset.balance) return `Exceeds balance (${max} ${asset.symbol})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return;
  const amount = parseUnits(amountInput, asset.decimals);
  const token = getAddress(asset.address);

  s.start("Building the deposit");
  let call;
  try {
    call = depositCall(await buildDeposit(ctx.session, { chainId: ctx.chainId, amounts: [{ token, amount }] }));
    s.stop("Deposit built");
  } catch (err) {
    s.stop("Hinkal could not build the deposit");
    reportError(err);
    return;
  }

  // The contract we call is the one that pulls the tokens, so it's the address the
  // allowance has to name. Native deposits arrive as `value` and need no approval.
  const isNative = amount > 0n && call.value === amount;
  let approveData: `0x${string}` | undefined;
  if (!isNative) {
    try {
      const allowance = await ctx.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [ctx.accountAddress, call.to],
      });
      if (allowance < amount) approveData = encodeApprove(call.to, amount);
    } catch (err) {
      reportError(err);
      return;
    }
  }

  // Gas is the bigger and far more variable of the two costs of a round trip, so
  // price it BEFORE the confirm rather than reporting it afterwards.
  const gasSpinner = p.spinner();
  gasSpinner.start("Estimating gas");
  const forecast = await forecastDepositGas(ctx, { token, call, approveData });
  const native = nativeAsset(ctx);
  let gasLine = "";
  let gasWarning: string | undefined;
  if (forecast) {
    const priced = await withUsd(ctx.chainId, native.address, forecast.weiCost, 18, native.symbol);
    gasLine = `\n  gas:   ${forecast.approximate ? "≈" : "~"}${priced}` + (forecast.approximate ? " (estimated — the approval hasn't landed yet)" : "");
    gasSpinner.stop(`Estimated gas: ${priced}`);

    // Gas that's a large slice of what you're shielding is the real trap here, and
    // it's chain- and moment-dependent rather than something a static warning can catch.
    const [gasUsd, depositUsd] = await Promise.all([
      usdValue(ctx.chainId, native.address, forecast.weiCost, 18),
      usdValue(ctx.chainId, token, amount, asset.decimals),
    ]);
    if (gasUsd && depositUsd && gasUsd > depositUsd * 0.1) {
      gasWarning =
        `Gas is ${((gasUsd / depositUsd) * 100).toFixed(0)}% of what you're shielding ` +
        `($${gasUsd.toFixed(2)} to shield $${depositUsd.toFixed(2)}).\n` +
        "A Hinkal deposit verifies a ZK proof on-chain, so it costs ~37x a plain transfer and\n" +
        "scales with the gas price, not the amount. Shielding more at once, or using a cheaper\n" +
        "chain, changes this ratio; waiting for lower gas changes it too.";
    }
  } else {
    gasSpinner.stop("Could not estimate gas — it will be charged at whatever the chain costs on submit");
  }

  p.note(
    `Shield ${amountInput} ${asset.symbol} on ${ctx.chainName}\n` +
      `  from:  ${ctx.accountName} (${ctx.accountAddress})\n` +
      `  to:    Hinkal pool (${call.to})` +
      gasLine +
      "\n  ⚠ this leg is PUBLIC — it is visible that this account funded Hinkal.\n" +
      "     What you do with the shielded balance afterwards is not.",
    "Deposit — public → shielded",
  );
  if (gasWarning) p.log.warn(gasWarning);

  const txs: PreflightTx[] = [
    ...(approveData
      ? [{ label: `Approve ${asset.symbol}`, to: token, data: approveData, whitelistNickname: `${asset.symbol} token` }]
      : []),
    { label: "Deposit", to: call.to, data: call.data, whitelistNickname: "Hinkal pool" },
  ];
  await warnIfWideningWhitelist(salt, ctx, call.to);

  const decision = await resolvePolicies(salt, ctx.accountId, ctx.selfAddress, String(ctx.chainId), ctx.isOwner, txs, "deposit");
  if (decision === "abort") return;
  if (decision === "clear") {
    const confirmed = await p.confirm({ message: "Send this deposit?" });
    if (p.isCancel(confirmed) || !confirmed) return;
  }

  const submitBase = {
    accountId: ctx.accountId,
    chainId: Number(ctx.chainId),
    userAddress: ctx.selfAddress,
    walletClient,
    publicClient: ctx.publicClient,
  };
  try {
    const approveHash = approveData
      ? await submitAndTrack(salt, { ...submitBase, to: token, value: 0n, data: approveData }, `Approving ${asset.symbol}`)
      : undefined;
    const hash = await submitAndTrack(salt, { ...submitBase, ...call }, "Depositing");

    // The account pays this one itself — it's the only leg of a Hinkal round trip
    // that costs gas, since the relayer covers the way out.
    const gas = await gasSpent(ctx, [approveHash, hash]);
    ledgerFor(ctx).gasWei += gas;

    const explorer = hash ? explorerTxUrl(String(ctx.chainId), hash) : undefined;
    p.log.success(
      `Shielded ${amountInput} ${asset.symbol} on ${ctx.chainName}` +
        (gas > 0n ? `\n  gas: ${await withUsd(ctx.chainId, native.address, gas, 18, native.symbol)}` : "") +
        (explorer ? `\n  ${explorer}` : hash ? `\n  tx hash: ${hash}` : ""),
    );
  } catch (err) {
    reportError(err);
  }
}

/**
 * Prompt for an amount out of a shielded holding, leaving room for the relayer fee.
 * The fee comes out of the same shielded balance, so the spendable maximum is the
 * balance minus the fee — asking for the full balance would just fail at the enclave.
 */
async function promptShieldedAmount(holding: ShieldedHolding, fee: bigint): Promise<bigint | undefined> {
  if (holding.stuck > 0n) {
    p.log.warn(
      `${formatUnits(holding.stuck, holding.token.decimals)} ${holding.token.symbol} of this balance is in stuck ` +
        "notes, which a transfer or withdrawal cannot spend.\nIt is excluded from the maximum below; recovering it " +
        "needs Hinkal's stuck-UTXO withdrawal, which this app doesn't expose yet.",
    );
  }
  // Headroom over the quote, not the quote itself — see FEE_HEADROOM_PERCENT.
  const spendable = holding.spendable - (fee * FEE_HEADROOM_PERCENT) / 100n;
  if (spendable <= 0n) {
    p.log.info(
      `The ${formatUnits(holding.spendable, holding.token.decimals)} ${holding.token.symbol} spendable here ` +
        `doesn't cover the ${formatUnits(fee, holding.token.decimals)} ${holding.token.symbol} relayer fee.`,
    );
    return undefined;
  }
  const max = formatUnits(spendable, holding.token.decimals);
  const amountInput = await p.text({
    message: `How much ${holding.token.symbol}? (max ${max} — the fee plus a margin is held back)`,
    validate: (v) => {
      if (!v || Number.isNaN(Number(v)) || Number(v) <= 0) return "Enter a positive amount";
      if (parseUnits(v, holding.token.decimals) > spendable) return `Exceeds spendable balance (${max})`;
      return undefined;
    },
  });
  if (p.isCancel(amountInput)) return undefined;
  return parseUnits(amountInput, holding.token.decimals);
}

/**
 * Pick a shielded holding and price the relayer fee against it. The fee is charged in
 * the token being moved, which keeps the flow to one asset and one decision.
 */
async function pickHoldingAndFee(
  ctx: HinkalContext,
  message: string,
): Promise<{ holding: ShieldedHolding; fee: bigint } | undefined> {
  const holdings = await loadShielded(ctx);
  if (!holdings) return undefined;
  if (holdings.length === 0) {
    p.log.info(`No shielded balance on ${ctx.chainName} yet — deposit first.`);
    return undefined;
  }

  const index = await select({
    message,
    options: holdings.map((h, i) => ({
      value: i,
      label: h.token.symbol,
      hint: `${formatUnits(h.balance, h.token.decimals)} shielded`,
    })),
  });
  if (p.isCancel(index)) return undefined;
  const holding = holdings[index];
  const token = getAddress(holding.token.erc20TokenAddress);

  const s = p.spinner();
  s.start("Pricing the relayer fee");
  try {
    const fee = await getFee(ctx.session, {
      chainId: ctx.chainId,
      feeToken: token,
      tokenAddresses: [token],
      externalActionId: FEE_ACTION,
    });
    s.stop(`Relayer fee: ${formatUnits(fee, holding.token.decimals)} ${holding.token.symbol}`);
    return { holding, fee };
  } catch (err) {
    s.stop("Could not price the relayer fee");
    reportError(err);
    return undefined;
  }
}

/**
 * SHIELDED → PUBLIC. Hinkal's relayer broadcasts, so the recipient receives funds
 * with no on-chain trail back to this account.
 *
 * Note the trap if anyone reaches for this to fund Hyperliquid: the HyperCore bridge
 * credits whoever sends to it, and that would be the relayer, not this account.
 */
async function withdrawFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const ctx = await openContext(salt, walletClient, "Withdraw");
  if (!ctx) return;

  const picked = await pickHoldingAndFee(ctx, "Withdraw which asset?");
  if (!picked) return;
  const { holding, fee } = picked;

  const amount = await promptShieldedAmount(holding, fee);
  if (amount === undefined) return;

  // No default, deliberately. Pre-filling this with the account's own address — as an
  // earlier version did — offers the one destination that undoes the privacy the
  // deposit just paid for, and offers it as the thing you get by pressing Enter.
  // Withdrawing to yourself is legitimate, but it should be typed, not defaulted into.
  const recipientInput = await p.text({
    message: "Withdraw to which public address?",
    placeholder: "0x… — an address with no public link to this account",
    validate: (v) => (/^0x[0-9a-fA-F]{40}$/.test(v ?? "") ? undefined : "Enter a valid 0x address"),
  });
  if (p.isCancel(recipientInput)) return;
  const recipientAddress = getAddress(recipientInput);
  const token = getAddress(holding.token.erc20TokenAddress);
  const symbol = holding.token.symbol;

  const toSelf = recipientAddress.toLowerCase() === ctx.accountAddress.toLowerCase();
  p.note(
    `Withdraw ${formatUnits(amount, holding.token.decimals)} ${symbol} on ${ctx.chainName}\n` +
      `  to:    ${recipientAddress}${toSelf ? " (this account)" : ""}\n` +
      `  fee:   ~${formatUnits(fee, holding.token.decimals)} ${symbol} quoted, from the shielded balance\n` +
      "  sent by Hinkal's relayer — this account is not the sender on-chain",
    "Withdraw — shielded → public",
  );
  if (toSelf) {
    p.log.warn(
      "This withdraws back to the account that made the deposit.\n" +
        "Both legs are then publicly visible and trivially linked, so the shielding is undone —\n" +
        "you keep the gas cost and lose the privacy. Send to an unlinked address to keep it.",
    );
  }
  renderPolicyGap("withdrawal");

  const confirmed = await p.confirm({ message: "Send this withdrawal?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Withdrawing — Hinkal is proving and relaying");
  try {
    const txHash = await withdraw(ctx.session, {
      chainId: ctx.chainId,
      amounts: [{ token, amount }],
      recipientAddress,
      feeToken: token,
      feeAmount: fee,
    });
    s.stop("Withdrawal relayed");
    const charged = await actualRelayFee(ctx, txHash, token, fee);
    recordRelayFee(ctx, holding.token, charged);
    const explorer = explorerTxUrl(String(ctx.chainId), txHash);
    p.log.success(
      `Withdrew ${formatUnits(amount, holding.token.decimals)} ${symbol} to ${recipientAddress}` +
        `\n  relayer fee: ${await withUsd(ctx.chainId, token, charged, holding.token.decimals, symbol)}` +
        (charged !== fee ? ` — quoted ${formatUnits(fee, holding.token.decimals)}` : "") +
        `\n  gas: none — the relayer paid it, covered by that fee` +
        (explorer ? `\n  ${explorer}` : `\n  tx hash: ${txHash}`),
    );
  } catch (err) {
    s.stop("Withdrawal failed");
    reportError(err);
    explainInsufficientFunds(err, holding);
  }
}

/**
 * SHIELDED → SHIELDED. Nothing here is publicly linkable — not the sender, not the
 * recipient, not the amount. The recipient's code comes from their own
 * {@link receiveFlow}, shared out of band.
 */
async function transferFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  const ctx = await openContext(salt, walletClient, "Transfer");
  if (!ctx) return;

  const picked = await pickHoldingAndFee(ctx, "Transfer which asset?");
  if (!picked) return;
  const { holding, fee } = picked;

  const amount = await promptShieldedAmount(holding, fee);
  if (amount === undefined) return;

  // Paying another account in the org is the common case and the one worth making
  // easy: the app can derive that account's receiving code itself, so nobody has to
  // leave the flow, switch accounts, and shuttle a 442-character blob back by hand.
  const PASTE = "__paste__";
  // With no other accounts to offer, the picker would be a one-option menu — go
  // straight to the paste prompt, the way "Send" does.
  let target: string | symbol = PASTE;
  if (ctx.siblings.length > 0) {
    target = await select({
      message: "Send to whom?",
      options: [
        ...ctx.siblings.map((sib) => ({ value: sib.id, label: sib.name, hint: `account in this organisation — ${sib.address}` })),
        { value: PASTE, label: "Someone else (paste their receiving code)", hint: "they get it from \"My receiving code\"" },
      ],
    });
    if (p.isCancel(target)) return;
  }

  let recipient: string;
  let recipientLabel: string;
  let verified: boolean;
  if (target === PASTE) {
    const pasted = await p.text({
      message: "Recipient's shielded receiving code",
      placeholder: "0x… — from their \"My receiving code\"",
      validate: (v) => (v && v.trim().length > 0 ? undefined : "Required — ask the recipient for their code"),
    });
    if (p.isCancel(pasted)) return;
    recipient = pasted.trim();
    recipientLabel = `${recipient.slice(0, 24)}…`;
    verified = false;
  } else {
    const sibling = ctx.siblings.find((s) => s.id === target)!;
    const code = await siblingReceivingCode(salt, walletClient, ctx, sibling);
    if (!code) return;
    recipient = code;
    recipientLabel = `${sibling.name} (${sibling.address})`;
    verified = true;
  }

  const token = getAddress(holding.token.erc20TokenAddress);
  const symbol = holding.token.symbol;

  p.note(
    `Transfer ${formatUnits(amount, holding.token.decimals)} ${symbol} on ${ctx.chainName}\n` +
      `  to:   ${recipientLabel}\n` +
      `  fee:  ~${formatUnits(fee, holding.token.decimals)} ${symbol} quoted, from the shielded balance\n` +
      "  neither side, nor the amount, is publicly visible" +
      // A code the app derived itself can't be mistyped; a pasted one can, and there
      // is no way to check it before the funds are gone.
      (verified
        ? "\n  code derived in-app from that account — nothing to mistype"
        : "\n  ⚠ the code is unverifiable and the transfer is irreversible — check it with the recipient"),
    "Transfer — shielded → shielded",
  );
  renderPolicyGap("transfer");

  const confirmed = await p.confirm({ message: "Send this transfer?" });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Transferring — Hinkal is proving and relaying");
  try {
    const txHash = await transfer(ctx.session, {
      chainId: ctx.chainId,
      amounts: [{ token, amount }],
      recipient,
      feeToken: token,
      feeAmount: fee,
    });
    s.stop("Transfer relayed");
    const charged = await actualRelayFee(ctx, txHash, token, fee);
    recordRelayFee(ctx, holding.token, charged);
    p.log.success(
      `Transferred ${formatUnits(amount, holding.token.decimals)} ${symbol}` +
        `\n  relayer fee: ${await withUsd(ctx.chainId, token, charged, holding.token.decimals, symbol)}` +
        (charged !== fee ? ` — quoted ${formatUnits(fee, holding.token.decimals)}` : "") +
        `\n  tx hash: ${txHash}`,
    );
  } catch (err) {
    s.stop("Transfer failed");
    reportError(err);
    explainInsufficientFunds(err, holding);
  }
}

export const hinkalBalanceFlow = (salt: Salt, walletClient: SaltWalletClient): Promise<void> =>
  requireMainnet() ? balanceFlow(salt, walletClient) : Promise.resolve();
export const hinkalDepositFlow = (salt: Salt, walletClient: SaltWalletClient): Promise<void> =>
  requireMainnet() ? depositFlow(salt, walletClient) : Promise.resolve();
export const hinkalWithdrawFlow = (salt: Salt, walletClient: SaltWalletClient): Promise<void> =>
  requireMainnet() ? withdrawFlow(salt, walletClient) : Promise.resolve();
export const hinkalTransferFlow = (salt: Salt, walletClient: SaltWalletClient): Promise<void> =>
  requireMainnet() ? transferFlow(salt, walletClient) : Promise.resolve();
export const hinkalReceiveFlow = (salt: Salt, walletClient: SaltWalletClient): Promise<void> =>
  requireMainnet() ? receiveFlow(salt, walletClient) : Promise.resolve();
