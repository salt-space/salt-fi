import { beforeAll, describe, expect, it } from "vitest";
import { authedSalt, canWrite, hasOwnerKey, testKey, type SaltContext } from "./harness.js";

describe.skipIf(!hasOwnerKey())("integration · organisations (testnet)", () => {
  let ctx: SaltContext;

  beforeAll(async () => {
    ctx = await authedSalt(testKey("PRIVATE_KEY")!);
  });

  // Read path — always safe to run (no state created). Pins the testnet org
  // contract as of salt-sdk 0.0.37: `id` + `collaborators` (renamed from the
  // pre-0.0.37 `_id` + `members`). Doubles as a regression guard against
  // reverting to the old names.
  it("getOrganisations returns orgs shaped { id, name, collaborators[] }", async () => {
    const orgs = await ctx.salt.getOrganisations();
    expect(Array.isArray(orgs)).toBe(true);
    for (const org of orgs) {
      expect(org.id, "org.id present (renamed from `_id` in 0.0.37)").toBeTruthy();
      expect(org.name).toBeTypeOf("string");
      expect(Array.isArray(org.collaborators), "org.collaborators is an array (renamed from `members`)").toBe(true);
    }
  });

  it("getOrganisationById returns the full org matching its list entry", async () => {
    const orgs = await ctx.salt.getOrganisations();
    if (orgs.length === 0) {
      // Nothing to fetch for this identity — the read contract above still ran.
      return;
    }
    const { organisation } = await ctx.salt.getOrganisationById(orgs[0].id);
    expect(organisation.id).toBe(orgs[0].id);
    expect(organisation.name).toBe(orgs[0].name);
    expect(Array.isArray(organisation.collaborators)).toBe(true);
    for (const c of organisation.collaborators) {
      expect(c.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(["Active", "Invited", "Declined", "Removed"]).toContain(c.status);
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
      expect(org.id).toBeTruthy();
      expect(org.name).toBe(name);
      const after = await ctx.salt.getOrganisations();
      expect(after.some((o) => o.id === org.id)).toBe(true);
    });
  });
});
