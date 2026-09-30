import { type Policy, PolicyBreachError } from "salt-sdk";
import { describe, expect, it } from "vitest";
import { formatSaltError } from "../src/errors.js";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const base = { accountId: "account-id", organisationId: "org-id" };

describe("formatSaltError — policy breaches", () => {
  it("describes each rejected policy instead of naming it by id", () => {
    const approveCap: Policy = {
      ...base,
      id: "6824aa9c27c0fa91b32800a4",
      type: "contract_param_restriction",
      chain: "42161",
      params: { restrictions: [{ contractAddress: USDC, functionSignature: "approve(address,uint256)", paramIndex: 1, operator: "lte", value: "100" }] },
    };
    const whitelist: Policy = {
      ...base,
      id: "6824aa9c27c0fa91b32800a5",
      type: "allowed_recipients",
      chain: "*",
      params: { recipients: Array.from({ length: 8 }, (_, i) => ({ address: `0x${String(i + 1).repeat(40)}` })) },
    };

    const message = formatSaltError(new PolicyBreachError([approveCap, whitelist]));
    expect(message).toMatch(/^Blocked by account policy/);
    expect(message).toContain(`approve(address,uint256) on USDC (${USDC}): amount (arg 1) ≤ 100`);
    expect(message).toContain("Allowed recipients (whitelist)  •  all chains");
    // A long whitelist is elided rather than printed in full.
    expect(message).toContain("…and 3 more");
    expect(message).not.toContain("6824aa9c27c0fa91b32800a4");
  });
});
