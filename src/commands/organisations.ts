import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { reportError } from "../errors.js";
import { ACCESS_LEVEL_LABEL, pickOrganisation, select } from "../prompts.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const ACCESS_ROLE_BY_LEVEL: Record<number, "owner" | "member" | "agent"> = {
  1: "owner",
  2: "member",
  3: "agent",
};

const ACCESS_LEVEL_OPTIONS = [
  { value: "owner" as const, label: "Owner", hint: "full control, including membership" },
  { value: "member" as const, label: "Member", hint: "default" },
  { value: "agent" as const, label: "Agent" },
];

export async function listOrganisations(salt: Salt, selfAddress: string): Promise<void> {
  const s = p.spinner();
  s.start("Fetching organisations");

  try {
    const organisations = await salt.getOrganisations();
    s.stop(`Found ${organisations.length} organisation(s)`);

    if (organisations.length === 0) {
      p.log.info("You're not a member of any organisations yet.");
      return;
    }

    for (const org of organisations) {
      const self = org.members.find((m) => m.address.toLowerCase() === selfAddress.toLowerCase());
      const role = self ? (ACCESS_LEVEL_LABEL[self.accessLevel] ?? String(self.accessLevel)) : "unknown";
      p.log.message(`${org.name}  (${org._id})\n  your role: ${role}  •  collaborators: ${org.members.length}`);
    }
  } catch (err) {
    s.stop("Failed to fetch organisations");
    reportError(err);
  }
}

export async function inviteMemberFlow(salt: Salt): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Invite a member to which organisation?");
  if (!organisationId) return;

  const address = await p.text({
    message: "Invitee's EVM address",
    placeholder: "0x1234567890123456789012345678901234567890",
    validate: (value) => (!value || !ADDRESS_PATTERN.test(value) ? "Enter a valid 0x-prefixed address" : undefined),
  });
  if (p.isCancel(address)) return;

  const name = await p.text({
    message: "Invitee's display name (optional)",
    defaultValue: "",
  });
  if (p.isCancel(name)) return;

  const role = await p.text({
    message: "Invitee's role label",
    placeholder: "e.g. CFO, Signer",
    validate: (value) => (!value || value.trim().length === 0 ? "Role is required" : undefined),
  });
  if (p.isCancel(role)) return;

  const accessLevel = await select({
    message: "Access level",
    initialValue: "member" as const,
    options: ACCESS_LEVEL_OPTIONS,
  });
  if (p.isCancel(accessLevel)) return;

  const confirmed = await p.confirm({
    message: `Invite ${address} as "${role}" (${accessLevel}) to this organisation?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Sending invitation");
  try {
    await salt.inviteMember(organisationId, { address, name, role, accessLevel });
    s.stop("Invitation sent");
  } catch (err) {
    s.stop("Failed to send invitation");
    reportError(err);
  }
}

export async function manageCollaboratorsFlow(salt: Salt): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Manage collaborators in which organisation?");
  if (!organisationId) return;

  let organisation;
  try {
    ({ organisation } = await salt.getOrganisationById(organisationId));
  } catch (err) {
    reportError(err);
    return;
  }

  if (organisation.members.length === 0) {
    p.log.info("No collaborators in this organisation yet.");
    return;
  }

  const memberAddress = await select({
    message: "Edit which collaborator?",
    options: organisation.members.map((member) => ({
      value: member.address,
      label: member.name || member.address,
      hint: `${ACCESS_LEVEL_LABEL[member.accessLevel] ?? member.accessLevel} · ${member.role} · ${member.status}`,
    })),
  });
  if (p.isCancel(memberAddress)) return;

  const member = organisation.members.find((m) => m.address === memberAddress)!;

  const name = await p.text({
    message: "Display name",
    initialValue: member.name,
    validate: (value) => (!value || value.trim().length === 0 ? "Name is required" : undefined),
  });
  if (p.isCancel(name)) return;

  const role = await p.text({
    message: "Role label",
    initialValue: member.role,
    validate: (value) => (!value || value.trim().length === 0 ? "Role is required" : undefined),
  });
  if (p.isCancel(role)) return;

  const accessLevel = await select({
    message: "Access level",
    initialValue: ACCESS_ROLE_BY_LEVEL[member.accessLevel] ?? "member",
    options: ACCESS_LEVEL_OPTIONS,
  });
  if (p.isCancel(accessLevel)) return;

  const confirmed = await p.confirm({
    message: `Update ${member.address} to name "${name}", role "${role}", access level "${accessLevel}"?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start("Updating collaborator");
  try {
    await salt.updateMember(organisationId, memberAddress, { name, role, accessLevel });
    s.stop("Collaborator updated");
  } catch (err) {
    s.stop("Failed to update collaborator");
    reportError(err);
  }
}
