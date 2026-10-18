import fs from "node:fs";
import path from "node:path";
import { deskPaths } from "./keystore.js";

/**
 * A trading desk's progress, so "Set up my trading desk" can stop anywhere and pick up where it
 * left off. Kept beside the keys (~/.salt-fi/desks/<desk>/desk.json); it holds no secrets.
 */
export interface DeskState {
  desk: string;
  saltEnv: string;
  owner: `0x${string}`;
  agent: `0x${string}`;
  createdAt: string;
  /** When each setup step finished (ISO time), by step id. */
  steps: Partial<Record<DeskStep, string>>;
  organisationId?: string;
  accountId?: string;
  accountAddress?: string;
}

export type DeskStep = "funded" | "organisation" | "agent-invited" | "agent-joined" | "robos" | "robos-activated" | "account" | "policies" | "agent-enabled";

export function readDeskState(desk: string): DeskState | undefined {
  try {
    return JSON.parse(fs.readFileSync(deskPaths(desk).state, "utf8")) as DeskState;
  } catch {
    return undefined;
  }
}

export function writeDeskState(desk: string, state: DeskState): void {
  const file = deskPaths(desk).state;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Record that a step finished (and any ids it produced). */
export function markStep(desk: string, step: DeskStep, patch: Partial<DeskState> = {}): DeskState {
  const state = readDeskState(desk);
  if (!state) throw new Error(`Desk "${desk}" has no state file.`);
  const next = { ...state, ...patch, steps: { ...state.steps, [step]: new Date().toISOString() } };
  writeDeskState(desk, next);
  return next;
}
