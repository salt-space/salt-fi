import { describe, expect, it } from "vitest";
import { describeConfiguration } from "../src/commands/accounts.js";

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
