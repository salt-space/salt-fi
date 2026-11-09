import { describe, expect, it } from "vitest";
import { ownStatus } from "../src/prompts.js";

describe("ownStatus", () => {
  const org = {
    collaborators: [
      { address: "0x00000000000000000000000000000000000000AB", status: "Suspended" as const },
      { address: "0x00000000000000000000000000000000000000cd", status: "Active" as const },
    ],
  } as Parameters<typeof ownStatus>[0];

  it("finds your status, whatever the address's case", () => {
    expect(ownStatus(org, "0x00000000000000000000000000000000000000ab")).toBe("Suspended");
    expect(ownStatus(org, "0x00000000000000000000000000000000000000CD")).toBe("Active");
  });

  it("is undefined when you aren't listed or nobody is signed in", () => {
    expect(ownStatus(org, "0x0000000000000000000000000000000000000001")).toBeUndefined();
    expect(ownStatus(org, undefined)).toBeUndefined();
  });
});
