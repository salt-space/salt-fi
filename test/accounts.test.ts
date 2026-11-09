import { describe, expect, it } from "vitest";
import { accountSummary, splitBySetup } from "../src/commands/accounts.js";

const signer = "0xAAAA000000000000000000000000000000000001";
const ready = {
  id: "6a0000000123456789abcdef",
  name: "Ready",
  evmAddress: "0xBBBB000000000000000000000000000000000002",
  publicKey: "0x04ab",
  keyshares: {},
  signers: [signer],
};
/** Made up; its id's first 4 bytes are 14 Oct 2026 14:48 UTC in Unix seconds. */
const unfinished = { ...ready, id: "6acf96200123456789abcdef", name: "Unfinished", evmAddress: undefined, publicKey: undefined };

describe("splitBySetup", () => {
  it("separates accounts without an address, keeping their order", () => {
    const second = { ...ready, id: "6a0000000123456789abcde0", name: "Second" };
    expect(splitBySetup([unfinished, ready, second])).toEqual({ ready: [ready, second], unfinished: [unfinished] });
  });
});

describe("accountSummary", () => {
  it("gives a set-up account's address and no setup date", () => {
    const summary = accountSummary(ready);
    expect(summary).toContain(`address: ${ready.evmAddress}`);
    expect(summary).not.toContain("setup started");
  });

  it("says when an unfinished account's setup started", () => {
    const summary = accountSummary(unfinished);
    expect(summary).toContain("address: pending setup");
    expect(summary).toContain("backup: setup incomplete");
    expect(summary).toContain("setup started: 14 Oct 2026");
  });
});
