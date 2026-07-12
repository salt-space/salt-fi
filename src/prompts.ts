import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { reportError } from "./errors.js";

export const ACCESS_LEVEL_LABEL: Record<number, string> = {
  1: "owner",
  2: "member",
  3: "agent",
  4: "member (no permissions)",
};

export async function pickOrganisation(salt: Salt, message: string): Promise<string | undefined> {
  let organisations;
  try {
    organisations = await salt.getOrganisations();
  } catch (err) {
    reportError(err);
    return undefined;
  }

  if (organisations.length === 0) {
    p.log.info("You're not a member of any organisations yet.");
    return undefined;
  }

  const organisationId = await p.select({
    message,
    options: organisations.map((org) => ({ value: org._id, label: org.name })),
  });

  if (p.isCancel(organisationId)) return undefined;
  return organisationId;
}

/**
 * Renders a ceremony's expected signer list with presence and a label per
 * address: "You" for the caller, the org member's name if known, else
 * "Robo guardian" (the only other kind of party these ceremonies engage).
 */
export function renderSignerList(
  signers: { address: string; isOnline: boolean }[],
  selfAddress: string,
  memberNameByAddress: Map<string, string>,
): string {
  const lines = signers.map((signer) => {
    const mark = signer.isOnline ? "✓" : "…";
    const lower = signer.address.toLowerCase();
    let label: string;
    if (lower === selfAddress.toLowerCase()) {
      label = "You";
    } else {
      const memberName = memberNameByAddress.get(lower);
      label = memberName ? memberName : "Robo guardian";
    }
    return `  ${mark} ${label} (${signer.address})`;
  });
  return lines.join("\n");
}
