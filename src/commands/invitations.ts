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

  // The invitation payload only carries organisation_id + accessLevel, and Salt
  // gives an invitee no read access to the organisation (its name, members, or
  // owners) until they accept — getOrganisationById 403s and getOrganisations
  // omits it. So the org ID + access level is all we can show; the invitee
  // validates by confirming those against what the inviter told them out of band.
  const invitationId = await select({
    message: "Select an invitation",
    options: invitations.map((inv) => ({
      value: inv._id,
      label: `Organisation ${inv.organisation_id}`,
      hint: ACCESS_LEVEL_LABEL[inv.accessLevel] ?? `access level ${inv.accessLevel}`,
    })),
  });

  if (p.isCancel(invitationId)) return;
  const selected = invitations.find((inv) => inv._id === invitationId)!;

  p.note(
    "The organisation's name and owner aren't\n" +
      "shown until you accept (a Salt limitation).\n" +
      "Before accepting, confirm with whoever\n" +
      "invited you that these match what they sent:\n\n" +
      "Organisation ID:\n" +
      `${selected.organisation_id}\n\n` +
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
