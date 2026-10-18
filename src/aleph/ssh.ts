import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * SSH to an Aleph VM with the system's ssh/scp. The key lives in a fresh owner-only temp dir for the
 * length of one call and is removed afterwards. Host keys go to `.aleph-known-hosts` in the working
 * directory (gitignored), not your ~/.ssh/known_hosts: a new VM's key is accepted on first use
 * (`accept-new`) and checked after that.
 */

export interface SshTarget {
  host: string;
  port: number;
  user: string;
}

const knownHosts = () => path.resolve(process.cwd(), ".aleph-known-hosts");

/** Can we open a TCP connection to host:port within `ms`? Hotel, guest and office Wi-Fi often block the high ports Aleph forwards SSH on. */
export function canReach(host: string, port: number, ms = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function withKeyFile<T>(privateKeyPem: string, fn: (keyPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-aleph-"));
  const keyPath = path.join(dir, "id_ed25519");
  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  try {
    return await fn(keyPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const baseOptions = (keyPath: string) => [
  "-i", keyPath,
  "-o", "IdentitiesOnly=yes",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", `UserKnownHostsFile=${knownHosts()}`,
];

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let partial = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine?.(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.once("error", reject);
    child.once("close", (code) => {
      if (partial.trim()) onLine?.(partial);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Run a command on the VM. Lines of output are passed to `onLine` as they arrive. */
export function sshRun(t: SshTarget, privateKeyPem: string, command: string, onLine?: (line: string) => void) {
  return withKeyFile(privateKeyPem, (key) => run("ssh", [...baseOptions(key), "-p", String(t.port), `${t.user}@${t.host}`, command], onLine));
}

/** Copy a local file to the VM. */
export function scpTo(t: SshTarget, privateKeyPem: string, localPath: string, remotePath: string) {
  const host = t.host.includes(":") ? `[${t.host}]` : t.host; // scp needs brackets around an IPv6 address
  return withKeyFile(privateKeyPem, (key) => run("scp", [...baseOptions(key), "-P", String(t.port), localPath, `${t.user}@${host}:${remotePath}`]));
}

/** An interactive SSH session on the VM, in this terminal; resolves with ssh's exit code when you leave. */
export function sshInteractive(t: SshTarget, privateKeyPem: string): Promise<number> {
  return withKeyFile(
    privateKeyPem,
    (key) =>
      new Promise<number>((resolve, reject) => {
        const opts = baseOptions(key).filter((o, i, a) => !(o === "BatchMode=yes" || a[i + 1] === "BatchMode=yes"));
        const child = spawn("ssh", [...opts, "-p", String(t.port), `${t.user}@${t.host}`], { stdio: "inherit" });
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      }),
  );
}
