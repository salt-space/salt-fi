// index.ts imports this before `dotenv/config`. A profile named on the command
// line (`npm run dev b`) points DOTENV_CONFIG_PATH at `.env.b`, which every
// `dotenv/config` import then loads instead of `.env`.
import fs from "node:fs";
import { resolveProfile } from "./profile.js";

const arg = process.argv[2];
// dotenv reads its own `dotenv_config_*=` options from argv; leave those, and flags, alone.
if (arg !== undefined && !arg.includes("=") && !arg.startsWith("-")) {
  const profile = resolveProfile(arg, fs.readdirSync(process.cwd()));
  if ("problem" in profile) {
    console.error(profile.problem);
    process.exit(1);
  }
  process.env.DOTENV_CONFIG_PATH = profile.file;
}
