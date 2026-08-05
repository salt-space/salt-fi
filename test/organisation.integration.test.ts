import { beforeAll, describe, expect, it } from "vitest";
import { authedSalt, canWrite, hasOwnerKey, testKey, type SaltContext } from "./harness.js";

describe.skipIf(!hasOwnerKey())("integration · organisations (testnet)", () => {
  let ctx: SaltContext;

  beforeAll(async () => {
    ctx = await authedSalt(testKey("PRIVATE_KEY")!);
  });

  // Read path — always safe to run (no state created). Pins the testnet org
  // contract: `_id` + `members` (the staging mirror drifted these to `id` +
  // `collaborators`, so this doubles as a regression guard if that ever ships
  // to the public backend).
  it("getOrganisations returns orgs shaped { _id, name, members[] }", async () => {
    const orgs = await ctx.salt.getOrganisations();
    expect(Array.isArray(orgs)).toBe(true);
    for (const org of orgs) {
      expect(org._id, "org._id present (not `id`)").toBeTruthy();
      expect(org.name).toBeTypeOf("string");
      expect(Array.isArray(org.members), "org.members is an array (not `collaborators`)").toBe(true);
    }
  });

  it("getOrganisationById returns the full org matching its list entry", async () => {
    const orgs = await ctx.salt.getOrganisations();
    if (orgs.length === 0) {
      // Nothing to fetch for this identity — the read contract above still ran.
      return;
    }
    const { organisation } = await ctx.salt.getOrganisationById(orgs[0]._id);
    expect(organisation._id).toBe(orgs[0]._id);
    expect(organisation.name).toBe(orgs[0].name);
    expect(Array.isArray(organisation.members)).toBe(true);
    for (const m of organisation.members) {
      expect(m.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(["Active", "Invited", "Declined", "Removed"]).toContain(m.status);
    }
  });

  // Write path — creates a throwaway testnet org, so it's opt-in only.
  describe.skipIf(!canWrite())("write · createOrganisation", () => {
    it("creates an owner-only org that then appears in getOrganisations", async () => {
      const name = `IT org ${Date.now()}`;
      const org = await ctx.salt.createOrganisation({
        name,
        owner: { name: "Integration Owner", address: ctx.address, role: "Owner" },
      });
      expect(org._id).toBeTruthy();
      expect(org.name).toBe(name);
      const after = await ctx.salt.getOrganisations();
      expect(after.some((o) => o._id === org._id)).toBe(true);
    });
  });
});
