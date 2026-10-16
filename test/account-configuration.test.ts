import { describe, expect, it } from "vitest";
import { accountNameProblem, describeConfiguration } from "../src/commands/accounts.js";

describe("describeConfiguration", () => {
  it.each([
    [2, "+ 1 Robo Guardian: 2 of 3 must sign"],
    [3, "+ 2 Robo Guardians: 3 of 5 must sign"],
    [4, "+ 3 Robo Guardians: 4 of 7 must sign"],
  ])("describes %i human signers", (humans, description) => {
    expect(describeConfiguration(humans)).toBe(description);
  });

  it("flags an unsupported number of humans", () => {
    expect(describeConfiguration(1)).toMatch(/isn't a supported configuration/);
    expect(describeConfiguration(5)).toMatch(/isn't a supported configuration/);
  });
});

describe("accountNameProblem", () => {
  it.each(["Treasury", "  Fee Revenue  ", "Café Œuvre", "a".repeat(50), "🧂".repeat(50)])("accepts %j", (name) => {
    expect(accountNameProblem(name)).toBeUndefined();
  });

  it("requires a name", () => {
    expect(accountNameProblem(undefined)).toBe("Name is required");
    expect(accountNameProblem("   ")).toBe("Name is required");
  });

  it("rejects angle brackets", () => {
    expect(accountNameProblem("<b>Treasury</b>")).toMatch(/angle brackets/);
  });

  it("counts characters, not UTF-16 units, against the 50 limit", () => {
    expect(accountNameProblem("a".repeat(51))).toBe("That's 51 characters; the limit is 50");
    expect(accountNameProblem("🧂".repeat(51))).toBe("That's 51 characters; the limit is 50");
  });
});
