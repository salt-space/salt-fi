import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { parseEther, parseUnits } from "viem";
import type { Salt } from "salt-sdk";
import {
  type AlephVmRecord,
  type AlephWallet,
  alephWallet,
  allocatedNode,
  computeNode,
  computeNodes,
  CREDITS_PER_USD,
  createInstance,
  creditBalance,
  DEFAULT_NODE_HASH,
  debian12Image,
  deleteInstance,
  dropVmRecord,
  forwardSsh,
  hourlyCredits,
  type NodeCapacity,
  type NodeChoice,
  nodeCapacity,
  rankNodeChoices,
  readVmRecords,
  saveVmRecord,
  signerAlephWallet,
  SIZE,
  SSH_USER,
  startInstance,
  vmAddress,
  waitProcessed,
  walletOwning,
} from "../aleph/client.js";
import { CREDIT_CONTRACT, checkCreditContract, creditsFor, estimatePaymentGas, payerFunds, payForCredits } from "../aleph/credits.js";
import { canReach, scpTo, type SshTarget, sshInteractive, sshRun } from "../aleph/ssh.js";
import { deriveSshKey, type SshKeyPair } from "../aleph/ssh-key.js";
import { explorerTxUrl } from "../chains.js";
import { env, network } from "../env.js";
import { formatSaltError, reportError } from "../errors.js";
import { getTokenPriceUsd, LIFI_NATIVE_TOKEN } from "../lifi.js";
import { oneLine, select } from "../prompts.js";
import type { SaltWalletClient } from "../wallet.js";
import { activateRoboFlow } from "./robos.js";

/**
 * Robo Guardians → Set up → "Aleph Cloud VM (experimental)": host this organisation's robo on a
 * pay-as-you-go Aleph Cloud VM, end to end (see src/aleph/client.ts and docs/robo-hosting/aleph.md).
 *
 *   check   the Aleph wallet's credits cover at least a day; show the cost; confirm (default No)
 *   create  pinned to one compute node, Debian 12, the SSH key derived from the Aleph wallet
 *   reach   forward SSH, start the VM, wait for its address, check this network can reach it
 *   run     copy the setup script over, run it as root, remove it (it holds the one-time OTP)
 *   finish  wait for the robo to connect to Salt, then offer 2FA activation
 *
 * The VM is recorded in .aleph-vms.json the moment it exists, so "Aleph Cloud VMs" can always tear it
 * down, even if a later step fails.
 */

const MIN_RUNWAY_HOURS = 24;

/**
 * A clack spinner whose live messages are clipped to one terminal line (see `oneLine`): the setup
 * script's progress lines are long enough to wrap, and a wrapped spinner message stacks every frame.
 */
function spin() {
  const s = p.spinner();
  return {
    start: (msg: string) => s.start(oneLine(msg)),
    message: (msg: string) => s.message(oneLine(msg)),
    stop: (msg: string) => s.stop(msg),
  };
}
const usd = (credits: number) => `$${(credits / CREDITS_PER_USD).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const envFile = () => path.basename(process.env.DOTENV_CONFIG_PATH ?? ".env");

const whereToBuy = "Robo Guardians → Aleph credits, app.aleph.cloud, or Aleph's CLI (`aleph credit buy`)";

/** Why the wallet that owns a recorded VM isn't available here, and what to do about it. */
function notOwner(owner: string, todo: string): string {
  const keys =
    env.signer === "private-key"
      ? `neither ALEPH_PRIVATE_KEY nor PRIVATE_KEY in ${envFile()} is that wallet`
      : `ALEPH_PRIVATE_KEY in ${envFile()} isn't that wallet`;
  return `This VM belongs to ${owner}, and ${keys}. Run with the owner's key to ${todo}.`;
}

/**
 * The wallet that will own and pay for the VM: ALEPH_PRIVATE_KEY when set. Otherwise, if you sign with
 * a private key, your signing wallet (PRIVATE_KEY), offered with its address and credits and used only
 * if you say so. A Ledger can't be the Aleph wallet yet, so a Ledger signer needs ALEPH_PRIVATE_KEY.
 */
async function chooseWallet(): Promise<AlephWallet | undefined> {
  let dedicated: AlephWallet | undefined;
  let signer: AlephWallet | undefined;
  try {
    dedicated = alephWallet();
    signer = dedicated ? undefined : signerAlephWallet();
  } catch (err) {
    p.log.error(formatSaltError(err));
    return undefined;
  }
  if (dedicated) return dedicated;

  if (env.signer === "ledger") {
    p.log.warn(
      "Aleph Cloud needs a wallet to own the VM and pay for it, and you sign with a Ledger, which can't be the " +
        `Aleph wallet yet. Put a separate wallet's key in ${envFile()} as ALEPH_PRIVATE_KEY=0x…, then buy it credits ` +
        `(${whereToBuy}). Your Ledger still owns the organisation and activates the robo.`,
    );
    return undefined;
  }
  if (!signer) {
    p.log.warn(`Aleph Cloud needs a wallet to own the VM and pay for it. Put one's key in ${envFile()} as ALEPH_PRIVATE_KEY=0x…, and buy it credits (${whereToBuy}).`);
    return undefined;
  }

  const s = spin();
  s.start(`No ALEPH_PRIVATE_KEY in ${envFile()}: reading your signing wallet's Aleph credits`);
  const credits = await creditBalance(signer.address).catch(() => undefined);
  s.stop(`Your signing wallet ${signer.address}: ${credits === undefined ? "credits unreadable" : `${credits.toLocaleString("en-GB")} Aleph credits (${usd(credits)})`}`);
  p.log.message(
    [
      "Using your signing wallet as the Aleph wallet means:",
      "  · your signing wallet owns the VM and pays for its credits, so the credits sit on the same key you sign into Salt with",
      "  · your signing wallet also signs the Aleph messages, plus one message that derives the VM's SSH key",
      "  · only your signing wallet can manage or delete the VM later",
      `To use a separate wallet instead, set ALEPH_PRIVATE_KEY in ${envFile()} to that wallet's key.`,
    ].join("\n"),
  );
  const use = await p.confirm({ message: `Use your signing wallet ${signer.address} as the Aleph wallet?`, initialValue: true });
  if (p.isCancel(use) || !use) return undefined;
  return signer;
}

/** Poll `fn` until it returns a value, or give up after `ms`. */
async function until<T>(ms: number, every: number, fn: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await sleep(every);
  }
  return undefined;
}

export async function alephRoboFlow(
  salt: Salt,
  walletClient: SaltWalletClient,
  o: { organisationId: string; organisationName: string; scriptPath: string; roboName: string },
): Promise<boolean> {
  const w = await chooseWallet();
  if (!w) return false;

  const s = spin();
  s.start("Reading the Aleph wallet's credits, the price and the compute nodes");
  let balance: number;
  let perHour: number;
  let image: string;
  let nodes;
  try {
    [balance, perHour, image, nodes] = await Promise.all([creditBalance(w.address), hourlyCredits(), debian12Image(), computeNodes()]);
  } catch (err) {
    s.stop("Couldn't reach Aleph");
    p.log.error(formatSaltError(err));
    return false;
  }
  const runwayHours = balance / perHour;
  const which = w.source === "PRIVATE_KEY" ? "Your signing wallet" : "Aleph wallet";
  s.stop(`${which} ${w.address}: ${balance.toLocaleString("en-GB")} credits (${usd(balance)}), about ${Math.floor(runwayHours / 24)} days at ${perHour.toLocaleString("en-GB")}/hour`);

  if (runwayHours < MIN_RUNWAY_HOURS) {
    p.log.warn(`That's under ${MIN_RUNWAY_HOURS} hours of credits (a node won't even start a VM with less than one).`);
    await showFundingNeeds(w);
    const buy = await p.confirm({ message: `Buy credits for ${w.address} now?`, initialValue: true });
    if (p.isCancel(buy) || !buy || !(await buyCreditsFlow(w, perHour))) {
      p.log.info(`Nothing was created. Buy credits for ${w.address} (${whereToBuy}), then run setup again.`);
      return false;
    }
    balance = await creditBalance(w.address).catch(() => balance);
    if (balance / perHour < MIN_RUNWAY_HOURS) {
      p.log.info("The credits haven't arrived yet. Nothing was created; run setup again once they show (Robo Guardians → Aleph credits).");
      return false;
    }
  }

  // Offer only nodes that answer and have room, best first (see rankNodeChoices).
  s.start("Checking which compute nodes have room");
  const workedOn = readVmRecords().filter((r) => r.setupDone).map((r) => r.nodeHash);
  const probe = [...new Set([DEFAULT_NODE_HASH, ...workedOn, ...nodes.slice(0, 15).map((n) => n.hash)])]
    .map((h) => nodes.find((n) => n.hash === h))
    .filter((n): n is NonNullable<typeof n> => Boolean(n));
  const capacities = new Map(await Promise.all(probe.map(async (n) => [n.hash, await nodeCapacity(n.url)] as const)));
  const choices = rankNodeChoices(probe, capacities, workedOn, DEFAULT_NODE_HASH).slice(0, 9);
  s.stop(`${choices.length} of the ${probe.length} nodes checked answered with room for the VM`);
  if (choices.length === 0) {
    p.log.warn("None of the nodes checked answered with room. Nothing was created; try again later.");
    return false;
  }
  const why = (n: NodeChoice) =>
    n.recommended
      ? process.env.ALEPH_CRN_HASH
        ? "your ALEPH_CRN_HASH"
        : "recommended: a robo has run here"
      : n.workedHere
        ? `a robo set up from here connected on it${n.workedHere > 1 ? ` (${n.workedHere} times)` : ""}`
        : `score ${n.score.toFixed(2)}`;
  const room = (c: NodeCapacity) => `${Math.round(c.freeRamGB)} GB RAM and ${Math.round(c.freeDiskGB)} GB disk free${c.load5 !== undefined ? `, load ${c.load5.toFixed(1)}${c.cores ? ` on ${c.cores} cores` : ""}` : ""}`;
  const nodeHash = await select({
    message: "Which compute node? (only nodes that answered with room are listed)",
    initialValue: choices[0].hash,
    options: choices.map((n) => ({ value: n.hash, label: `${n.name}${n.recommended ? " (recommended)" : ""}`, hint: `${why(n)} · ${room(n.capacity)}` })),
  });
  if (p.isCancel(nodeHash)) return false;
  const node = nodes.find((n) => n.hash === nodeHash)!;

  p.log.message(
    [
      `VM      ${SIZE.vcpus} vCPU, ${SIZE.memoryMiB / 1024} GB RAM, ${SIZE.diskMiB / 1024} GB disk, Debian 12, on ${node.name} (${node.url})`,
      `Cost    ${perHour.toLocaleString("en-GB")} credits/hour, about ${usd(perHour * 24 * 30)}/month, from ${w.address}'s credits`,
      `Robo    ${o.roboName} for "${o.organisationName}" on ${network.label}, set up with ${path.basename(o.scriptPath)}`,
      "Trust   the robo's seed will live on a VM run by a third-party node operator.",
      "Stops   only when you delete it (Robo Guardians → Aleph Cloud VMs) or the credits run out.",
      ...(network.realFunds ? [] : ["Note    Aleph credits are real funds, even though this robo is for Salt's testnet."]),
    ].join("\n"),
  );
  const go = await p.confirm({ message: "Create the VM and start paying for it?", initialValue: false });
  if (p.isCancel(go) || !go) {
    p.log.info("Nothing was created.");
    return false;
  }

  s.start("Deriving the VM's SSH key from the Aleph wallet");
  const key = await deriveSshKey(w.viem);
  s.message("Creating the VM (publishing the instance)");
  let vm: string;
  try {
    vm = await createInstance(w, { name: `salt-robo-${o.organisationId}`, nodeHash: node.hash, sshPublicKey: key.publicKey, image });
  } catch (err) {
    s.stop("Aleph didn't create the VM");
    p.log.error(`${formatSaltError(err)}\nNo VM exists, so nothing is being charged.`);
    return false;
  }
  const rec: AlephVmRecord = {
    vm,
    name: `salt-robo-${o.organisationId}`,
    nodeHash: node.hash,
    nodeUrl: node.url,
    owner: w.address,
    organisationId: o.organisationId,
    organisationName: o.organisationName,
    saltEnv: network.saltEnv,
    createdAt: new Date().toISOString(),
    scriptPath: path.resolve(o.scriptPath),
  };
  saveVmRecord(rec);
  s.stop(`VM created: ${vm}`);
  return finishOnVm(salt, walletClient, w, rec, rec.scriptPath!, key);
}

/**
 * Everything after "create", for a new VM and for Resume setup: process, forward SSH, start, find
 * the address, wait for SSH, run the setup script, wait for the robo to connect, offer activation.
 * Safe to repeat: forwarding an already-forwarded port, or starting a running VM, changes nothing.
 */
async function finishOnVm(
  salt: Salt,
  walletClient: SaltWalletClient,
  w: AlephWallet,
  rec: AlephVmRecord,
  scriptPath: string,
  knownKey?: SshKeyPair,
): Promise<boolean> {
  const vm = rec.vm;
  const s = spin();
  const leftRunning = (step: string, detail = "") =>
    p.log.warn(
      `${step}${detail ? `: ${detail}` : ""}\nThe VM ${vm} exists and is using credits. Try Robo Guardians → Aleph Cloud VMs → Resume setup, or delete it there.`,
    );

  s.start(knownKey ? `Waiting for Aleph to process the instance (${short(vm)})` : "Deriving the VM's SSH key from the Aleph wallet");
  const key = knownKey ?? (await deriveSshKey(w.viem));
  let target: SshTarget | undefined;
  try {
    await waitProcessed(vm, 180_000, (st) => s.message(`Instance ${short(vm)}: ${st}`));
    s.message("Forwarding an IPv4 port to SSH");
    await forwardSsh(w, vm);
    s.message("Waiting for the scheduler to place the VM");
    const placed = await until(180_000, 5000, () => allocatedNode(vm));
    let nodeUrl = rec.nodeUrl;
    if (placed && placed !== rec.nodeHash) {
      const actual = await computeNode(placed);
      p.log.warn(`The scheduler placed it on ${actual?.name ?? placed}, not the node chosen.`);
      if (actual) nodeUrl = actual.url;
      saveVmRecord({ ...rec, nodeHash: placed, nodeUrl });
    }
    s.message("Starting the VM");
    await startInstance(w, vm, nodeUrl);
    s.message("Waiting for the VM's address");
    const addr = await until(300_000, 5000, async () => {
      const a = await vmAddress(vm, nodeUrl);
      return a && (a.ipv4 && a.sshPort ? a : a.ipv6 ? a : undefined);
    });
    if (!addr) {
      s.stop("The VM has no address yet");
      leftRunning("Its node hasn't reported an address after 5 minutes");
      return false;
    }

    const candidates: SshTarget[] = [
      ...(addr.ipv4 && addr.sshPort ? [{ host: addr.ipv4, port: addr.sshPort, user: SSH_USER }] : []),
      ...(addr.ipv6 ? [{ host: addr.ipv6, port: 22, user: SSH_USER }] : []),
    ];
    // The address appears as soon as the VM starts, before it has booted: keep trying while it boots.
    s.message(`Waiting for the VM to boot and answer on SSH (${candidates.map((c) => `${c.host}:${c.port}`).join(" or ")})`);
    target = await until(240_000, 5000, async () => {
      for (const c of candidates) if (await canReach(c.host, c.port, 5000)) return c;
      return undefined;
    });
    if (!target) {
      // portquiz.net answers on every TCP port, so it tells a blocked network from a VM that isn't up yet.
      const highPortsOpen = await canReach("portquiz.net", 40203, 5000);
      s.stop("SSH isn't answering");
      leftRunning(
        `Couldn't reach ${candidates.map((c) => `${c.host}:${c.port}`).join(" or ")} within 4 minutes`,
        highPortsOpen
          ? "this network does allow outbound high ports, so the VM itself isn't answering yet; Resume setup in a few minutes"
          : "this network looks like it blocks outbound high ports (hotel, guest and office Wi-Fi often do); try another network, such as a phone hotspot",
      );
      return false;
    }

    s.message(`Waiting for SSH to accept the key on ${target.host}:${target.port}`);
    const t = target;
    const ready = await until(240_000, 6000, async () => ((await sshRun(t, key.privateKeyPem, "true")).code === 0 ? true : undefined));
    if (!ready) {
      s.stop("SSH didn't accept the key");
      leftRunning("The VM didn't accept SSH within 4 minutes");
      return false;
    }

    s.message("Copying the robo setup script over");
    const copied = await scpTo(t, key.privateKeyPem, scriptPath, "/tmp/robo-setup.sh");
    if (copied.code !== 0) throw new Error(`scp failed: ${copied.output.slice(-300)}`);
    s.message("Running the robo setup script (installs Docker and starts the robo; a few minutes)");
    let last = "";
    const ran = await sshRun(t, key.privateKeyPem, "sudo bash /tmp/robo-setup.sh; code=$?; sudo rm -f /tmp/robo-setup.sh; exit $code", (line) => {
      last = line;
      s.message(`Setup: ${line.slice(0, 70)}`);
    });
    if (ran.code !== 0) {
      s.stop("The setup script failed on the VM");
      p.log.error(ran.output.split("\n").slice(-15).join("\n"));
      leftRunning("Setup didn't finish");
      return false;
    }
    s.stop(`Robo setup finished on the VM (${last.slice(0, 60)})`);
    p.log.info(`SSH: ssh -p ${t.port} ${t.user}@${t.host} (the key is derived from ${w.address})`);
  } catch (err) {
    s.stop("Stopped");
    leftRunning("A step failed", formatSaltError(err));
    return false;
  }

  s.start("Waiting for the robo to connect to Salt");
  const connected = await until(300_000, 10_000, async () => {
    const host = await salt.getRoboHost({ organisationId: rec.organisationId });
    return (host?.signers.length ?? 0) > 0 ? true : undefined;
  });
  if (!connected) {
    s.stop("The robo hasn't connected yet");
    p.log.warn('It may still be starting. Check with Robo Guardians → "Check robo guardians" in a few minutes, then activate it.');
    return true;
  }
  saveVmRecord({ ...(readVmRecords().find((r) => r.vm === vm) ?? rec), setupDone: true });
  s.stop("The robo is connected to Salt");
  const activate = await p.confirm({ message: "Activate the Robo Guardians (2FA) now? They can't sign until you do.", initialValue: true });
  if (!p.isCancel(activate) && activate) await activateRoboFlow(salt, walletClient, rec.organisationId);
  return true;
}

/** The setup script for a recorded VM: the one recorded, else this organisation's robo-setup-*.sh here. */
function scriptFor(r: AlephVmRecord): string | undefined {
  if (r.scriptPath && fs.existsSync(r.scriptPath)) return r.scriptPath;
  const found = fs.readdirSync(process.cwd()).find((f) => f.startsWith("robo-setup-") && f.endsWith(`-${r.organisationId}.sh`));
  return found ? path.resolve(found) : undefined;
}

/** Robo Guardians → "Aleph Cloud VMs": what this app created, its state, and tearing one down. */
export async function alephVmsFlow(salt: Salt, walletClient: SaltWalletClient): Promise<void> {
  let records = readVmRecords();
  if (records.length === 0) {
    p.log.info("No Aleph Cloud VMs recorded here (.aleph-vms.json).");
    return;
  }
  const s = spin();
  s.start("Checking each VM on its node");
  // Organisation names are read again from Salt, in case one has been renamed.
  for (const r of records) {
    const name = await salt.getOrganisationById(r.organisationId).then((x) => x.organisation.name).catch(() => undefined);
    if (name && name !== r.organisationName) saveVmRecord({ ...r, organisationName: name });
  }
  records = readVmRecords();
  const states = await Promise.all(records.map((r) => vmAddress(r.vm, r.nodeUrl).catch(() => undefined)));
  s.stop(`${records.length} VM(s)`);
  const vm = await select({
    message: "Which VM?",
    options: records.map((r, i) => ({
      value: r.vm,
      label: `${r.organisationName} (${r.saltEnv})`,
      hint: `${short(r.vm)} · ${states[i] ? (states[i]!.running ? "running" : "not running") : "unknown to its node"} · ${r.setupDone ? "robo set up" : "setup not finished"} · since ${r.createdAt.slice(0, 10)}`,
    })),
  });
  if (p.isCancel(vm)) return;
  const r = records.find((x) => x.vm === vm)!;
  const st = states[records.indexOf(r)];
  p.log.message(
    [
      `VM     ${r.vm}`,
      `Node   ${r.nodeUrl}`,
      `Owner  ${r.owner} (Aleph wallet)`,
      `SSH    ${st?.ipv4 && st.sshPort ? `ssh -p ${st.sshPort} ${SSH_USER}@${st.ipv4}` : st?.ipv6 ? `ssh ${SSH_USER}@${st.ipv6}` : "no address reported"}`,
    ].join("\n"),
  );

  const action = await select({
    message: "What now?",
    options: [
      ...(r.setupDone ? [] : [{ value: "resume", label: "Resume setup", hint: "reach the VM, run the robo setup script, wait for the robo, activate" }]),
      ...(st?.ipv4 || st?.ipv6 ? [{ value: "ssh", label: "Open an SSH session", hint: "on the VM, as debian (sudo works); type exit to come back" }] : []),
      { value: "keep", label: "Nothing, keep it running" },
      { value: "delete", label: "Delete it", hint: "erases its disk, stops the credits; the robo stops for good" },
    ],
  });
  if (p.isCancel(action) || action === "keep") return;

  let w: AlephWallet | undefined;
  try {
    w = walletOwning(r.owner);
  } catch (err) {
    p.log.error(formatSaltError(err));
    return;
  }
  if (action === "ssh") {
    if (!w) {
      p.log.warn(`${notOwner(r.owner, "open an SSH session")} (Its SSH key is derived from that wallet.)`);
      return;
    }
    const targets: SshTarget[] = [
      ...(st?.ipv4 && st.sshPort ? [{ host: st.ipv4, port: st.sshPort, user: SSH_USER }] : []),
      ...(st?.ipv6 ? [{ host: st.ipv6, port: 22, user: SSH_USER }] : []),
    ];
    let t: SshTarget | undefined;
    for (const c of targets) {
      if (await canReach(c.host, c.port, 5000)) {
        t = c;
        break;
      }
    }
    if (!t) {
      p.log.warn(`Couldn't reach ${targets.map((c) => `${c.host}:${c.port}`).join(" or ")} from this network.`);
      return;
    }
    const key = await deriveSshKey(w.viem);
    p.log.info(`Connecting to ${t.user}@${t.host} (port ${t.port}). Type exit to come back here.`);
    const code = await sshInteractive(t, key.privateKeyPem);
    p.log.info(`SSH session ended${code ? ` (exit code ${code})` : ""}.`);
    return;
  }
  if (action === "resume") {
    if (!w) {
      p.log.warn(notOwner(r.owner, "resume setup"));
      return;
    }
    const script = scriptFor(r);
    if (!script) {
      p.log.warn(`Couldn't find this organisation's robo setup script (robo-setup-…-${r.organisationId}.sh) in ${process.cwd()}.`);
      return;
    }
    await finishOnVm(salt, walletClient, w, { ...r, scriptPath: script }, script);
    return;
  }
  if (!w) {
    p.log.warn(notOwner(r.owner, "delete it"));
    return;
  }
  p.log.warn(
    `Deleting it stops this robo for good. If it's an active Robo Guardian, "${r.organisationName}" loses that signer, ` +
      "and an activated robo host can't be set up again: its one-time setup OTP is used up.",
  );
  const sure = await p.confirm({ message: `Delete VM ${short(r.vm)}?`, initialValue: false });
  if (p.isCancel(sure) || !sure) return;
  s.start("Deleting");
  try {
    await deleteInstance(w, r.vm, r.nodeUrl, (step) => s.message(`Deleting: ${step}`));
    dropVmRecord(r.vm);
    s.stop("Deleted: its disk is erased and it no longer uses credits");
  } catch (err) {
    s.stop("Delete failed");
    reportError(err);
  }
}

// --- buying credits ------------------------------------------------------------------------------

const etherscanTx = (hash: string) => explorerTxUrl("1", hash) ?? hash;
const ethStr = (wei: bigint, dp = 6) => (Number(wei) / 1e18).toFixed(dp);
/** ETH's USD price, from LI.FI (undefined when it can't be read: ETH is then offered "at the market price"). */
const ethUsdPrice = async () => (await getTokenPriceUsd(1, LIFI_NATIVE_TOKEN)) ?? undefined;

/** Before offering to buy: what buying needs from `w`, and what `w` holds on Ethereum right now. */
async function showFundingNeeds(w: AlephWallet): Promise<void> {
  const needs = `To buy credits, ${w.address} needs USDC (or ETH) on Ethereum, plus a little ETH for gas`;
  try {
    const f = await payerFunds(w.address);
    const gas = (await estimatePaymentGas(w.address, { usdc: f.usdc > 0n ? f.usdc : 1n })) * (f.gasPrice ?? 0n);
    p.log.info(
      `${needs} (a USDC payment is about ${ethStr(gas, 7)} ETH at today's gas price).\n` +
        `Right now ${w.address} holds ${ethStr(f.eth)} ETH and ${(Number(f.usdc) / 1e6).toFixed(2)} USDC on Ethereum. ` +
        "If you're sending ETH for gas, 0.0005 ETH leaves room in case gas prices rise.",
    );
  } catch {
    p.log.info(`${needs}.`);
  }
}

/**
 * Buy Aleph credits for `w`, paid by `w` itself on Ethereum (the only chain Aleph sells credits on; the
 * credits go to whoever pays, so the Aleph wallet has to be the payer). USDC converts exactly
 * (1 USDC = 1,000,000 credits); ETH at the market price. Checks the credit contract, shows what you'd
 * get, and asks before paying (default No). Returns true once credits have been bought.
 */
export async function buyCreditsFlow(w: AlephWallet, perHour?: number): Promise<boolean> {
  const s = spin();
  s.start(`Reading ${w.address}'s ETH and USDC on Ethereum`);
  let funds;
  let contractWarning: string | undefined;
  let ethUsd: number | undefined;
  try {
    [funds, contractWarning, ethUsd] = await Promise.all([payerFunds(w.address), checkCreditContract(), ethUsdPrice()]);
    perHour ??= await hourlyCredits();
  } catch (err) {
    s.stop("Couldn't read Ethereum");
    p.log.error(formatSaltError(err));
    return false;
  }
  const usdcHuman = Number(funds.usdc) / 1e6;
  s.stop(`On Ethereum, ${w.address} holds ${ethStr(funds.eth)} ETH${ethUsd ? ` (~$${((Number(funds.eth) / 1e18) * ethUsd).toFixed(2)})` : ""} and ${usdcHuman.toFixed(2)} USDC`);

  const gasPrice = funds.gasPrice ?? 0n;
  const usdcGas = (await estimatePaymentGas(w.address, { usdc: funds.usdc > 0n ? funds.usdc : 1n })) * gasPrice;
  const canUsdc = funds.usdc > 0n && funds.eth > (usdcGas * 3n) / 2n;
  const ethGasReserve = 40_000n * gasPrice * 2n;
  const canEth = funds.eth > ethGasReserve * 2n;

  if (!canUsdc && !canEth) {
    p.log.warn(
      [
        `${w.address} has no USDC, or not enough ETH for gas (about ${ethStr(usdcGas, 7)} ETH), on Ethereum yet. Ways to get USDC or ETH onto ${w.address} on Ethereum:`,
        `  · from a Salt account on mainnet: Assets → Send assets, on Ethereum, to ${w.address} (Assets → Bridge assets first, if its funds are on another chain)`,
        "  · from an exchange or another wallet",
        `  · or top up at app.aleph.cloud (connect the wallet for ${w.address}, then top up credits with USDC or ALEPH)`,
        `Credits go to whichever address pays, and only payments on Ethereum count: funds sent to ${w.address} on any other chain don't buy credits.`,
      ].join("\n"),
    );
    return false;
  }
  if (funds.usdc > 0n && !canUsdc) p.log.info(`It has USDC but not enough ETH for the payment's gas (~${ethStr(usdcGas, 7)} ETH).`);

  const token = await select<"usdc" | "eth">({
    message: "Pay with?",
    options: [
      ...(canUsdc ? [{ value: "usdc" as const, label: "USDC", hint: `${usdcHuman.toFixed(2)} available · exactly 1,000,000 credits per USDC` }] : []),
      ...(canEth ? [{ value: "eth" as const, label: "ETH", hint: `${ethStr(funds.eth)} available · at the market price${ethUsd ? ` (~$${ethUsd.toFixed(0)})` : ""}` }] : []),
    ],
  });
  if (p.isCancel(token)) return false;

  const month = perHour * 24 * 30;
  let pay: { usdc: bigint } | { eth: bigint };
  let credits: number;
  if (token === "usdc") {
    const suggested = Math.min(usdcHuman, Math.ceil(month / 1e6));
    const entered = await p.text({
      message: `How much USDC? (${usdcHuman.toFixed(2)} available; ${(month / 1e6).toFixed(2)} buys about 30 days of one VM)`,
      placeholder: suggested.toFixed(2),
      defaultValue: suggested.toFixed(2),
      validate: (v) => {
        const n = Number((v || suggested.toFixed(2)).trim());
        if (!Number.isFinite(n) || n <= 0) return "Enter an amount of USDC, e.g. 10";
        if (n > usdcHuman) return `That's more than the ${usdcHuman.toFixed(2)} USDC available.`;
        return undefined;
      },
    });
    if (p.isCancel(entered)) return false;
    const usdc = parseUnits((entered || suggested.toFixed(2)).trim(), 6);
    pay = { usdc };
    credits = Number(usdc);
  } else {
    const maxEth = funds.eth - ethGasReserve;
    const entered = await p.text({
      message: `How much ETH? (up to ${ethStr(maxEth)}; some stays for gas)`,
      validate: (v) => {
        const n = Number((v ?? "").trim());
        if (!Number.isFinite(n) || n <= 0) return "Enter an amount of ETH, e.g. 0.004";
        if (parseEther(String(n)) > maxEth) return `That's more than the ${ethStr(maxEth)} ETH available.`;
        return undefined;
      },
    });
    if (p.isCancel(entered)) return false;
    const eth = parseEther(entered.trim());
    pay = { eth };
    credits = ethUsd ? Math.floor((Number(eth) / 1e18) * ethUsd * 1e6) : 0;
  }

  const gas = (await estimatePaymentGas(w.address, pay)) * gasPrice;
  p.log.message(
    [
      `Pay     ${"usdc" in pay ? `${(Number(pay.usdc) / 1e6).toFixed(2)} USDC` : `${ethStr(pay.eth)} ETH`} from ${w.address}, on Ethereum`,
      `To      Aleph's credit contract ${CREDIT_CONTRACT}`,
      `Get     ${credits ? `${"eth" in pay ? "about " : ""}${credits.toLocaleString("en-GB")} credits, about ${Math.floor(credits / perHour / 24)} days of one VM` : "credits at the market price (no ETH price right now)"}`,
      `Gas     about ${ethStr(gas, 7)} ETH`,
      "The credits go to the paying address. They usually arrive within a minute or two (rarely, hours).",
    ].join("\n"),
  );
  if (contractWarning) p.log.warn(contractWarning);
  const go = await p.confirm({ message: "Pay now? This spends real funds on Ethereum.", initialValue: false });
  if (p.isCancel(go) || !go) {
    p.log.info("Nothing paid.");
    return false;
  }

  s.start("Sending the payment on Ethereum");
  let hash: string;
  try {
    hash = await payForCredits(w.viem, pay);
  } catch (err) {
    s.stop("The payment didn't go through");
    p.log.error(formatSaltError(err));
    return false;
  }
  s.message(`Paid (${etherscanTx(hash)}); waiting for Aleph to grant the credits`);
  const granted = await until(300_000, 10_000, () => creditsFor(w.address, hash));
  if (granted === undefined) {
    s.stop("Paid, but the credits haven't shown up yet");
    p.log.warn(`Payment: ${etherscanTx(hash)}\nAleph usually grants credits within a minute or two, occasionally much later. Check again under Robo Guardians → Aleph credits.`);
    return true;
  }
  s.stop(`Aleph granted ${granted.toLocaleString("en-GB")} credits`);
  p.log.success(`Payment: ${etherscanTx(hash)}\nBalance now: ${(await creditBalance(w.address).catch(() => 0)).toLocaleString("en-GB")} credits`);
  return true;
}

/** Robo Guardians → "Aleph credits": the Aleph wallet's credits and runway, and buying more. */
export async function alephCreditsFlow(): Promise<void> {
  const w = await chooseWallet();
  if (!w) return;
  const s = spin();
  s.start("Reading the credit balance and price");
  let balance: number;
  let perHour: number;
  try {
    [balance, perHour] = await Promise.all([creditBalance(w.address), hourlyCredits()]);
  } catch (err) {
    s.stop("Couldn't reach Aleph");
    p.log.error(formatSaltError(err));
    return;
  }
  const vms = readVmRecords().filter((r) => r.owner.toLowerCase() === w.address.toLowerCase()).length;
  const burn = perHour * Math.max(vms, 1);
  s.stop(
    `${w.address}: ${balance.toLocaleString("en-GB")} credits (${usd(balance)}). ` +
      `${vms ? `${vms} VM(s) recorded here use about ${burn.toLocaleString("en-GB")}/hour, so about ${Math.floor(balance / burn / 24)} days left` : `About ${Math.floor(balance / perHour / 24)} days of one VM`}.`,
  );
  await showFundingNeeds(w);
  const buy = await p.confirm({ message: `Buy more credits for ${w.address}?`, initialValue: false });
  if (!p.isCancel(buy) && buy) await buyCreditsFlow(w, perHour);
}
