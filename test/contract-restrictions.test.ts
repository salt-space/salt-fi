import type { ContractParamRestriction } from "salt-sdk";
import { type Address, encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  auditRestrictions,
  checkRestriction,
  describeRestriction,
  evaluateRestriction,
  findConflicts,
  normalizeValue,
  operatorsFor,
  parseFunctionSignature,
} from "../src/contract-restrictions.js";

const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ROUTER: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const OTHER: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const abi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function setPaused(bool paused)",
]);
const approve = (spender: Address, amount: bigint) =>
  encodeFunctionData({ abi, functionName: "approve", args: [spender, amount] });

/** The single parameter of `f(<type>)`. */
const param = (type: string) => parseFunctionSignature(`f(${type})`).params[0];

const restriction = (overrides: Partial<ContractParamRestriction> = {}): ContractParamRestriction => ({
  contractAddress: USDC,
  functionSignature: "approve(address,uint256)",
  paramIndex: 0,
  operator: "eq",
  value: ROUTER,
  ...overrides,
});

describe("parseFunctionSignature", () => {
  it("canonicalises type aliases, so the saved signature hashes to the real selector", () => {
    const fn = parseFunctionSignature("transfer(address, uint)");
    expect(fn.signature).toBe("transfer(address,uint256)");
    expect(fn.selector).toBe("0xa9059cbb");
  });

  it("accepts the function keyword and trailing modifiers, keeping parameter names", () => {
    const fn = parseFunctionSignature("function approve(address spender, uint256 amount) external returns (bool)");
    expect(fn.signature).toBe("approve(address,uint256)");
    expect(fn.params.map((p) => p.name)).toEqual(["spender", "amount"]);
  });

  it("fills in parameter names for well-known functions", () => {
    expect(parseFunctionSignature("approve(address,uint256)").params.map((p) => p.name)).toEqual(["spender", "amount"]);
  });

  it("marks tuple and array arguments as not comparable", () => {
    const [tuple] = parseFunctionSignature("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))").params;
    expect(tuple).toMatchObject({ type: "tuple", kind: undefined });
    expect(param("uint256[]").kind).toBeUndefined();
    expect(param("bytes32").kind).toBe("bytes");
  });

  it("rejects anything that isn't a function signature", () => {
    expect(() => parseFunctionSignature("approve")).toThrow(/isn't a function signature/);
    expect(() => parseFunctionSignature("approve(adress,uint256)")).toThrow(/isn't a function signature/);
  });
});

describe("operatorsFor", () => {
  it("allows ordering comparisons on numbers only", () => {
    expect(operatorsFor("uint")).toEqual(["eq", "neq", "lt", "lte", "gt", "gte"]);
    expect(operatorsFor("address")).toEqual(["eq", "neq"]);
    expect(operatorsFor("bool")).toEqual(["eq", "neq"]);
  });
});

describe("normalizeValue", () => {
  it("takes integers in base units, decimal or hex, and saves them as decimal", () => {
    expect(normalizeValue(param("uint256"), "1000000")).toEqual({ ok: true, value: "1000000" });
    expect(normalizeValue(param("uint256"), "0x10")).toEqual({ ok: true, value: "16" });
  });

  it("rejects decimals and out-of-range numbers, which would fail closed on the server", () => {
    expect(normalizeValue(param("uint256"), "1.5").ok).toBe(false);
    expect(normalizeValue(param("uint256"), "-1").ok).toBe(false);
    expect(normalizeValue(param("uint8"), "256").ok).toBe(false);
    expect(normalizeValue(param("int8"), "-128")).toEqual({ ok: true, value: "-128" });
  });

  it("converts whole-token amounts when given the token's decimals", () => {
    expect(normalizeValue(param("uint256"), "1.5", { decimals: 6 })).toEqual({ ok: true, value: "1500000" });
    expect(normalizeValue(param("uint256"), "100", { decimals: 6 })).toEqual({ ok: true, value: "100000000" });
    expect(normalizeValue(param("uint256"), "1.1234567", { decimals: 6 })).toMatchObject({ ok: false });
  });

  it("checksums addresses and rejects malformed ones", () => {
    expect(normalizeValue(param("address"), ROUTER.toLowerCase())).toEqual({ ok: true, value: ROUTER });
    expect(normalizeValue(param("address"), "0x123").ok).toBe(false);
  });

  it("saves bools lowercase, since the engine compares them case-sensitively", () => {
    expect(normalizeValue(param("bool"), "True")).toEqual({ ok: true, value: "true" });
    expect(normalizeValue(param("bool"), "yes").ok).toBe(false);
  });

  it("checks bytes are hex of the right length", () => {
    expect(normalizeValue(param("bytes32"), `0x${"AB".repeat(32)}`)).toEqual({ ok: true, value: `0x${"ab".repeat(32)}` });
    expect(normalizeValue(param("bytes32"), "0x1234")).toMatchObject({ ok: false, error: expect.stringContaining("32 bytes") });
    expect(normalizeValue(param("bytes"), "0x123").ok).toBe(false);
    expect(normalizeValue(param("bytes"), "0x")).toEqual({ ok: true, value: "0x" });
  });

  it("keeps strings exactly as typed, and refuses tuples", () => {
    expect(normalizeValue(param("string"), " Hello ")).toEqual({ ok: true, value: " Hello " });
    expect(normalizeValue(param("(address,uint256)"), "0x").ok).toBe(false);
  });
});

describe("checkRestriction", () => {
  it("returns the restriction normalised for saving", () => {
    const checked = checkRestriction({
      contractAddress: USDC.toLowerCase(),
      functionSignature: "approve(address spender, uint)",
      paramIndex: 1,
      operator: "lte",
      value: "0x64",
      solidityType: "uint256",
    });
    expect(checked).toEqual({
      ok: true,
      value: { contractAddress: USDC, functionSignature: "approve(address,uint256)", paramIndex: 1, operator: "lte", value: "100" },
    });
  });

  it.each([
    [{ contractAddress: "0x123" }, /isn't a valid address/],
    [{ functionSignature: "approve" }, /isn't a function signature/],
    [{ paramIndex: 2 }, /out of range/],
    [{ paramIndex: "0" }, /out of range/],
    [{ functionSignature: "multicall(bytes[])", value: "0x" }, /bytes\[\].*can't be restricted/],
    [{ operator: "lt" }, /can't be used with address arguments/],
    [{ paramIndex: 1, value: "1.5" }, /can't have decimals/],
    [{ paramIndex: 1, value: 100 }, /must be a string/],
  ])("rejects %o", (overrides, message) => {
    const checked = checkRestriction({ ...restriction(), ...overrides });
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error).toMatch(message);
  });
});

describe("findConflicts", () => {
  it("flags two different required spenders — restrictions are ANDed, so no approve() could pass", () => {
    const conflicts = findConflicts([restriction({ value: ROUTER }), restriction({ value: OTHER })]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatch(/approve\(\) on .* every approve\(\) call .* blocked/);
    expect(conflicts[0]).toMatch(/ANDed/);
  });

  it("groups by contract case-insensitively and by selector, not by spelling", () => {
    const conflicts = findConflicts([
      restriction({ value: ROUTER }),
      restriction({ contractAddress: USDC.toLowerCase(), functionSignature: "approve(address spender, uint amount)", value: OTHER }),
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("leaves restrictions on different contracts or arguments alone", () => {
    expect(findConflicts([restriction({ value: ROUTER }), restriction({ contractAddress: OTHER, value: OTHER })])).toEqual([]);
    expect(findConflicts([restriction({ value: ROUTER }), restriction({ paramIndex: 1, operator: "lte", value: "100" })])).toEqual([]);
  });

  it("works out empty numeric ranges", () => {
    const amount = (operator: ContractParamRestriction["operator"], value: string) => restriction({ paramIndex: 1, operator, value });
    expect(findConflicts([amount("lte", "5"), amount("gte", "10")])).toHaveLength(1);
    expect(findConflicts([amount("gte", "5"), amount("lte", "5"), amount("neq", "5")])).toHaveLength(1);
    expect(findConflicts([amount("lt", "0")])[0]).toMatch(/can never be < 0/);
    expect(findConflicts([amount("lte", "100"), amount("eq", "50")])).toEqual([]);
  });

  it("flags eq and neq of the same value, but not a repeated eq", () => {
    expect(findConflicts([restriction({ value: ROUTER }), restriction({ operator: "neq", value: ROUTER.toLowerCase() })])).toHaveLength(1);
    expect(findConflicts([restriction({ value: ROUTER }), restriction({ value: ROUTER.toLowerCase() })])).toEqual([]);
  });
});

describe("auditRestrictions", () => {
  it("passes restrictions that work as written", () => {
    expect(auditRestrictions([restriction(), restriction({ paramIndex: 1, operator: "lte", value: "100" })])).toEqual([]);
  });

  it("flags saved restrictions that fail closed or can never be satisfied", () => {
    const problems = auditRestrictions([
      restriction({ paramIndex: 1, operator: "lte", value: "1.5" }),
      restriction({ functionSignature: "setPaused(bool)", value: "True" }),
      restriction({ value: ROUTER }),
      restriction({ value: OTHER }),
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/approve\(address,uint256\) on .*can't have decimals/);
    expect(problems[1]).toMatch(/"True" never matches .* must be "true"/);
    expect(problems[2]).toMatch(/ANDed/);
  });
});

describe("evaluateRestriction", () => {
  it("passes or fails a matching call on the decoded argument", () => {
    expect(evaluateRestriction(restriction(), { to: USDC, data: approve(ROUTER, 1n) })).toMatchObject({ applies: true, passed: true });
    expect(evaluateRestriction(restriction(), { to: USDC, data: approve(OTHER, 1n) })).toEqual({
      applies: true,
      passed: false,
      detail: `spender (arg 0) must be = ${ROUTER}; this call has ${OTHER}`,
    });
  });

  it("doesn't apply to other contracts or other functions", () => {
    expect(evaluateRestriction(restriction(), { to: OTHER, data: approve(OTHER, 1n) })).toEqual({ applies: false });
    const transfer = encodeFunctionData({ abi, functionName: "transfer", args: [OTHER, 1n] });
    expect(evaluateRestriction(restriction(), { to: USDC, data: transfer })).toEqual({ applies: false });
  });

  it("compares numbers numerically", () => {
    const cap = restriction({ paramIndex: 1, operator: "lte", value: "100" });
    expect(evaluateRestriction(cap, { to: USDC, data: approve(ROUTER, 100n) })).toMatchObject({ passed: true });
    expect(evaluateRestriction(cap, { to: USDC, data: approve(ROUTER, 250n) })).toMatchObject({
      passed: false,
      detail: "amount (arg 1) must be ≤ 100; this call has 250",
    });
  });

  it("treats undecodable calldata and malformed values as breaches, like the server", () => {
    const truncated = `${toFunctionSelector("approve(address,uint256)")}1234`;
    expect(evaluateRestriction(restriction(), { to: USDC, data: truncated })).toMatchObject({ applies: true, passed: false });
    const malformed = restriction({ paramIndex: 1, operator: "lte", value: "1.5" });
    expect(evaluateRestriction(malformed, { to: USDC, data: approve(ROUTER, 1n) })).toMatchObject({ passed: false });
  });

  it("compares bools case-sensitively", () => {
    const data = encodeFunctionData({ abi, functionName: "setPaused", args: [true] });
    const paused = (value: string) => restriction({ functionSignature: "setPaused(bool)", value });
    expect(evaluateRestriction(paused("true"), { to: USDC, data })).toMatchObject({ passed: true });
    expect(evaluateRestriction(paused("True"), { to: USDC, data })).toMatchObject({ passed: false });
  });
});

describe("describeRestriction", () => {
  it("names the parameter and labels known addresses", () => {
    const label = (address: string) => ({ [USDC.toLowerCase()]: "USDC", [ROUTER.toLowerCase()]: "LI.FI" })[address.toLowerCase()];
    expect(describeRestriction(restriction({ paramIndex: 1, operator: "lte", value: "100" }), label)).toBe(
      `approve(address,uint256) on USDC (${USDC}): amount (arg 1) ≤ 100`,
    );
    expect(describeRestriction(restriction(), label)).toBe(
      `approve(address,uint256) on USDC (${USDC}): spender (arg 0) = LI.FI (${ROUTER})`,
    );
  });
});
