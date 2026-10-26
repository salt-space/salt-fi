import { describe, expect, it } from "vitest";
import { roboSeedBackup, roboSeedBackupFilename } from "../src/commands/robos.js";

describe("roboSeedBackup", () => {
  const savedAt = new Date(Date.UTC(2026, 9, 26, 12));
  const base = { organisationId: "org-1", roboId: "robo-1", signers: ["0xa", "0xb", "0xc"], encryptedSeed: "04abcd", savedAt };

  it("keeps the encrypted seed with whose robos it rebuilds", () => {
    expect(roboSeedBackup({ ...base, roboName: "Org Robos" })).toEqual({
      environment: "testnet",
      organisationId: "org-1",
      roboId: "robo-1",
      roboName: "Org Robos",
      signers: ["0xa", "0xb", "0xc"],
      encryptedSeed: "04abcd",
      encryption: expect.stringContaining("ECIES"),
      savedAt: "2026-10-26T12:00:00.000Z",
    });
  });

  it("records a missing robo name as null", () => {
    expect(roboSeedBackup(base).roboName).toBeNull();
  });
});

describe("roboSeedBackupFilename", () => {
  it("names the file after the organisation", () => {
    expect(roboSeedBackupFilename("6adf441312961c7a503ea3d2")).toBe("robo-seed-6adf441312961c7a503ea3d2.json");
  });
});
