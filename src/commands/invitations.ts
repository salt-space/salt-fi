import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { reportError } from "../errors.js";
import { ACCESS_LEVEL_LABEL, select } from "../prompts.js";

export async function manageInvitations(salt: Salt): Promise<void> {
  const s = p.spinner();
  s.start("Fetching pending invitations");

  let invitations;
  try {
    ({ invitations } = await salt.getOrganisationsInvitations());
    s.stop(`Found ${invitations.length} pending invitation(s)`);
  } catch (err) {
    s.stop("Failed to fetch invitations");
    reportError(err);
    return;
  }

  if (invitations.length === 0) {
    p.log.info("No pending invitations.");
    return;
  }

  // As of salt-sdk 0.0.38 the invitation carries the organisation (id + name) and
  // the inviter (`invitedBy`) — so we can show the real org name and who invited
  // you, which an invitee validates against what the inviter told them out of band
  // (anti-phishing). Older `_id` / `organisation_id` are deprecated and removed a
  // release after 0.0.38.
  const invitationId = await select({
    message: "Select an invitation",
    options: invitations.map((inv) => ({
      value: inv.id,
      label: inv.organisation.name,
      hint: ACCESS_LEVEL_LABEL[inv.accessLevel] ?? `access level ${inv.accessLevel}`,
    })),
  });

  if (p.isCancel(invitationId)) return;
  const selected = invitations.find((inv) => inv.id === invitationId)!;

  const invitedBy = selected.invitedBy
    ? `${selected.invitedBy.name ?? "(no name set)"} — ${selected.invitedBy.address}`
    : "unknown (issued before inviter tracking)";
  p.note(
    "Before accepting, confirm these match what\n" +
      "whoever invited you told you out of band:\n\n" +
      `Organisation: ${selected.organisation.name}\n` +
      `Organisation ID: ${selected.organisation.id}\n` +
      `Invited by: ${invitedBy}\n` +
      `Your access level: ${ACCESS_LEVEL_LABEL[selected.accessLevel] ?? selected.accessLevel}`,
    "Verify this invitation",
  );

  const action = await select({
    message: "What would you like to do?",
    options: [
      { value: "accept", label: "Accept" },
      { value: "decline", label: "Decline" },
    ],
  });

  if (p.isCancel(action)) return;

  const s2 = p.spinner();
  try {
    if (action === "accept") {
      s2.start("Accepting invitation");
      await salt.acceptOrganisationInvitation(invitationId);
      s2.stop("Invitation accepted");
    } else {
      s2.start("Declining invitation");
      await salt.declineOrganisationInvitation(invitationId);
      s2.stop("Invitation declined");
    }
  } catch (err) {
    s2.stop("Action failed");
    reportError(err);
  }
}
