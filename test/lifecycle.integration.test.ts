import { beforeAll, describe, expect, it } from "vitest";
import { authedSalt, canWrite, hasCollabKey, hasOwnerKey, testKey, type SaltContext } from "./harness.js";

/**
 * The formalized smoke test: the full onboarding lifecycle against testnet —
 * create org → invite → accept → robo host → (account creation). It creates
 * real testnet state, so it's opt-in behind `SALT_INTEGRATION_WRITE=1`; the
 * invite/account parts additionally need a second identity (`TEST_COLLAB_KEY`).
 */
describe.skipIf(!canWrite() || !hasOwnerKey())("integration · lifecycle (testnet · write)", () => {
  let owner: SaltContext;
  let orgId: string;

  beforeAll(async () => {
    owner = await authedSalt(testKey("PRIVATE_KEY")!);
  });

  it("creates an organisation (owner-only)", async () => {
    const org = await owner.salt.createOrganisation({
      name: `IT lifecycle ${Date.now()}`,
      owner: { name: "IT Owner", address: owner.address, role: "Owner" },
    });
    expect(org._id).toBeTruthy();
    orgId = org._id;
  });

  it.skipIf(!hasCollabKey())("invites a collaborator, who accepts and goes Active", async () => {
    const collab = await authedSalt(testKey("TEST_COLLAB_KEY")!);
    await owner.salt.inviteMember(orgId, {
      address: collab.address,
      name: "IT Collaborator",
      role: "Signer",
      accessLevel: "member",
    });

    const { invitations } = await collab.salt.getOrganisationsInvitations();
    const invite = invitations.find((i) => i.organisation_id === orgId);
    expect(invite, "collaborator sees the invitation").toBeTruthy();
    await collab.salt.acceptOrganisationInvitation(invite!._id);

    let active = false;
    for (let i = 0; i < 20 && !active; i++) {
      const { organisation } = await owner.salt.getOrganisationById(orgId);
      active = organisation.members.some(
        (m) => m.address.toLowerCase() === collab.address.toLowerCase() && m.status === "Active",
      );
      if (!active) await new Promise((r) => setTimeout(r, 3000));
    }
    expect(active, "collaborator reaches Active").toBe(true);
  });

  it("registers a robo host, created inactive, with a testnet-correct setup script", async () => {
    let host = await owner.salt.getRoboHost({ organisationId: orgId }).catch(() => null);
    if (!host) {
      host = await owner.salt.createRoboHost({ name: "IT Robos", organisationId: orgId, ownerAddress: owner.address });
    }
    // Hosts are created inactive — usable only after 2FA activation.
    expect(host.active).toBe(false);

    // generateSetupScript needs the owner's public key (populated by the
    // harness's authenticate()). Pin the testnet wiring — this guards against
    // the mainnet-misconfig class of bug (app.salt.space / chain 42161 / INTU).
    const script = host.generateSetupScript({ publicKey: owner.salt.userPublicKey! });
    expect(script).toContain('API_URL="https://testnet.salt.space/api"');
    expect(script).toContain("SALT_CHAIN_ID=421614");
    expect(script).not.toContain("INTU_NETWORK");
  });

  it("reports robo status shaped { active, onlineCount, signers[] }", async () => {
    const status = await owner.salt.getRoboStatus({ organisationId: orgId });
    expect(typeof status.active).toBe("boolean");
    expect(typeof status.onlineCount).toBe("number");
    expect(Array.isArray(status.signers)).toBe(true);
  });

  // Account creation is a live MPC keygen: it needs the org's robo host online +
  // ACTIVATED, and the collaborator listening to auto-join the huddle. No
  // testnet robo host is provisioned yet, so this is skipped. The verified
  // implementation of this exact flow lives in scripts/testnet-smoke.ts (Phase 5)
  // — port it here (listenToAccountNudges → createAccount → ceremony.wait) once a
  // testnet robo host exists, gated on `getRoboStatus().active && onlineCount>0`.
  it.skip("creates a shared MPC account (needs an online, activated testnet robo host)", () => {});
});
