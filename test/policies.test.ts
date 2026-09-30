import type { Policy, PolicyParams, PolicyType } from "salt-sdk";
import { type Address, encodeFunctionData, erc20Abi, parseEther } from "viem";
import { describe, expect, it } from "vitest";
import {
  describePolicy,
  explainBreach,
  explainNotEvaluated,
  knownAddressLabel,
  NATIVE_ADDRESS,
  policyCheckParams,
} from "../src/policies.js";

const ARBITRUM = "42161";
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // USDC on Arbitrum One
const LIFI: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const ACCOUNT: Address = "0x1111111111111111111111111111111111111111";
const SIGNER: Address = "0x2222222222222222222222222222222222222222";
const STRANGER: Address = "0x3333333333333333333333333333333333333333";

const policy = (type: PolicyType, params: PolicyParams, chain = ARBITRUM): Policy => ({
  id: `${type}-id`,
  type,
  chain,
  params,
  accountId: "account-id",
  organisationId: "org-id",
});

const approve = (spender: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
const transfer = (to: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

describe("policyCheckParams", () => {
  it("fills the payload the way submitTx fills its transaction record", () => {
    const gas = { gas: "500000", maxFeePerGas: "2", maxPriorityFeePerGas: "1" };
    const call = { chainId: ARBITRUM, to: LIFI, value: parseEther("1.5"), data: "0xabcdef" };
    expect(policyCheckParams(call, ACCOUNT, 7, gas)).toEqual({
      nonce: 7,
      // The native value — native limits read it — and the account (not the signer) as sender.
      amount: "1500000000000000000",
      from: ACCOUNT,
      to: LIFI,
      network: ARBITRUM,
      data: "0xabcdef",
      ...gas,
    });
  });
});

describe("explainBreach", () => {
  const nativeLimit = policy("transaction_limit_token_denominated", {
    limits: [{ address: NATIVE_ADDRESS, amount: parseEther("1").toString() }],
  });

  it("explains a native limit from the call's value", () => {
    const call = { chainId: ARBITRUM, to: LIFI, value: parseEther("1.5"), data: "0x" };
    expect(explainBreach(nativeLimit, call)).toEqual(["sends 1.5 ETH; the limit is 1 ETH per transaction"]);
    expect(explainBreach(nativeLimit, { ...call, value: parseEther("0.5") })).toEqual([]);
  });

  it("explains a token limit from a transfer() call", () => {
    const limit = policy("transaction_limit_token_denominated", { limits: [{ address: USDC, amount: "100" }] });
    const call = { chainId: ARBITRUM, to: USDC, value: 0n, data: transfer(STRANGER, 250n) };
    expect(explainBreach(limit, call)).toEqual([`transfers 250 base units of USDC (${USDC}); the limit is 100 per transaction`]);
  });

  it("names the failing contract restriction and the offending argument", () => {
    const cap = policy("contract_param_restriction", {
      restrictions: [{ contractAddress: USDC, functionSignature: "approve(address,uint256)", paramIndex: 1, operator: "lte", value: "100" }],
    });
    const call = { chainId: ARBITRUM, to: USDC, value: 0n, data: approve(LIFI, 250n) };
    expect(explainBreach(cap, call)).toEqual([
      `approve(address,uint256) on USDC (${USDC}): amount (arg 1) must be ≤ 100; this call has 250`,
    ]);
    expect(explainBreach(cap, { ...call, data: approve(LIFI, 100n) })).toEqual([]);
  });

  it("lists addresses missing from a whitelist, or present on a blocklist", () => {
    const call = { chainId: ARBITRUM, to: USDC, value: 0n, data: transfer(STRANGER, 1n) };
    const whitelist = policy("allowed_recipients", { recipients: [{ address: USDC }] });
    expect(explainBreach(whitelist, call)).toEqual([`${STRANGER} isn't on the whitelist`]);
    const blocklist = policy("denied_recipients", { recipients: [{ address: STRANGER.toLowerCase() }] });
    expect(explainBreach(blocklist, call)).toEqual([`${STRANGER} is on the blocklist`]);
  });

  it("explains a denied proposer", () => {
    const denied = policy("denied_proposers", { recipients: [{ address: SIGNER }] });
    const call = { chainId: ARBITRUM, to: LIFI, value: 0n, data: "0x" };
    const resolveLabel = (address: string) => (address === SIGNER ? "you" : undefined);
    expect(explainBreach(denied, call, { proposer: SIGNER, resolveLabel })).toEqual([
      `you (${SIGNER}) may not propose transactions from this account`,
    ]);
    expect(explainBreach(denied, call, { proposer: STRANGER })).toEqual([]);
  });
});

describe("explainNotEvaluated", () => {
  it("points a token limit that doesn't apply at approve() caps", () => {
    const limit = policy("transaction_limit_token_denominated", { limits: [{ address: USDC, amount: "100" }] });
    expect(explainNotEvaluated(limit, "swap")).toMatch(/approve\(\)/);
  });

  it("says when a policy constrains nothing, or matches no call", () => {
    expect(explainNotEvaluated(policy("allowed_recipients", { recipients: [] }), "swap")).toMatch(/no entries/);
    const restriction = policy("contract_param_restriction", {
      restrictions: [{ contractAddress: USDC, functionSignature: "approve(address,uint256)", paramIndex: 0, operator: "eq", value: LIFI }],
    });
    expect(explainNotEvaluated(restriction, "bridge")).toBe("none of its restrictions match the calls this bridge makes");
  });
});

describe("describePolicy", () => {
  it("names tokens and the native asset, and flags a frozen asset", () => {
    const limits = policy("transaction_limit_token_denominated", {
      limits: [
        { address: NATIVE_ADDRESS, amount: parseEther("0.5").toString() },
        { address: USDC, amount: "0" },
      ],
    });
    expect(describePolicy(limits).split("\n")).toEqual([
      "Per-transaction limit  •  Arbitrum One (42161)",
      "  0.5 ETH per transaction (raw 500000000000000000)",
      `  0 base units of USDC (${USDC}) per transaction — frozen: any transfer of it is blocked`,
    ]);
  });

  it("describes restrictions by argument name, labelling known contracts", () => {
    const restriction = policy("contract_param_restriction", {
      restrictions: [{ contractAddress: USDC, functionSignature: "approve(address,uint256)", paramIndex: 0, operator: "eq", value: LIFI }],
    });
    expect(describePolicy(restriction).split("\n")[1]).toBe(
      `  approve(address,uint256) on USDC (${USDC}): spender (arg 0) = LI.FI Diamond (${LIFI})`,
    );
  });

  it("lists nominated approvers, marked as not enforced", () => {
    const approvers = policy("nominated_approvers", { approvers: [{ address: SIGNER }] }, "*");
    expect(describePolicy(approvers).split("\n")).toEqual([
      "Nominated approvers  •  all chains  (not enforced by Salt yet)",
      `  ${SIGNER}`,
    ]);
  });
});

describe("knownAddressLabel", () => {
  it("scopes token lookups to the given chain, or searches every chain for *", () => {
    expect(knownAddressLabel(USDC, ARBITRUM)).toBe("USDC");
    expect(knownAddressLabel(USDC, "1")).toBeUndefined();
    expect(knownAddressLabel(USDC.toLowerCase())).toBe("USDC");
    expect(knownAddressLabel(LIFI, "1")).toBe("LI.FI Diamond");
  });
});
