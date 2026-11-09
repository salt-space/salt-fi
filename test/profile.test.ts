import { describe, expect, it } from "vitest";
import { profileNames, resolveProfile } from "../src/profile.js";

const listing = [".env", ".env.a", ".env.b", ".env.example", ".env.fee-tester", ".envrc", "package.json", "src"];

describe("profileNames", () => {
  it("lists every .env.<name> except the example template", () => {
    expect(profileNames(listing)).toEqual(["a", "b", "fee-tester"]);
  });
});

describe("resolveProfile", () => {
  it.each([
    ["a", ".env.a"],
    ["fee-tester", ".env.fee-tester"],
    [".env.b", ".env.b"],
  ])("resolves %j to %s", (arg, file) => {
    expect(resolveProfile(arg, listing)).toEqual({ file });
  });

  it("names the missing file and the profiles that do exist", () => {
    expect(resolveProfile("z", listing)).toEqual({
      problem: 'No profile "z" (looked for .env.z). Profiles here: a, b, fee-tester. To make one, copy .env.example to .env.z.',
    });
  });

  it("won't use the example template or a path outside the folder", () => {
    expect(resolveProfile("example", listing)).toHaveProperty("problem");
    expect(resolveProfile("../a", listing)).toHaveProperty("problem");
  });

  it("says when there are no profiles at all", () => {
    expect(resolveProfile("a", [".env", ".env.example"])).toHaveProperty("problem", expect.stringContaining("There are no profiles here yet."));
  });
});
