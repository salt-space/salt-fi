import { beforeAll, describe, expect, it } from "vitest";
import { authedSalt, DOMAIN, hasOwnerKey, testKey, type SaltContext } from "./harness.js";

// The whole suite self-skips when no test identity is configured, so `npm test`
// is green on a machine without testnet credentials.
describe.skipIf(!hasOwnerKey())("integration · auth (testnet)", () => {
  let ctx: SaltContext;

  beforeAll(async () => {
    ctx = await authedSalt(testKey("PRIVATE_KEY")!);
  });

  it(`authenticates against ${DOMAIN} and recovers the user public key`, () => {
    // userPublicKey is only populated by a completed SIWE authenticate(), and
    // comes back as a raw uncompressed secp256k1 key in hex — NO `0x` prefix
    // (e.g. "04ec…"). Callers that need it (generateSetupScript, activation)
    // consume it verbatim, so lock the actual shape in.
    expect(ctx.salt.userPublicKey).toMatch(/^(0x)?[0-9a-fA-F]{64,}$/);
  });

  it("lists organisations for the authenticated identity", async () => {
    const orgs = await ctx.salt.getOrganisations();
    expect(Array.isArray(orgs)).toBe(true);
    // Every org this identity can see carries a stable id + name.
    for (const org of orgs) {
      expect(org).toHaveProperty("name");
    }
  });
});
