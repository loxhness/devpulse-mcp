import { readFile, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import findProcess from "find-process";
import { run, runWithStatus } from "../utils/exec.js";

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
  /** When the listening process started (ISO), or null if unknown (always null on Windows). */
  started_at: string | null;
}

export interface ProcessResult {
  running: ServiceInfo[];
  expected_but_missing: number[];
  /** Ports no lookup method could check (never reported as free). */
  unchecked_ports: number[];
  /** False when no port lookup method works on this machine. */
  detection_available: boolean;
  detection_method: string | null;
}

export interface RunningServicesOptions {
  /** Override the external-tool lookup chain (tests). */
  chain?: Array<[string, Lookup]>;
  /** Set false to skip the /proc fast path (tests). Default: true on Linux. */
  procfs?: boolean;
}

interface Listener {
  pid: number | null;
  name: string;
}

/** A lookup returns the listener, null for "nothing listening", or throws if the method is unavailable. */
export type Lookup = (port: number) => Promise<Listener | null>;

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
  const { stdout: out, code } = await runWithStatus("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  // lsof exits 1 with no output when nothing matches. Anything else (missing
  // command, timeout, other errors) means this port couldn't be checked.
  if (code === 1 && !out.trim()) return null;
  if (code !== 0) throw new Unavailable("lsof failed");
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

let clockTicks: Promise<number> | null = null;

/** Linux USER_HZ (clock ticks per second) for /proc/<pid>/stat start times; almost always 100. */
function linuxClockTicks(): Promise<number> {
  clockTicks ??= run("getconf", ["CLK_TCK"]).then((out) => {
    const ticks = Number(out);
    return Number.isFinite(ticks) && ticks > 0 ? ticks : 100;
  });
  return clockTicks;
}

/**
 * When a process started, as an ISO string, or null if unknown.
 * Linux: /proc/<pid>/stat field 22 (ticks since boot) plus btime from /proc/stat.
 * macOS: `ps -o lstart=`. Windows: not implemented.
 */
export async function processStartTime(pid: number | null): Promise<string | null> {
  if (pid === null) return null;
  try {
    if (process.platform === "linux") {
      const [stat, procStat, ticks] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/stat", "utf8"),
        linuxClockTicks(),
      ]);
      // The command name (field 2) may contain spaces or parens; fields after
      // the last ")" start at field 3, so field 22 is index 19.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTicks = Number(fields[19]);
      const btime = Number(procStat.match(/^btime\s+(\d+)/m)?.[1]);
      if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
      return new Date((btime + startTicks / ticks) * 1000).toISOString();
    }
    if (process.platform === "darwin") {
      // LC_ALL=C keeps the format parseable: "Thu Nov 12 10:58:46 2026" (local time).
      const { stdout, code } = await runWithStatus("ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { ...process.env, LC_ALL: "C" },
      });
      if (code !== 0) return null;
      const ms = Date.parse(stdout.trim().replace(/\s+/g, " "));
      return Number.isNaN(ms) ? null : new Date(ms).toISOString();
    }
  } catch {
    // process gone or unreadable
  }
  return null;
}

export async function checkOwnership(
  pid: number | null,
  projectRoot: string | undefined
): Promise<{ owned: boolean | null; cwd: string | null }> {
  if (pid === null || !projectRoot) return { owned: null, cwd: null };
  // Compare real paths: on macOS /var and /tmp are symlinks to /private/..., and
  // lsof reports the resolved path, so the same folder can have two spellings.
  const root = await realpath(resolve(projectRoot)).catch(() => resolve(projectRoot));
  const rawCwd = await processCwd(pid);
  const cwd = rawCwd ? await realpath(rawCwd).catch(() => rawCwd) : null;
  if (cwd) {
    if (isInside(cwd, root)) return { owned: true, cwd };
    // A monorepo root running the dev server for a package inside it.
    const tooBroad = cwd === parse(cwd).root || resolve(cwd) === resolve(homedir());
    if (!tooBroad && isInside(root, cwd)) return { owned: true, cwd };
  }
  const commandLine = await processCommandLine(pid);
  if (commandLine && (commandLine.includes(root) || commandLine.includes(resolve(projectRoot)))) {
    return { owned: true, cwd };
  }
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
  projectRoot?: string,
  options: RunningServicesOptions = {}
): Promise<ProcessResult> {
  const ports = [...new Set(expectedPorts)];
  const listeners = new Map<number, Listener | null>();
  const methodsUsed = new Set<string>();

  const validPorts = ports.filter(isValidPort);
  for (const port of ports) if (!isValidPort(port)) listeners.set(port, null);

  const useProcfs = options.procfs ?? process.platform === "linux";
  if (validPorts.length > 0 && useProcfs) {
    try {
      const procResults = await lookupAllViaProc(validPorts);
      for (const [port, listener] of procResults) listeners.set(port, listener);
      methodsUsed.add("procfs");
    } catch {
      // fall through to external tools
    }
  }

  // Per port, walk the chain until a method answers. A port no method could
  // check stays out of `listeners` and is reported as unchecked, never as free.
  const chain = options.chain ?? lookupChain();
  const pending = validPorts.filter((port) => !listeners.has(port));
  await Promise.all(
    pending.map(async (port) => {
      for (const [name, lookup] of chain) {
        try {
          listeners.set(port, await lookup(port));
          methodsUsed.add(name);
          return;
        } catch {
          // try the next method
        }
      }
    })
  );

  const unchecked = validPorts.filter((port) => !listeners.has(port));
  const detectionAvailable = validPorts.length === 0 || unchecked.length < validPorts.length;
  const running: ServiceInfo[] = [];
  const missing: number[] = [];

  for (const port of ports) {
    if (!listeners.has(port)) continue; // unchecked
    const listener = listeners.get(port);
    if (!listener) {
      missing.push(port);
      continue;
    }
    const [ownership, startedAt] = await Promise.all([
      checkOwnership(listener.pid, projectRoot),
      processStartTime(listener.pid),
    ]);
    running.push({
      port,
      pid: listener.pid,
      name: listener.name,
      process_cwd: ownership.cwd,
      owned_by_project: ownership.owned,
      started_at: startedAt,
    });
  }

  return {
    running,
    expected_but_missing: missing,
    unchecked_ports: unchecked,
    detection_available: detectionAvailable,
    detection_method: methodsUsed.size > 0 ? [...methodsUsed].join(", ") : null,
  };
}
