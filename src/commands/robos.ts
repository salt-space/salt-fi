import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { reportError } from "../errors.js";
import { pickOrganisation } from "../prompts.js";

/** `preselectedOrganisationId` skips the org picker — used by the getting-started wizard, which already knows the org. */
export async function checkRoboStatusFlow(salt: Salt, preselectedOrganisationId?: string): Promise<void> {
  const organisationId = preselectedOrganisationId ?? (await pickOrganisation(salt, "Check robo status for which organisation?"));
  if (!organisationId) return;

  const s = p.spinner();
  s.start("Checking robo guardian status");
  try {
    const status = await salt.getRoboStatus({ organisationId });
    s.stop(status.isReachable ? "At least one robo guardian is online" : "No robo guardians are online");

    if (status.signers.length === 0) {
      p.log.info("No robo guardians are registered for this organisation.");
      return;
    }

    const lines = status.signers.map((signer) => `  ${signer.isOnline ? "✓ online " : "✗ offline"}  ${signer.address}`);
    p.log.message(`${status.onlineCount}/${status.signers.length} robo guardian(s) online:\n${lines.join("\n")}`);
  } catch (err) {
    s.stop("Failed to check robo status");
    reportError(err);
  }
}
