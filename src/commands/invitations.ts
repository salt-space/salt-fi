import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { reportError } from "../errors.js";
import { select } from "../prompts.js";

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

  const invitationId = await select({
    message: "Select an invitation",
    options: invitations.map((inv) => ({
      value: inv._id,
      label: `Organisation ${inv.organisation_id}`,
      hint: `access level ${inv.accessLevel}`,
    })),
  });

  if (p.isCancel(invitationId)) return;

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
