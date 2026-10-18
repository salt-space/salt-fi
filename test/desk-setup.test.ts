import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatEther } from "viem";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The parts of "Set up my trading desk" that don't need the network: how much ETH to ask for,
// what setup costs, and the progress file that lets setup stop and pick up again.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "salt-fi-desk-setup-test-"));
process.env.SALT_DESK_DIR = scratch;
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const fees = vi.hoisted(() => ({ realFunds: false, supports: false }));
vi.mock("../src/env.js", async (original) => {
  const mod = await original<typeof import("../src/env.js")>();
  return { ...mod, network: new Proxy(mod.network, { get: (t, k) => (k === "realFunds" ? fees.realFunds : Reflect.get(t, k)) }) };
});
vi.mock("../src/fees.js", async (original) => ({ ...(await original<object>()), supportsFees: () => fees.supports }));
vi.mock("../src/aleph/client.js", async (original) => ({ ...(await original<object>()), hourlyCredits: vi.fn(async () => 14_250) }));

const { ethToAskFor, setupBudget } = await import("../src/desk/funding.js");
const { markStep, readDeskState, writeDeskState } = await import("../src/desk/state.js");
const { hourlyCredits } = await import("../src/aleph/client.js");

describe("ethToAskFor", () => {
  it("adds a 10% margin and rounds up to 0.001 ETH", () => {
    // $20 × 1.1 = $22 at $2,000/ETH = 0.011 ETH exactly
    expect(formatEther(ethToAskFor(20, 2000))).toBe("0.011");
    // $25 × 1.1 = $27.50 at $3,000/ETH = 0.00916… → 0.01
    expect(formatEther(ethToAskFor(25, 3000))).toBe("0.01");
  });

  it("never asks for less than the budget", () => {
    for (const [usd, price] of [[13.37, 2412.5], [9.99, 4100], [60, 1800]]) {
      const eth = Number(formatEther(ethToAskFor(usd, price)));
      expect(eth * price).toBeGreaterThanOrEqual(usd * 1.1);
    }
  });
});

describe("setupBudget", () => {
  const salt = {
    getFeeTerms: async ({ for: op }: { for: string }) => ({
      accepts: op === "createAccount" ? [{ amount: "2000000" }, { amount: "1500000" }] : [{ amount: "100000" }],
    }),
  } as never;

  beforeEach(() => {
    fees.realFunds = false;
    fees.supports = false;
  });

  it("on a test network, costs the Robo Guardian's VM and gas only", async () => {
    const lines = await setupBudget(salt);
    expect(lines.map((l) => l.what)).toEqual(["Robo Guardian VM on Aleph Cloud, first month", "Gas, and converting some ETH to USDC for Salt's fees"]);
    expect(lines[0].usd).toBeCloseTo((14_250 * 24 * 30) / 1_000_000); // ≈ $10.26
  });

  it("with real funds, adds Salt's cheapest account fee and 50 trades' fees", async () => {
    fees.realFunds = true;
    fees.supports = true;
    const lines = await setupBudget(salt);
    expect(lines.find((l) => l.what.includes("create your account"))?.usd).toBe(1.5);
    expect(lines.find((l) => l.what.includes("first 50 trades"))?.usd).toBeCloseTo(5);
  });

  it("still gives a figure when Aleph's price can't be read", async () => {
    vi.mocked(hourlyCredits).mockRejectedValueOnce(new Error("offline"));
    const lines = await setupBudget(salt);
    expect(lines[0].usd).toBeGreaterThan(0);
  });
});

describe("desk state", () => {
  it("records each finished step with its ids, keeping earlier ones, in an owner-only file", () => {
    writeDeskState("progress", { desk: "progress", saltEnv: "testnet", owner: "0x1", agent: "0x2", createdAt: "2026-10-18T00:00:00Z", steps: {} } as never);
    markStep("progress", "funded");
    const after = markStep("progress", "organisation", { organisationId: "org-1" });
    expect(Object.keys(after.steps)).toEqual(["funded", "organisation"]);
    expect(readDeskState("progress")?.organisationId).toBe("org-1");
    expect(fs.statSync(path.join(scratch, "progress", "desk.json")).mode & 0o777).toBe(0o600);
  });

  it("has nothing to read for a desk that was never set up, and refuses to mark one", () => {
    expect(readDeskState("nobody")).toBeUndefined();
    expect(() => markStep("nobody", "funded")).toThrow(/no state file/);
  });
});
