import fs from "node:fs";
import * as p from "@clack/prompts";
import type { LocalAccount } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { network } from "../env.js";
import { select } from "../prompts.js";
import {
  agentAddress,
  createAgent,
  createOwner,
  deskPaths,
  listDesks,
  ownerAddress,
  passphraseProblem,
  restoreOwner,
  unlockOwner,
} from "./keystore.js";
import { readDeskState, writeDeskState } from "./state.js";

/**
 * Signing in without a key in .env: as the owner of a trading desk set up on this machine, by
 * setting one up, or by restoring one from its recovery phrase. The owner's passphrase and the
 * recovery phrase are typed and read by the person who owns the desk, in this terminal. The app
 * never stores the passphrase, and shows the recovery phrase on the terminal's alternate screen,
 * so it doesn't stay in the scrollback.
 */

export interface DeskIdentity {
  desk: string;
  account: LocalAccount;
  isNew: boolean;
}

const NEVER_SHARE =
  "Type it yourself. Never give it, or your recovery phrase, to anyone, including an AI assistant helping you: " +
  "with them, someone could act as you and get around the limits you set on your trading agent.";

export async function chooseDeskIdentity(): Promise<DeskIdentity | undefined> {
  if (!process.stdin.isTTY) {
    p.log.error(
      "There's no PRIVATE_KEY in .env, and no terminal to set up or unlock a trading desk in. " +
        "Run salt-fi in a terminal (npm run dev), or add PRIVATE_KEY to .env.",
    );
    return undefined;
  }
  const desks = listDesks();
  const choice = await select({
    message: "There's no signing key in .env (PRIVATE_KEY). How do you want to sign in?",
    options: [
      ...desks.map((d) => ({ value: `desk:${d}`, label: `Trading desk "${d}"`, hint: `owner ${ownerAddress(d)}` })),
      { value: "new", label: "Set up my trading desk", hint: "creates your keys on this machine; no wallet needed" },
      { value: "restore", label: "Restore a trading desk", hint: "from its 12-word recovery phrase" },
      { value: "exit", label: "Exit", hint: "to use your own key, put it in .env as PRIVATE_KEY" },
    ],
  });
  if (p.isCancel(choice) || choice === "exit") return undefined;
  if (choice === "new") return newDesk();
  if (choice === "restore") return restoreDesk();
  return unlockDesk(choice.slice("desk:".length));
}

async function unlockDesk(desk: string): Promise<DeskIdentity | undefined> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const passphrase = await p.password({ message: `Passphrase for trading desk "${desk}"` });
    if (p.isCancel(passphrase)) return undefined;
    const s = p.spinner();
    s.start("Unlocking your owner key");
    try {
      const account = unlockOwner(desk, passphrase);
      s.stop(`Unlocked: you're the owner of "${desk}" (${account.address})`);
      return { desk, account, isNew: false };
    } catch (err) {
      s.stop(err instanceof Error ? err.message : String(err));
    }
  }
  p.log.warn("Three wrong passphrases. If you've forgotten it, choose Restore a trading desk and use your recovery phrase.");
  return undefined;
}

async function askName(): Promise<string | undefined> {
  const name = await p.text({
    message: "Name your trading desk",
    placeholder: "my-desk",
    defaultValue: "my-desk",
    validate: (v) => {
      const n = (v || "my-desk").trim();
      try {
        if (fs.existsSync(deskPaths(n).owner)) return `There's already a desk called "${n}" on this machine.`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return undefined;
    },
  });
  return p.isCancel(name) ? undefined : (name || "my-desk").trim();
}

async function askNewPassphrase(): Promise<string | undefined> {
  p.log.message(`Choose a passphrase to protect your owner key. ${NEVER_SHARE}`);
  while (true) {
    const first = await p.password({ message: "New passphrase (at least 10 characters; a short sentence works well)", validate: passphraseProblem });
    if (p.isCancel(first)) return undefined;
    const again = await p.password({ message: "Type it again" });
    if (p.isCancel(again)) return undefined;
    if (again === first) return first;
    p.log.warn("Those didn't match. Try again.");
  }
}

/** Show the recovery phrase on the alternate screen (so it isn't left in the scrollback), then check it was written down. */
async function showRecoveryPhrase(mnemonic: string): Promise<boolean> {
  const words = mnemonic.split(" ");
  const grid = [0, 1, 2, 3].map((row) => [0, 4, 8].map((col) => `${String(row + col + 1).padStart(2)}. ${words[row + col].padEnd(10)}`).join("   ")).join("\n");
  while (true) {
    process.stdout.write("\x1b[?1049h\x1b[H"); // alternate screen
    process.stdout.write(
      [
        "YOUR RECOVERY PHRASE",
        "",
        "Write these 12 words on paper, in order. They're the only way back into your desk if this",
        "machine is lost or you forget your passphrase. Don't photograph them, paste them anywhere, or",
        "give them to anyone, including an AI assistant.",
        "",
        grid,
        "",
        "Press Enter when you've written them down.",
      ].join("\n"),
    );
    await new Promise<void>((resolve) => {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      const onData = (b: Buffer) => {
        if (b.includes(13) || b.includes(10)) {
          process.stdin.off("data", onData);
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          resolve();
        }
      };
      process.stdin.on("data", onData);
    });
    process.stdout.write("\x1b[?1049l"); // back to the normal screen; the words aren't in its scrollback

    const [a, b] = [2, 8].map((i) => i + Math.floor(Math.random() * 2)); // two of words 3-4 and 9-10
    const first = await p.text({ message: `To check you wrote them down: what's word ${a + 1}?` });
    if (p.isCancel(first)) return false;
    const second = await p.text({ message: `And word ${b + 1}?` });
    if (p.isCancel(second)) return false;
    if (first.trim().toLowerCase() === words[a] && second.trim().toLowerCase() === words[b]) return true;
    p.log.warn("That doesn't match. Here they are again.");
  }
}

async function newDesk(): Promise<DeskIdentity | undefined> {
  p.note(
    [
      "Your trading desk uses two keys, both created on this machine:",
      "",
      "  Your owner key (you): creates the organisation, approves the Robo Guardians and every",
      "  policy, and switches the trading agent on or off. Protected by a passphrase you choose.",
      "",
      "  The trading agent's key: can only propose trades, inside the policies you approve.",
      "  The Robo Guardians co-sign a trade only if it passes those policies.",
    ].join("\n"),
    "Set up my trading desk",
  );
  const desk = await askName();
  if (!desk) return undefined;
  const passphrase = await askNewPassphrase();
  if (!passphrase) return undefined;

  const s = p.spinner();
  s.start("Creating your keys");
  const { address, mnemonic } = createOwner(desk, passphrase);
  const agent = createAgent(desk);
  writeDeskState(desk, { desk, saltEnv: network.saltEnv, owner: address, agent, createdAt: new Date().toISOString(), steps: {} });
  s.stop(`Created desk "${desk}": your owner address is ${address}; the trading agent's is ${agent}`);

  if (!(await showRecoveryPhrase(mnemonic))) {
    p.log.warn(`Your keys are saved, but you didn't confirm the recovery phrase. Choose Restore later only if you have it. Keys: ${deskPaths(desk).dir}`);
  }
  return { desk, account: mnemonicToAccount(mnemonic), isNew: true };
}

async function restoreDesk(): Promise<DeskIdentity | undefined> {
  const desk = await askName();
  if (!desk) return undefined;
  const phrase = await p.password({
    message: "Your 12-word recovery phrase, words separated by spaces (hidden as you type)",
    validate: (v) => ((v ?? "").trim().split(/\s+/).length === 12 ? undefined : "That isn't 12 words."),
  });
  if (p.isCancel(phrase)) return undefined;
  const passphrase = await askNewPassphrase();
  if (!passphrase) return undefined;
  let address: `0x${string}`;
  try {
    address = restoreOwner(desk, phrase, passphrase);
  } catch (err) {
    p.log.error(`Couldn't restore from that phrase: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const agent = agentAddress(desk) ?? createAgent(desk);
  if (!readDeskState(desk)) writeDeskState(desk, { desk, saltEnv: network.saltEnv, owner: address, agent, createdAt: new Date().toISOString(), steps: {} });
  p.log.success(`Restored desk "${desk}": owner ${address}. A new trading agent key was created on this machine (${agent}).`);
  return { desk, account: unlockOwner(desk, passphrase), isNew: false };
}
