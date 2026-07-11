import * as p from "@clack/prompts";
import type { Salt } from "@kagamidigital/salt-sdk-mirror";
import { reportError } from "../errors.js";

const ACCESS_LEVEL_LABEL: Record<number, string> = {
  1: "owner",
  2: "member",
  3: "agent",
  4: "member (no permissions)",
};

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
      p.log.message(`${org.name}  (${org._id})\n  your role: ${role}  •  members: ${org.members.length}`);
    }
  } catch (err) {
    s.stop("Failed to fetch organisations");
    reportError(err);
  }
}
