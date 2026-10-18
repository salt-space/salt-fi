import fs from "node:fs";
import path from "node:path";
import { AlephHttpClient, AuthenticatedAlephHttpClient, VmClient } from "@aleph-sdk/client";
import { Blockchain } from "@aleph-sdk/core";
import { importAccountFromPrivateKey } from "@aleph-sdk/ethereum";
import { PaymentType } from "@aleph-sdk/message";
import { getAddress } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { env } from "../env.js";

/**
 * Aleph Cloud, for hosting a Robo Guardian on a pay-as-you-go VM (experimental). Rebuilt from what
 * Aleph's own CLI (aleph-rs) does:
 *
 *   create   INSTANCE message (credit payment), pinned to one compute node (CRN) by node hash
 *   ssh      AGGREGATE "port-forwarding" {vm: {ports: {"22": {tcp}}}}: the CRN maps a random IPv4 host port
 *   start    signed POST {crn}/control/machine/{vm}/start (VmClient), else POST {crn}/control/allocation/notify
 *   address  GET {crn}/v2/about/executions/list → networking.{ipv6_ip, host_ipv4, mapped_ports}
 *   delete   signed erase on the CRN, the port entry nulled, then a FORGET message
 *
 * Create, SSH, start and address have been run end to end on mainnet. Not yet tested: delete, and
 * whether billing stops the moment the FORGET lands.
 *
 * The Aleph wallet owns the VM and pays for its credits. It's ALEPH_PRIVATE_KEY, a separate wallet,
 * when that's set. Otherwise, if you sign with a private key (SIGNER=private-key), the flow offers
 * your signing wallet (PRIVATE_KEY), with a confirm, since the owner is already the robo's trust
 * root. A Ledger can't be the Aleph wallet yet: Aleph's messages are signed here with a raw key.
 */

export const ALEPH_API = process.env.ALEPH_API_URL ?? "https://api.aleph.im";
const SCHEDULER = "https://scheduler.api.aleph.cloud";
/** Aleph's own settings: the VM image list ("vm-images") and prices ("pricing"). */
const SETTINGS_OWNER = "0xFba561a84A537fCaa567bb7A2257e7142701ae2A";
/** Publishes the "corechannel" aggregate: Aleph's list of compute nodes. */
const CORECHANNEL_OWNER = "0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10";
/** AlephVision4, a node a robo has run on. ALEPH_CRN_HASH makes another node the recommended one. */
export const DEFAULT_NODE_HASH = process.env.ALEPH_CRN_HASH ?? "18de7c5d3112f5f189dfdf031ec204e8ac38ef8681796107d21254cf01d84887";
/** A known Debian 12 image, used if Aleph's image list can't be read. */
const DEBIAN12_FALLBACK = "b6ff5c3a8205d1ca4c7c3369300eeafff498b558f71b851aa2114afd0a532717";
/** One compute unit: what the robo needs with room to spare (it uses ~66 MB RAM, ~0% CPU). */
export const SIZE = { vcpus: 1, memoryMiB: 2048, diskMiB: 20480 };
export const CREDITS_PER_USD = 1_000_000;
/** The image's default user (Debian images log in as `debian`, with passwordless sudo). */
export const SSH_USER = "debian";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}
const trimSlash = (u: string) => u.replace(/\/+$/, "");

// --- the Aleph wallet ---------------------------------------------------------------------------

export interface AlephWallet {
  address: `0x${string}`;
  /** Where the key came from: a dedicated Aleph wallet, or your signing wallet. */
  source: "ALEPH_PRIVATE_KEY" | "PRIVATE_KEY";
  aleph: ReturnType<typeof importAccountFromPrivateKey>;
  /** For deriving the VM's SSH key (a wallet signature seeds it) and paying for credits. */
  viem: PrivateKeyAccount;
}

function walletFrom(source: AlephWallet["source"]): AlephWallet | undefined {
  const key = process.env[source]?.trim();
  if (!key) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${source} must be a 0x-prefixed 32-byte hex key.`);
  const viem = privateKeyToAccount(key as `0x${string}`);
  return { address: viem.address, source, aleph: importAccountFromPrivateKey(key), viem };
}

/** The dedicated Aleph wallet (ALEPH_PRIVATE_KEY), or undefined when it isn't set. */
export const alephWallet = (): AlephWallet | undefined => walletFrom("ALEPH_PRIVATE_KEY");

/**
 * Your signing wallet (PRIVATE_KEY) as an Aleph wallet, offered when there's no dedicated one. Only
 * when you sign with that key: with SIGNER=ledger, PRIVATE_KEY isn't your signer (the app ignores it),
 * so it's never used here either.
 */
export const signerAlephWallet = (): AlephWallet | undefined => (env.signer === "private-key" ? walletFrom("PRIVATE_KEY") : undefined);

/** Whichever of the two keys owns `address` (to manage a VM with the wallet that created it). */
export function walletOwning(address: string): AlephWallet | undefined {
  return [alephWallet(), signerAlephWallet()].find((w) => w && w.address.toLowerCase() === address.toLowerCase());
}

/** The wallet's Aleph credit balance (credits; 1 USD = 1,000,000). */
export async function creditBalance(address: string): Promise<number> {
  const b = await new AlephHttpClient(ALEPH_API).getBalance(getAddress(address)); // Aleph's address endpoints want it checksummed
  return Number(b.credit_balance ?? 0);
}

// --- what a VM costs and runs ---------------------------------------------------------------------

/** Credits per hour for one compute unit, from Aleph's live pricing (14,250 when this was written). */
export async function hourlyCredits(): Promise<number> {
  const d = await getJson<{ data: { pricing: { instance: { price: { compute_unit: { credit: string } } } } } }>(
    `${ALEPH_API}/api/v0/aggregates/${SETTINGS_OWNER}.json?keys=pricing`,
  );
  return Number(d.data.pricing.instance.price.compute_unit.credit);
}

/** The Debian 12 image's hash from Aleph's image list (falls back to a known one). */
export async function debian12Image(): Promise<string> {
  try {
    const d = await getJson<{ data: { "vm-images": { rootfs: Record<string, { hash: string; deprecated?: boolean }> } } }>(
      `${ALEPH_API}/api/v0/aggregates/${SETTINGS_OWNER}.json?keys=vm-images`,
    );
    const img = d.data["vm-images"].rootfs.debian12;
    if (img?.hash && !img.deprecated) return img.hash;
  } catch {
    // fall through
  }
  return DEBIAN12_FALLBACK;
}

// --- compute nodes --------------------------------------------------------------------------------

export interface ComputeNode {
  hash: string;
  name: string;
  url: string;
  score: number;
}

/** Linked compute nodes, best score first. */
export async function computeNodes(): Promise<ComputeNode[]> {
  const d = await getJson<{ data: { corechannel: { resource_nodes: { hash: string; name: string; address: string; status: string; score: number }[] } } }>(
    `https://api2.aleph.im/api/v0/aggregates/${CORECHANNEL_OWNER}.json?keys=corechannel`,
  );
  return d.data.corechannel.resource_nodes
    .filter((n) => n.status === "linked" && n.address)
    .map((n) => ({ hash: n.hash, name: n.name, url: trimSlash(n.address), score: n.score }))
    .sort((a, b) => b.score - a.score);
}

export async function computeNode(hash: string): Promise<ComputeNode | undefined> {
  return (await computeNodes()).find((n) => n.hash === hash);
}

export interface NodeCapacity {
  freeRamGB: number;
  freeDiskGB: number;
  load5?: number;
  cores?: number;
}

/** A node's free memory, disk and load, from its public usage endpoint (undefined if it doesn't answer in 6 s). */
export async function nodeCapacity(url: string): Promise<NodeCapacity | undefined> {
  type Usage = { cpu?: { count?: number; load_average?: { load5?: number } }; mem?: { available_kB?: number }; disk?: { available_kB?: number } };
  try {
    const res = await fetch(`${trimSlash(url)}/about/usage/system`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return undefined;
    const d = (await res.json()) as Usage;
    if (!d.mem?.available_kB || !d.disk?.available_kB) return undefined;
    return { freeRamGB: d.mem.available_kB / 1048576, freeDiskGB: d.disk.available_kB / 1048576, load5: d.cpu?.load_average?.load5, cores: d.cpu?.count };
  } catch {
    return undefined;
  }
}

export interface NodeChoice extends ComputeNode {
  capacity: NodeCapacity;
  recommended: boolean;
  /** Robos set up from this app that connected on this node. */
  workedHere: number;
}

/** Room a node needs beyond one VM: 25% headroom on memory and disk. */
const NEEDS = { ramGB: (SIZE.memoryMiB / 1024) * 1.25, diskGB: (SIZE.diskMiB / 1024) * 1.25 };

/**
 * The nodes worth offering, best first: only those that answered with room for the VM (plus headroom);
 * the recommended one first, then nodes where a robo has worked before (most first), then by score.
 * Pure, so it's tested on its own.
 */
export function rankNodeChoices(
  nodes: ComputeNode[],
  capacities: Map<string, NodeCapacity | undefined>,
  workedOn: string[],
  recommendedHash: string,
): NodeChoice[] {
  const worked = (hash: string) => workedOn.filter((h) => h === hash).length;
  return nodes
    .map((n) => ({ ...n, capacity: capacities.get(n.hash), recommended: n.hash === recommendedHash, workedHere: worked(n.hash) }))
    .filter((n): n is NodeChoice => Boolean(n.capacity && n.capacity.freeRamGB >= NEEDS.ramGB && n.capacity.freeDiskGB >= NEEDS.diskGB))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || b.workedHere - a.workedHere || b.score - a.score);
}

// --- the VM's lifecycle ---------------------------------------------------------------------------

const authed = (w: AlephWallet) => new AuthenticatedAlephHttpClient(w.aleph, ALEPH_API);

/** Publish the INSTANCE message (this is what starts spending credits). Returns the VM's id (its item hash). */
export async function createInstance(w: AlephWallet, o: { name: string; nodeHash: string; sshPublicKey: string; image: string }): Promise<string> {
  const msg = await authed(w).createInstance({
    channel: "salt-fi-robos",
    metadata: { name: o.name },
    authorized_keys: [o.sshPublicKey],
    resources: { vcpus: SIZE.vcpus, memory: SIZE.memoryMiB },
    requirements: { node: { node_hash: o.nodeHash } },
    environment: { internet: true, aleph_api: true, shared_cache: false },
    rootfs: { parent: { ref: o.image }, size_mib: SIZE.diskMiB } as never,
    payment: { chain: Blockchain.ETH, type: PaymentType.credit },
    sync: true,
  });
  return msg.item_hash;
}

/** Wait until Aleph has processed a message ("processed"); throws if it's rejected. */
export async function waitProcessed(hash: string, timeoutMs = 180_000, onStatus?: (s: string) => void): Promise<void> {
  const client = new AlephHttpClient(ALEPH_API);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await client.getMessageStatus(hash).catch(() => undefined);
    const status = (s as { status?: string } | undefined)?.status;
    if (status) onStatus?.(status);
    if (status === "processed") return;
    if (status === "rejected" || status === "forgotten") throw new Error(`Aleph ${status} the message ${hash}: ${JSON.stringify(s).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Aleph hadn't processed ${hash} after ${timeoutMs / 1000}s.`);
}

/** Which node the scheduler put the VM on, once it has (undefined until then). */
export async function allocatedNode(vm: string): Promise<string | undefined> {
  const d = await getJson<{ status?: string; allocated_node?: string | null }>(`${SCHEDULER}/api/v1/vms/${vm}`).catch(() => undefined);
  return d?.allocated_node ?? undefined;
}

/** Ask the VM's node to forward an IPv4 port to SSH (22): the aggregate the node reads. */
export async function forwardSsh(w: AlephWallet, vm: string): Promise<void> {
  type Forwards = { data?: { "port-forwarding"?: Record<string, { ports?: Record<string, unknown> } | null> } };
  const existing = await getJson<Forwards>(`${ALEPH_API}/api/v0/aggregates/${w.address}.json?keys=port-forwarding`).catch((): Forwards => ({}));
  const ports = { ...(existing.data?.["port-forwarding"]?.[vm]?.ports ?? {}), "22": { tcp: true, udp: false } };
  await authed(w).createAggregate({ key: "port-forwarding", content: { [vm]: { ports } }, sync: true });
}

/** Start the VM on its node: the signed control call, else the older nodes' allocation notify. */
export async function startInstance(w: AlephWallet, vm: string, nodeUrl: string): Promise<string> {
  const vc = await VmClient.create(w.aleph, trimSlash(nodeUrl));
  const res = await vc.startInstance(vm);
  if (res.status >= 200 && res.status < 300) return "started";
  if (res.status !== 404) throw new Error(`The node refused to start it (HTTP ${res.status}): ${res.response.slice(0, 200)}`);
  const notify = await fetch(`${trimSlash(nodeUrl)}/control/allocation/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instance: vm }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await notify.text();
  if (!notify.ok) throw new Error(`The node didn't accept the start notification (HTTP ${notify.status}): ${body.slice(0, 200)}`);
  return "notified";
}

export interface VmAddress {
  running: boolean;
  ipv6?: string;
  /** The node's public IPv4 and the host port it forwards to the VM's SSH. */
  ipv4?: string;
  sshPort?: number;
}

/** The VM's addresses, from its node's list of executions (undefined until the node knows it). */
export async function vmAddress(vm: string, nodeUrl: string): Promise<VmAddress | undefined> {
  type Exec = { running?: boolean; networking?: { ipv6_ip?: string; host_ipv4?: string; mapped_ports?: Record<string, { host?: number }> } };
  const list = await getJson<Record<string, Exec>>(`${trimSlash(nodeUrl)}/v2/about/executions/list`).catch(() => undefined);
  const e = list?.[vm];
  if (!e) return undefined;
  const n = e.networking ?? {};
  return { running: Boolean(e.running), ipv6: n.ipv6_ip?.split("/")[0], ipv4: n.host_ipv4, sshPort: n.mapped_ports?.["22"]?.host };
}

/** Erase the VM's disks on its node, drop its port forward, and FORGET the instance (stops the credits). */
export async function deleteInstance(w: AlephWallet, vm: string, nodeUrl?: string, onStep?: (s: string) => void): Promise<void> {
  if (nodeUrl) {
    onStep?.("erasing it on its node");
    try {
      await (await VmClient.create(w.aleph, trimSlash(nodeUrl))).eraseInstance(vm);
    } catch {
      // the FORGET below still stops it
    }
  }
  onStep?.("removing its SSH port forward");
  await authed(w)
    .createAggregate({ key: "port-forwarding", content: { [vm]: null }, sync: true })
    .catch(() => undefined);
  onStep?.("forgetting the instance");
  await authed(w).forget({ hashes: [vm], reason: "salt-fi robo teardown", sync: true });
}

// --- what this app created (so it can be listed and torn down) -------------------------------------

export interface AlephVmRecord {
  vm: string;
  name: string;
  nodeHash: string;
  nodeUrl: string;
  owner: string;
  organisationId: string;
  organisationName: string;
  saltEnv: string;
  createdAt: string;
  /** The robo setup script this VM runs (holds the one-time OTP); for Resume setup. */
  scriptPath?: string;
  /** Set once the robo has connected to Salt. */
  setupDone?: boolean;
}

/** `.aleph-vms.json` in the working directory (gitignored), resolved on each call. */
const recordsFile = () => path.resolve(process.cwd(), ".aleph-vms.json");

export function readVmRecords(): AlephVmRecord[] {
  try {
    return JSON.parse(fs.readFileSync(recordsFile(), "utf-8")) as AlephVmRecord[];
  } catch {
    return [];
  }
}

export function saveVmRecord(r: AlephVmRecord): void {
  fs.writeFileSync(recordsFile(), `${JSON.stringify([...readVmRecords().filter((x) => x.vm !== r.vm), r], null, 2)}\n`);
}

export function dropVmRecord(vm: string): void {
  fs.writeFileSync(recordsFile(), `${JSON.stringify(readVmRecords().filter((x) => x.vm !== vm), null, 2)}\n`);
}
