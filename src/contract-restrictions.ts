import type { ContractParamRestriction, ContractParamRestrictionOperator } from "salt-sdk";
import {
  type AbiFunction,
  decodeFunctionData,
  getAddress,
  type Hex,
  isAddress,
  parseAbiItem,
  parseUnits,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";

/**
 * Local model of Salt's `contract_param_restriction` policy — the part of the
 * policy engine that constrains smart-contract calls. The server is the
 * authority; this exists to catch, before anything is saved, the mistakes the
 * API accepts but can't enforce the way their author meant:
 *
 * - A value in the wrong format for its Solidity type. The API doesn't validate
 *   `value`, and a malformed one fails CLOSED: every call the restriction
 *   matches becomes a breach, freezing that function until an owner fixes the
 *   policy. The SDK checks that numeric values parse as a BigInt; nothing
 *   checks address, bool or bytes values (`'True'` never matches a bool).
 * - A signature in a non-canonical spelling (`uint` for `uint256`, a trailing
 *   `returns (bool)`). viem — and so the SDK — normalises these when deriving
 *   the parameter's type, but the signature itself is stored verbatim. Saving
 *   the canonical form keeps the selector the engine matches on unambiguous.
 * - A tuple or array argument. The engine compares top-level scalar arguments
 *   only; a struct field or an array element can't be reached.
 * - Restrictions that contradict each other. Every restriction a call matches
 *   must pass (they're ANDed), so e.g. two `eq`s on one argument can never both
 *   hold and the function is frozen outright — there is no "A or B".
 *
 * It also evaluates restrictions against a proposed call, so a breach the
 * server reports can be explained ("amount must be ≤ X; this call has Y")
 * rather than just named.
 */

export type RestrictionOperator = ContractParamRestrictionOperator;

/** How the engine compares an argument, by Solidity type family. */
export type ParamKind = "uint" | "int" | "address" | "bool" | "bytes" | "string";

export interface FunctionParam {
  index: number;
  /** Parameter name, from the signature or {@link KNOWN_PARAM_NAMES}. Display only. */
  name?: string;
  /** Solidity type as parsed, e.g. `uint256`, `address`, `tuple`, `uint256[]`. */
  type: string;
  /** How the engine compares this argument; undefined for tuples and arrays, which it can't. */
  kind?: ParamKind;
}

export interface ParsedFunction {
  /** Canonical signature — e.g. `approve(address,uint256)` — the form to save. */
  signature: string;
  selector: Hex;
  name: string;
  params: FunctionParam[];
  abi: AbiFunction;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export const OPERATOR_LABEL: Record<RestrictionOperator, string> = {
  eq: "eq — equals",
  neq: "neq — not equal",
  lt: "lt — less than",
  lte: "lte — less than or equal",
  gt: "gt — greater than",
  gte: "gte — greater than or equal",
};

export const OPERATOR_SYMBOL: Record<RestrictionOperator, string> = {
  eq: "=",
  neq: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
};

const NUMERIC_OPERATORS: RestrictionOperator[] = ["eq", "neq", "lt", "lte", "gt", "gte"];
const EQUALITY_OPERATORS: RestrictionOperator[] = ["eq", "neq"];

function paramKind(type: string): ParamKind | undefined {
  if (/^uint\d*$/.test(type)) return "uint";
  if (/^int\d*$/.test(type)) return "int";
  if (/^bytes\d*$/.test(type)) return "bytes";
  if (type === "address" || type === "bool" || type === "string") return type;
  return undefined;
}

const isNumeric = (kind: ParamKind | undefined): boolean => kind === "uint" || kind === "int";

/** Operators the engine accepts for an argument of this kind — ordering comparisons are numeric-only. */
export function operatorsFor(kind: ParamKind): RestrictionOperator[] {
  return isNumeric(kind) ? NUMERIC_OPERATORS : EQUALITY_OPERATORS;
}

function parseSignature(input: string): ParsedFunction {
  const trimmed = input.trim();
  let abi: AbiFunction | undefined;
  try {
    const item = parseAbiItem(`function ${trimmed.replace(/^function\s+/, "")}`);
    if (item.type === "function") abi = item;
  } catch {
    // Reported below, in terms a user can act on.
  }
  if (!abi) throw new Error(`"${trimmed}" isn't a function signature — expected something like transfer(address,uint256)`);
  return {
    signature: toFunctionSignature(abi),
    selector: toFunctionSelector(abi),
    name: abi.name,
    params: abi.inputs.map((param, index) => ({
      index,
      name: param.name || undefined,
      type: param.type,
      kind: paramKind(param.type),
    })),
    abi,
  };
}

/**
 * Parameter names for common functions, keyed by canonical signature. Saved
 * signatures are canonical, and canonical signatures carry no names.
 */
const KNOWN_PARAM_NAMES: Record<string, string[]> = Object.fromEntries(
  [
    "transfer(address to, uint256 amount)",
    "approve(address spender, uint256 amount)",
    "transferFrom(address from, address to, uint256 amount)",
    "increaseAllowance(address spender, uint256 addedValue)",
    "decreaseAllowance(address spender, uint256 subtractedValue)",
  ].map((sig) => {
    const fn = parseSignature(sig);
    return [fn.signature, fn.params.map((param) => param.name ?? "")];
  }),
);

/**
 * Parse a human-readable function signature — `approve(address spender, uint256)`,
 * with or without the `function` keyword. Parameter names fall back to
 * {@link KNOWN_PARAM_NAMES}. Throws with a user-facing message if it isn't one.
 */
export function parseFunctionSignature(input: string): ParsedFunction {
  const fn = parseSignature(input);
  const names = KNOWN_PARAM_NAMES[fn.signature];
  if (!names) return fn;
  return { ...fn, params: fn.params.map((param, i) => ({ ...param, name: param.name ?? (names[i] || undefined) })) };
}

/** `amount (arg 1)`, or `arg 1` when the parameter is unnamed. */
export function paramLabel(param: FunctionParam): string {
  return param.name ? `${param.name} (arg ${param.index})` : `arg ${param.index}`;
}

function numericRange(type: string): { min: bigint; max: bigint } {
  const [, unsigned, width] = /^(u?)int(\d*)$/.exec(type) ?? [];
  const bits = BigInt(width || 256);
  return unsigned === "u"
    ? { min: 0n, max: 2n ** bits - 1n }
    : { min: -(2n ** (bits - 1n)), max: 2n ** (bits - 1n) - 1n };
}

/**
 * Check `raw` as the comparison value for `param`, returning it in the form to
 * save. Numeric values are integers in base units (decimal or 0x-hex) that fit
 * the type — or, given `decimals`, a whole-token amount like `1.5`. `bool`
 * must be true/false and is saved lowercase (the engine compares it
 * case-sensitively). Addresses are checksummed; bytes must be well-formed hex
 * of the right length.
 */
export function normalizeValue(param: FunctionParam, raw: string, opts: { decimals?: number } = {}): Checked<string> {
  const value = raw.trim();
  const fail = (error: string): Checked<string> => ({ ok: false, error });

  switch (param.kind) {
    case "uint":
    case "int": {
      let n: bigint;
      if (opts.decimals !== undefined) {
        if (!/^\d+(\.\d+)?$/.test(value)) return fail("Must be an amount, e.g. 100 or 1.5");
        const fraction = value.split(".")[1] ?? "";
        if (fraction.length > opts.decimals) return fail(`Can have at most ${opts.decimals} decimal places for this token`);
        n = parseUnits(value, opts.decimals);
      } else if (/^-?\d+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value)) {
        n = BigInt(value);
      } else {
        return fail(`Must be a whole number in base units, e.g. 1000000 — ${param.type} values can't have decimals`);
      }
      const { min, max } = numericRange(param.type);
      if (n < min || n > max) return fail(`Out of range for ${param.type} (${min} to ${max})`);
      return { ok: true, value: n.toString() };
    }
    case "address":
      return isAddress(value, { strict: false })
        ? { ok: true, value: getAddress(value) }
        : fail("Must be a valid 0x-prefixed address");
    case "bool": {
      const lower = value.toLowerCase();
      return lower === "true" || lower === "false" ? { ok: true, value: lower } : fail("Must be true or false");
    }
    case "bytes": {
      if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) return fail("Must be 0x-prefixed hex, e.g. 0x1234");
      const size = Number(param.type.slice("bytes".length));
      if (size > 0 && value.length !== 2 + size * 2) {
        return fail(`A ${param.type} is exactly ${size} bytes — 0x followed by ${size * 2} hex characters`);
      }
      return { ok: true, value: value.toLowerCase() };
    }
    case "string":
      // Compared case-insensitively, but otherwise exactly — keep what was typed.
      return { ok: true, value: raw };
    default:
      return fail(`A ${param.type} argument can't be restricted — Salt compares top-level scalar arguments only`);
  }
}

/**
 * Check a restriction the way the engine will read it and return it ready to
 * save: canonical signature, checksummed contract address, value normalised
 * for its type. Takes untrusted input (Policy chat's tool calls), so every
 * field's type is checked. `solidityType` is dropped — the SDK derives it.
 */
export function checkRestriction(input: Record<string, unknown>): Checked<ContractParamRestriction> {
  const fail = (error: string): Checked<ContractParamRestriction> => ({ ok: false, error });
  const { contractAddress, functionSignature, paramIndex, operator, value } = input;

  if (typeof contractAddress !== "string" || !isAddress(contractAddress, { strict: false })) {
    return fail(`contractAddress ${JSON.stringify(contractAddress)} isn't a valid address`);
  }
  if (typeof functionSignature !== "string") {
    return fail("functionSignature must be a string like transfer(address,uint256)");
  }
  let fn: ParsedFunction;
  try {
    fn = parseFunctionSignature(functionSignature);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (typeof paramIndex !== "number" || !Number.isInteger(paramIndex) || paramIndex < 0 || paramIndex >= fn.params.length) {
    return fail(
      `paramIndex ${JSON.stringify(paramIndex)} is out of range — ${fn.signature} has ${fn.params.length} argument(s), numbered from 0`,
    );
  }
  const param = fn.params[paramIndex];
  if (!param.kind) {
    return fail(
      `argument ${paramIndex} of ${fn.signature} is a ${param.type} — Salt compares top-level scalar arguments only, so it can't be restricted`,
    );
  }
  const allowed = operatorsFor(param.kind);
  if (typeof operator !== "string" || !allowed.includes(operator as RestrictionOperator)) {
    return fail(`operator ${JSON.stringify(operator)} can't be used with ${param.type} arguments (allowed: ${allowed.join(", ")})`);
  }
  if (typeof value !== "string") {
    return fail(`value must be a string (e.g. "1000000"), got ${JSON.stringify(value)}`);
  }
  const normalized = normalizeValue(param, value);
  if (!normalized.ok) return fail(`value ${JSON.stringify(value)} for ${paramLabel(param)} (${param.type}): ${normalized.error}`);

  return {
    ok: true,
    value: {
      contractAddress: getAddress(contractAddress),
      functionSignature: fn.signature,
      paramIndex,
      operator: operator as RestrictionOperator,
      value: normalized.value,
    },
  };
}

type Constraint = { operator: RestrictionOperator; value: string };

function satisfiable(param: FunctionParam, constraints: Constraint[]): boolean {
  if (isNumeric(param.kind)) {
    let { min: lo, max: hi } = numericRange(param.type);
    const excluded = new Set<bigint>();
    for (const { operator, value } of constraints) {
      const v = BigInt(value);
      if (operator === "neq") excluded.add(v);
      if ((operator === "eq" || operator === "gte") && v > lo) lo = v;
      if ((operator === "eq" || operator === "lte") && v < hi) hi = v;
      if (operator === "gt" && v + 1n > lo) lo = v + 1n;
      if (operator === "lt" && v - 1n < hi) hi = v - 1n;
    }
    if (lo > hi) return false;
    // Only a range no wider than the excluded set can be entirely excluded.
    if (hi - lo + 1n > BigInt(excluded.size)) return true;
    for (let v = lo; v <= hi; v++) if (!excluded.has(v)) return true;
    return false;
  }

  // Values are normalised: bools lowercase, the rest compared case-insensitively.
  const required = new Set(constraints.filter((c) => c.operator === "eq").map((c) => c.value.toLowerCase()));
  const excluded = new Set(constraints.filter((c) => c.operator === "neq").map((c) => c.value.toLowerCase()));
  if (required.size > 1) return false;
  if ([...required].some((v) => excluded.has(v))) return false;
  return !(param.kind === "bool" && excluded.has("true") && excluded.has("false"));
}

/**
 * Arguments no call can satisfy. Every restriction a call matches must pass,
 * so restrictions on the same argument of the same function on the same
 * contract intersect — and when the intersection is empty, every such call is
 * a breach: the function is frozen on that contract. Returns one message per
 * frozen argument. Entries that don't parse are skipped ({@link checkRestriction}
 * reports those).
 */
export function findConflicts(restrictions: readonly ContractParamRestriction[]): string[] {
  const groups = new Map<string, { fn: ParsedFunction; param: FunctionParam; contract: string; constraints: Constraint[] }>();
  for (const r of restrictions) {
    let fn: ParsedFunction;
    try {
      fn = parseFunctionSignature(r.functionSignature);
    } catch {
      continue;
    }
    const param = fn.params[r.paramIndex];
    if (!param?.kind || !operatorsFor(param.kind).includes(r.operator)) continue;
    const normalized = normalizeValue(param, r.value);
    if (!normalized.ok) continue;
    const key = `${r.contractAddress.toLowerCase()}|${fn.selector}|${r.paramIndex}`;
    const group = groups.get(key) ?? { fn, param, contract: r.contractAddress, constraints: [] };
    group.constraints.push({ operator: r.operator, value: normalized.value });
    groups.set(key, group);
  }

  const conflicts: string[] = [];
  for (const { fn, param, contract, constraints } of groups.values()) {
    if (satisfiable(param, constraints)) continue;
    const terms = constraints.map((c) => `${OPERATOR_SYMBOL[c.operator]} ${c.value}`);
    const clash =
      terms.length === 1 ? `can never be ${terms[0]}` : `can't be ${terms.join(" and ")} at once`;
    const eqCount = constraints.filter((c) => c.operator === "eq").length;
    conflicts.push(
      `${fn.name}() on ${contract}: ${paramLabel(param)} ${clash}, so every ${fn.name}() call to this contract would be blocked.` +
        (eqCount > 1 ? " Restrictions are ANDed — Salt can't allow either of two values for one argument." : ""),
    );
  }
  return conflicts;
}

/**
 * Problems with restrictions that are already saved: a malformed value (which
 * fails closed), an argument that can't be compared, a contradiction. Salt
 * accepted them, but they don't do what their author meant — surfaced so an
 * owner can see why a function is frozen, or isn't restricted.
 */
export function auditRestrictions(restrictions: readonly ContractParamRestriction[]): string[] {
  const invalid = restrictions.flatMap((r) => {
    const where = `${r.functionSignature} on ${r.contractAddress}`;
    const checked = checkRestriction({ ...r });
    if (!checked.ok) return [`${where}: ${checked.error}`];
    // Checking normalises a bool's case, which this app does before saving — but a restriction
    // saved some other way may hold "True", and the engine compares bools case-sensitively.
    const param = parseFunctionSignature(r.functionSignature).params[r.paramIndex];
    if (param.kind === "bool" && r.value !== checked.value.value) {
      return [`${where}: value ${JSON.stringify(r.value)} never matches — Salt compares bools case-sensitively, so it must be "${checked.value.value}"`];
    }
    return [];
  });
  return [...invalid, ...findConflicts(restrictions)];
}

/** A proposed call, as the policy engine sees it. */
export interface ContractCall {
  to: string;
  data: string;
}

export type RestrictionOutcome = { applies: false } | { applies: true; passed: boolean; detail: string };

function compare(kind: ParamKind, actual: unknown, operator: RestrictionOperator, expected: string): boolean {
  if (isNumeric(kind)) {
    let a: bigint;
    let e: bigint;
    try {
      a = BigInt(actual as bigint);
      e = BigInt(expected);
    } catch {
      return false; // a malformed value fails closed, as on the server
    }
    switch (operator) {
      case "eq":
        return a === e;
      case "neq":
        return a !== e;
      case "lt":
        return a < e;
      case "lte":
        return a <= e;
      case "gt":
        return a > e;
      case "gte":
        return a >= e;
    }
    return false;
  }
  if (operator !== "eq" && operator !== "neq") return false;
  const same = kind === "bool" ? String(actual) === expected : String(actual).toLowerCase() === expected.toLowerCase();
  return operator === "eq" ? same : !same;
}

/**
 * Evaluate one restriction against a proposed call the way the engine
 * documents it: it applies only to a call of `functionSignature` on
 * `contractAddress`; the decoded argument must then satisfy the comparison,
 * and calldata that doesn't decode is a breach.
 */
export function evaluateRestriction(r: ContractParamRestriction, call: ContractCall): RestrictionOutcome {
  let fn: ParsedFunction;
  try {
    fn = parseFunctionSignature(r.functionSignature);
  } catch {
    return { applies: false };
  }
  if (call.to.toLowerCase() !== r.contractAddress.toLowerCase() || !call.data.toLowerCase().startsWith(fn.selector)) {
    return { applies: false };
  }

  const param = fn.params[r.paramIndex];
  const label = param ? paramLabel(param) : `arg ${r.paramIndex}`;
  const expected = `${OPERATOR_SYMBOL[r.operator] ?? r.operator} ${r.value}`;
  let actual: unknown;
  try {
    actual = decodeFunctionData({ abi: [fn.abi], data: call.data as Hex }).args?.[r.paramIndex];
  } catch {
    return { applies: true, passed: false, detail: `the calldata doesn't decode as ${fn.signature}, which counts as a breach` };
  }
  if (!param?.kind || actual === undefined) return { applies: true, passed: false, detail: `${label} can't be compared` };

  const passed = compare(param.kind, actual, r.operator, r.value);
  return {
    applies: true,
    passed,
    detail: passed ? `${label} is ${String(actual)}` : `${label} must be ${expected}; this call has ${String(actual)}`,
  };
}

/**
 * One line per restriction, e.g.
 * `approve(address,uint256) on USDC (0xaf88…): amount (arg 1) ≤ 100000000`.
 * `label` names known addresses — the contract, and address-typed values.
 */
export function describeRestriction(r: ContractParamRestriction, label?: (address: string) => string | undefined): string {
  const named = (address: string) => {
    const name = label?.(address);
    return name ? `${name} (${address})` : address;
  };
  let param = `arg ${r.paramIndex}`;
  let value = r.value;
  try {
    const p = parseFunctionSignature(r.functionSignature).params[r.paramIndex];
    if (p) {
      param = paramLabel(p);
      if (p.kind === "address" && isAddress(r.value, { strict: false })) value = named(r.value);
    }
  } catch {
    // Describe it as stored.
  }
  return `${r.functionSignature} on ${named(r.contractAddress)}: ${param} ${OPERATOR_SYMBOL[r.operator] ?? r.operator} ${value}`;
}

/**
 * A contract_param_restriction template: fixes the function, argument and
 * operator so the user supplies only the contract and the compared value.
 */
export interface RestrictionPreset {
  label: string;
  hint: string;
  /** Signature with parameter names, for display; the canonical form is what's saved. */
  functionSignature: string;
  paramIndex: number;
  operator: RestrictionOperator;
  /** Prompt shown when collecting the compared value. */
  valuePrompt: string;
  /** The value is an amount of the restricted token, entered in whole-token units. */
  tokenAmount?: boolean;
  /** Shown once picked: what the preset does and doesn't cover. */
  note?: string;
}

const INCREASE_ALLOWANCE_NOTE =
  "Some tokens (USDC among them) can also grant allowances through increaseAllowance(), which\n" +
  "an approve() restriction doesn't cover. Restrict it too on those tokens.";

export const RESTRICTION_PRESETS: RestrictionPreset[] = [
  {
    label: "ERC-20 transfer — only to a specific recipient",
    hint: "direct transfer() calls on this token",
    functionSignature: "transfer(address to, uint256 amount)",
    paramIndex: 0,
    operator: "eq",
    valuePrompt: "Recipient address the transfer must go to",
  },
  {
    label: "ERC-20 approve — only a specific spender",
    hint: "who may be granted an allowance",
    functionSignature: "approve(address spender, uint256 amount)",
    paramIndex: 0,
    operator: "eq",
    valuePrompt: "Spender address that may be approved",
    note: INCREASE_ALLOWANCE_NOTE,
  },
  {
    label: "ERC-20 approve — cap the allowance",
    hint: "bounds what a router, bridge or pool can pull",
    functionSignature: "approve(address spender, uint256 amount)",
    paramIndex: 1,
    operator: "lte",
    valuePrompt: "Largest allowance that may be granted",
    tokenAmount: true,
    note:
      "Swaps, bridges and deposits don't transfer tokens themselves: the contract pulls them with\n" +
      "transferFrom, which per-transaction limits don't see. Capping approve() bounds how much each\n" +
      "approval lets a contract pull. It applies to new approvals only — an allowance granted\n" +
      "before this policy stays as it is.\n\n" +
      INCREASE_ALLOWANCE_NOTE,
  },
  {
    label: "ERC-20 increaseAllowance — only a specific spender",
    hint: "pair with the approve spender preset on tokens that have it",
    functionSignature: "increaseAllowance(address spender, uint256 addedValue)",
    paramIndex: 0,
    operator: "eq",
    valuePrompt: "Spender address that may be approved",
  },
];
