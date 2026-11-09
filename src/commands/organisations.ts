import * as p from "@clack/prompts";
import type { Collaborator, Salt } from "salt-sdk";
import { reportError } from "../errors.js";
import { ACCESS_LEVEL_LABEL, pickOrganisation, select } from "../prompts.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const ACCESS_ROLE_BY_LEVEL: Record<number, "owner" | "member" | "delegate"> = {
  1: "owner",
  2: "member",
  3: "delegate",
};

const ACCESS_LEVEL_OPTIONS = [
  { value: "owner" as const, label: "Owner", hint: "full control, including membership" },
  { value: "member" as const, label: "Member", hint: "default" },
  { value: "delegate" as const, label: "Delegate" },
];

/**
 * When an organisation was created. The SDK's Organisation has no creation date (it carries id,
 * name, collaborators, lastUpdated and termsAcceptedVersion), but Salt's organisation ids are
 * MongoDB ObjectIds, whose first 4 bytes are the creation time in Unix seconds. Undefined for an id
 * that isn't an ObjectId, or whose time is implausible (before 2020 or in the future).
 */
export function createdAtFromId(id: string): Date | undefined {
  if (!/^[0-9a-f]{24}$/i.test(id)) return undefined;
  const ms = Number.parseInt(id.slice(0, 8), 16) * 1000;
  if (ms < Date.UTC(2020, 0, 1) || ms > Date.now() + 86_400_000) return undefined;
  return new Date(ms);
}

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
      const self = org.collaborators.find((m) => m.address.toLowerCase() === selfAddress.toLowerCase());
      const role = self ? (ACCESS_LEVEL_LABEL[self.accessLevel] ?? String(self.accessLevel)) : "unknown";
      const created = createdAtFromId(org.id);
      const when = created ? `  •  created ${created.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "";
      p.log.message(`${org.name}  (${org.id})\n  your role: ${role}  •  collaborators: ${org.collaborators.length}${when}`);
    }
  } catch (err) {
    s.stop("Failed to fetch organisations");
    reportError(err);
  }
}

/**
 * `preselectedOrganisationId` skips the org picker — used by the getting-started
 * wizard, which already knows the org. Returns `true` if an invitation was
 * actually sent, `false` if the user cancelled/declined; the wizard uses this to
 * exit rather than waiting for an acceptance that will never come.
 */
export async function inviteMemberFlow(salt: Salt, preselectedOrganisationId?: string): Promise<boolean> {
  const organisationId = preselectedOrganisationId ?? (await pickOrganisation(salt, "Invite a member to which organisation?"));
  if (!organisationId) return false;

  const address = await p.text({
    message: "Invitee's EVM address",
    placeholder: "0x1234567890123456789012345678901234567890",
    validate: (value) => (!value || !ADDRESS_PATTERN.test(value) ? "Enter a valid 0x-prefixed address" : undefined),
  });
  if (p.isCancel(address)) return false;

  const name = await p.text({
    message: "Invitee's display name (optional)",
    defaultValue: "",
  });
  if (p.isCancel(name)) return false;

  const role = await p.text({
    message: "Invitee's role label",
    placeholder: "e.g. CFO, Signer",
    validate: (value) => (!value || value.trim().length === 0 ? "Role is required" : undefined),
  });
  if (p.isCancel(role)) return false;

  const accessLevel = await select({
    message: "Access level",
    initialValue: "member" as const,
    options: ACCESS_LEVEL_OPTIONS,
  });
  if (p.isCancel(accessLevel)) return false;

  const confirmed = await p.confirm({
    message: `Invite ${address} as "${role}" (${accessLevel}) to this organisation?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return false;

  const s = p.spinner();
  s.start("Sending invitation");
  try {
    await salt.inviteCollaborator(organisationId, { address, name, role, accessLevel });
    s.stop("Invitation sent");
    return true;
  } catch (err) {
    s.stop("Failed to send invitation");
    reportError(err);
    return false;
  }
}

/**
 * Why suspending `address` would be refused, if it would. The Salt API keeps every organisation
 * with at least one active owner, so the last one can't be suspended.
 */
export function suspendProblem(collaborators: readonly Pick<Collaborator, "address" | "accessLevel" | "status">[], address: string): string | undefined {
  const target = address.toLowerCase();
  const member = collaborators.find((m) => m.address.toLowerCase() === target);
  if (member?.accessLevel !== 1) return undefined;
  const otherActiveOwners = collaborators.filter((m) => m.accessLevel === 1 && m.status === "Active" && m.address.toLowerCase() !== target);
  return otherActiveOwners.length === 0 ? "they're the organisation's only active owner, and it must keep one" : undefined;
}

/**
 * Suspend an active collaborator or restore a suspended one (`updateCollaborator` with a
 * `status`), then read them back to confirm. Suspended collaborators keep their access level
 * but can't act until restored; unlike removing someone, it needs no fresh invitation to undo.
 */
async function setCollaboratorStatus(
  salt: Salt,
  organisationId: string,
  collaborators: readonly Collaborator[],
  member: Collaborator,
  status: "Suspended" | "Active",
  selfAddress: string,
): Promise<void> {
  const suspending = status === "Suspended";
  const who = member.name ? `"${member.name}" (${member.address})` : member.address;
  if (suspending) {
    const problem = suspendProblem(collaborators, member.address);
    if (problem) {
      p.log.warn(`Can't suspend ${who}: ${problem}.`);
      return;
    }
  }
  const isSelf = member.address.toLowerCase() === selfAddress.toLowerCase();

  const go = await p.confirm({
    message: suspending
      ? `Suspend ${who}?${isSelf ? " That's you: you won't be able to act here until another owner restores you." : ""}`
      : `Restore ${who}?`,
    initialValue: !suspending,
  });
  if (p.isCancel(go) || !go) return;

  const s = p.spinner();
  s.start(suspending ? "Suspending" : "Restoring");
  try {
    await salt.updateCollaborator(organisationId, member.address, { status });
  } catch (err) {
    s.stop(suspending ? "Failed to suspend" : "Failed to restore");
    reportError(err);
    return;
  }
  // Read back separately: a self-suspended owner may no longer be allowed to read the organisation.
  try {
    const { organisation } = await salt.getOrganisationById(organisationId);
    const now = organisation.collaborators.find((m) => m.address.toLowerCase() === member.address.toLowerCase())?.status;
    s.stop(now === status ? `${suspending ? "Suspended" : "Restored"} ${who}` : `Sent, but ${who} still reads as ${now ?? "not found"}`);
  } catch {
    s.stop(`Sent; couldn't read ${who} back to check`);
  }
}

export async function manageCollaboratorsFlow(salt: Salt, selfAddress: string): Promise<void> {
  const organisationId = await pickOrganisation(salt, "Manage collaborators in which organisation?");
  if (!organisationId) return;

  let organisation;
  try {
    ({ organisation } = await salt.getOrganisationById(organisationId));
  } catch (err) {
    reportError(err);
    return;
  }

  if (organisation.collaborators.length === 0) {
    p.log.info("No collaborators in this organisation yet.");
    return;
  }

  const memberAddress = await select({
    message: "Edit which collaborator?",
    options: organisation.collaborators.map((member) => ({
      value: member.address,
      label: member.name || member.address,
      hint: `${ACCESS_LEVEL_LABEL[member.accessLevel] ?? member.accessLevel} · ${member.role} · ${member.status}`,
    })),
  });
  if (p.isCancel(memberAddress)) return;

  const member = organisation.collaborators.find((m) => m.address === memberAddress)!;

  // Only Active and Suspended move between each other; anyone else goes straight to editing.
  if (member.status === "Active" || member.status === "Suspended") {
    const action = await select({
      message: `What do you want to do with ${member.name || member.address}?`,
      options: [
        { value: "edit" as const, label: "Edit details", hint: "name, role, access level" },
        member.status === "Active"
          ? { value: "suspend" as const, label: "Suspend", hint: "keeps their access level, but they can't act until restored" }
          : { value: "restore" as const, label: "Restore", hint: "suspended now; make them active again" },
      ],
    });
    if (p.isCancel(action)) return;
    if (action !== "edit") {
      await setCollaboratorStatus(salt, organisationId, organisation.collaborators, member, action === "suspend" ? "Suspended" : "Active", selfAddress);
      return;
    }
  }

  const name = await p.text({
    message: "Display name",
    initialValue: member.name ?? undefined,
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
    await salt.updateCollaborator(organisationId, memberAddress, { name, role, accessLevel });
    s.stop("Collaborator updated");
  } catch (err) {
    s.stop("Failed to update collaborator");
    reportError(err);
  }
}
