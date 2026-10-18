import * as p from "@clack/prompts";
import type { Salt } from "salt-sdk";
import { styleText } from "node:util";
import { formatUnits, parseUnits } from "viem";
import { reportError } from "./errors.js";

export const ACCESS_LEVEL_LABEL: Record<number, string> = {
  1: "owner",
  2: "member",
  3: "agent",
  4: "member (no permissions)",
};

/**
 * Wraps @clack/prompts' select to consistently note that Esc cancels/steps
 * back out of it — so individual menus don't need an explicit "Back" option
 * just to communicate that. Rendered as a second, dimmed message line (clack
 * auto-prefixes every message line with its own bar glyph — see
 * wrapTextWithPrefix — so this reads like part of its own hint styling rather
 * than bolted onto the question). Pass `escAction` to describe what Esc does
 * here when it's not "go back" (e.g. the main menu, where it exits).
 */
export function select<Value>(opts: p.SelectOptions<Value> & { escAction?: string }): Promise<Value | symbol> {
  const { escAction = "go back", ...rest } = opts;
  return p.select({ ...rest, message: `${opts.message}\n${styleText("dim", `Esc: ${escAction}`)}` });
}

/**
 * Clip a live spinner message to one terminal line. Before each frame clack rubs out as
 * many lines as the message alone takes, but draws the frame (`◒  `) before it and up to
 * three dots after; if those push the line over the edge it wraps, and every frame
 * stacks up on screen. So leave room for both, plus a column spare. Final stop lines
 * aren't redrawn, so they can wrap.
 */
export function oneLine(msg: string, columns = process.stdout.columns ?? 80): string {
  const max = columns - 7;
  return msg.length > max ? `${msg.slice(0, Math.max(1, max - 1))}…` : msg;
}

/**
 * Wrap a note's text to the terminal before clack does. clack wraps a long line where it
 * falls, carrying spaces onto the next line and losing its indent. Here each line keeps
 * its indent, and the rest of a bullet (`· `) or an amount (`$10.26  `) hangs under its
 * text. Lines are 76 characters at most, so a wide terminal doesn't make them hard to read.
 */
export function fitNote(text: string, columns = process.stdout.columns ?? 80): string {
  const width = Math.max(20, Math.min(columns - 6, 76)); // clack's note box takes 6 columns
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) return [line];
      const lead = /^\s*(?:· |\$\S+\s+)?/.exec(line)?.[0] ?? "";
      const out: string[] = [];
      let current = lead;
      let empty = true;
      for (const word of line.slice(lead.length).split(/\s+/).filter(Boolean)) {
        if (!empty && current.length + 1 + word.length > width) {
          out.push(current);
          current = " ".repeat(lead.length);
          empty = true;
        }
        current += empty ? word : ` ${word}`;
        empty = false;
      }
      out.push(current);
      return out;
    })
    .join("\n");
}

/**
 * Prompt for a token amount, accepting either a number or the words `max` / `all`
 * (case-insensitive) to mean the entire available balance. Returns the amount in
 * the token's smallest unit (wei), or `null` if the user cancels.
 *
 * `maxRaw` is the exact spendable balance in wei — already gas-adjusted by the
 * caller where relevant (e.g. native sends reserve gas). `max`/`all` resolve to
 * `maxRaw` verbatim, so it's exact to the wei with no formatUnits→parseUnits
 * round-trip. `note` is appended inside the "(available: …)" hint, e.g.
 * ", after reserving estimated gas".
 */
export async function promptTokenAmount(opts: {
  verb: string;
  symbol: string;
  decimals: number;
  maxRaw: bigint;
  note?: string;
}): Promise<bigint | null> {
  const { verb, symbol, decimals, maxRaw, note = "" } = opts;
  const maxFormatted = formatUnits(maxRaw, decimals);
  const isMax = (v: string) => ["max", "all"].includes(v.trim().toLowerCase());
  const input = await p.text({
    message: `Amount of ${symbol} to ${verb} (available: ${maxFormatted}${note})`,
    placeholder: `${maxFormatted}  —  or "max"`,
    validate: (v) => {
      if (!v) return "Amount is required";
      if (isMax(v)) return undefined;
      let parsed: bigint;
      try {
        parsed = parseUnits(v, decimals);
      } catch {
        return 'Not a valid amount (or type "max")';
      }
      if (parsed <= 0n) return "Amount must be greater than 0";
      if (parsed > maxRaw) return `Exceeds available balance (${maxFormatted} ${symbol})`;
      return undefined;
    },
  });
  if (p.isCancel(input)) return null;
  return isMax(input) ? maxRaw : parseUnits(input, decimals);
}

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

  const organisationId = await select({
    message,
    options: organisations.map((org) => ({ value: org.id, label: org.name })),
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
