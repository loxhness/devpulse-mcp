import { readFile, readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import findProcess from "find-process";
import { run } from "../utils/exec.js";

export interface ServiceInfo {
  port: number;
  pid: number | null;
  name: string;
  /** Working directory of the listening process, when it can be read. */
  process_cwd: string | null;
  /**
   * true: the process was started from this project.
   * false: it belongs to something else (a port conflict).
   * null: ownership could not be determined (e.g. Windows, another user's process).
   */
  owned_by_project: boolean | null;
}

export interface ProcessResult {
  running: ServiceInfo[];
  expected_but_missing: number[];
  /** False when no port lookup method works on this machine. */
  detection_available: boolean;
  detection_method: string | null;
}

interface Listener {
  pid: number | null;
  name: string;
}

/** A lookup returns the listener, null for "nothing listening", or throws if the method is unavailable. */
type Lookup = (port: number) => Promise<Listener | null>;

class Unavailable extends Error {}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

// ---------- Linux: /proc (no external tools needed) ----------

async function readProcNetListeners(): Promise<Map<number, string[]>> {
  const byPort = new Map<number, string[]>();
  let readAny = false;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
      readAny = true;
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A") continue; // 0A = LISTEN
      const port = parseInt(cols[1].split(":")[1], 16);
      const inodes = byPort.get(port) ?? [];
      inodes.push(cols[9]);
      byPort.set(port, inodes);
    }
  }
  if (!readAny) throw new Unavailable("/proc/net/tcp not readable");
  return byPort;
}

async function findPidsForInodes(inodes: Set<string>): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return result;
  }
  for (const pid of pids) {
    if (result.size === inodes.size) break;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue; // another user's process
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        const match = target.match(/^socket:\[(\d+)\]$/);
        if (match && inodes.has(match[1])) {
          result.set(match[1], Number(pid));
        }
      } catch {
        // fd closed meanwhile
      }
    }
  }
  return result;
}

async function procName(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${pid}/comm`, "utf8")).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function lookupAllViaProc(ports: number[]): Promise<Map<number, Listener | null>> {
  const listeners = await readProcNetListeners();
  const wanted = new Set<string>();
  for (const port of ports) for (const inode of listeners.get(port) ?? []) wanted.add(inode);
  const pidByInode = await findPidsForInodes(wanted);
  const out = new Map<number, Listener | null>();
  for (const port of ports) {
    const inodes = listeners.get(port);
    if (!inodes || inodes.length === 0) {
      out.set(port, null);
      continue;
    }
    const pid = inodes.map((inode) => pidByInode.get(inode)).find((p) => p !== undefined) ?? null;
    out.set(port, { pid, name: pid !== null ? await procName(pid) : "unknown (not visible to this user)" });
  }
  return out;
}

// ---------- ss / lsof / find-process ----------

const viaSs: Lookup = async (port) => {
  const out = await run("ss", ["-ltnpH", `sport = :${port}`]);
  if (out === null) throw new Unavailable("ss not available");
  if (!out.trim()) return null;
  const match = out.match(/users:\(\("([^"]+)",pid=(\d+)/);
  return match ? { pid: Number(match[2]), name: match[1] } : { pid: null, name: "unknown" };
};

const viaLsof: Lookup = async (port) => {
  const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  // lsof exits 1 with no output when nothing matches; distinguish from "missing".
  if (out === null) {
    const exists = await run("lsof", ["-v"]);
    if (exists === null) throw new Unavailable("lsof not available");
    return null;
  }
  const pid = out.match(/^p(\d+)/m);
  const name = out.match(/^c(.+)$/m);
  if (!pid) return null;
  return { pid: Number(pid[1]), name: name?.[1] ?? "unknown" };
};

const viaFindProcess: Lookup = async (port) => {
  const results = await findProcess("port", port);
  if (results.length === 0) return null;
  return { pid: results[0].pid, name: results[0].name };
};

/**
 * find-process returns [] (not an error) when its underlying tool is missing,
 * so it can't distinguish "nothing listening" from "can't check". Only trust
 * it on platforms where its tool ships by default.
 */
function lookupChain(): Array<[string, Lookup]> {
  switch (process.platform) {
    case "win32":
      return [["netstat", viaFindProcess]];
    case "darwin":
      return [["lsof", viaLsof], ["find-process", viaFindProcess]];
    default:
      return [["ss", viaSs], ["lsof", viaLsof]];
  }
}

// ---------- Ownership ----------

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const out = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return out?.match(/^n(.+)$/m)?.[1] ?? null;
  }
  return null;
}

async function processCommandLine(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    return run("ps", ["-o", "command=", "-p", String(pid)]);
  }
  return null;
}

export async function checkOwnership(
  pid: number | null,
  projectRoot: string | undefined
): Promise<{ owned: boolean | null; cwd: string | null }> {
  if (pid === null || !projectRoot) return { owned: null, cwd: null };
  const root = resolve(projectRoot);
  const cwd = await processCwd(pid);
  if (cwd) {
    if (isInside(cwd, root)) return { owned: true, cwd };
    // A monorepo root running the dev server for a package inside it.
    const tooBroad = cwd === parse(cwd).root || resolve(cwd) === resolve(homedir());
    if (!tooBroad && isInside(root, cwd)) return { owned: true, cwd };
  }
  const commandLine = await processCommandLine(pid);
  if (commandLine && commandLine.includes(root)) return { owned: true, cwd };
  if (cwd) return { owned: false, cwd };
  return { owned: null, cwd: null };
}

// ---------- Public API ----------

/**
 * With framework-default ports the dev server only needs one of them, so once
 * this project's server is found the other candidates aren't "missing".
 */
export function settleDefaultPorts(
  result: ProcessResult,
  portSource: "config" | "default" | "none"
): ProcessResult {
  if (portSource !== "default") return result;
  const ownServerUp = result.running.some((s) => s.owned_by_project !== false);
  return ownServerUp ? { ...result, expected_but_missing: [] } : result;
}

export async function getRunningServices(
  expectedPorts: number[],
  projectRoot?: string
): Promise<ProcessResult> {
  const ports = [...new Set(expectedPorts)];
  const listeners = new Map<number, Listener | null>();
  let method: string | null = null;

  const validPorts = ports.filter(isValidPort);
  for (const port of ports) if (!isValidPort(port)) listeners.set(port, null);

  if (validPorts.length > 0 && process.platform === "linux") {
    try {
      const procResults = await lookupAllViaProc(validPorts);
      for (const [port, listener] of procResults) listeners.set(port, listener);
      method = "procfs";
    } catch {
      // fall through to external tools
    }
  }

  if (method === null && validPorts.length > 0) {
    for (const [name, lookup] of lookupChain()) {
      try {
        const results = await Promise.all(validPorts.map((port) => lookup(port)));
        validPorts.forEach((port, i) => listeners.set(port, results[i]));
        method = name;
        break;
      } catch {
        // try the next method
      }
    }
  }

  const detectionAvailable = validPorts.length === 0 || method !== null;
  const running: ServiceInfo[] = [];
  const missing: number[] = [];

  for (const port of ports) {
    const listener = listeners.get(port);
    if (!detectionAvailable) continue;
    if (!listener) {
      missing.push(port);
      continue;
    }
    const ownership = await checkOwnership(listener.pid, projectRoot);
    running.push({
      port,
      pid: listener.pid,
      name: listener.name,
      process_cwd: ownership.cwd,
      owned_by_project: ownership.owned,
    });
  }

  return {
    running,
    expected_but_missing: missing,
    detection_available: detectionAvailable,
    detection_method: method,
  };
}
