import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { detectFramework, type FrameworkInfo } from "../detectors/frameworks.js";
import { detectRuntimes, versionMismatch, type RuntimeInfo } from "../detectors/runtimes.js";
import { diagnose, portsFromAddrInUse, type DiagnosisResult } from "../diagnosis/engine.js";
import { relativeTime, getRecentErrors, type ErrorEntry } from "./errors.js";
import {
  getRunningServices,
  settleDefaultPorts,
  type ProcessResult,
  type ServiceInfo,
} from "./processes.js";

const SNAPSHOT_ERROR_LIMIT = 10;
const DIAGNOSIS_WINDOW_MS = 60 * 60 * 1000;

export interface GitState {
  branch: string | null;
  detached: boolean;
  uncommitted_files: number;
  conflicted_files: number;
  ahead: number;
  behind: number;
  /** "merge", "rebase" or "cherry-pick" when one is in progress. */
  operation: string | null;
  last_commit: string | null;
  last_commit_message: string | null;
  last_commit_age: string | null;
}

export interface SessionSnapshot {
  diagnosis: DiagnosisResult;
  session: {
    project: string;
    path: string;
    framework: string;
    language: string;
    git: GitState | null;
  };
  services: {
    running: ServiceInfo[];
    expected_but_missing: number[];
    unchecked_ports: number[];
    expected_ports: number[];
    port_source: FrameworkInfo["portSource"];
    detection_available: boolean;
  };
  recent_errors: ErrorEntry[];
  log_files: string[];
  env: {
    node: string | null;
    python: string | null;
    go: string | null;
    package_manager: string;
    required_node: string | null;
    required_python: string | null;
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function getGitState(cwd: string): Promise<GitState | null> {
  const git = simpleGit({ baseDir: cwd, timeout: { block: 5000 } });
  let isRepo = false;
  try {
    isRepo = await git.checkIsRepo();
  } catch {
    return null;
  }
  if (!isRepo) return null;

  // status and log are independent: a repo with no commits makes `git log` fail,
  // which must not wipe out the branch and file counts.
  const [statusResult, logResult, gitDirResult] = await Promise.allSettled([
    git.status(),
    git.log({ maxCount: 1 }),
    git.revparse(["--absolute-git-dir"]),
  ]);

  const state: GitState = {
    branch: null,
    detached: false,
    uncommitted_files: 0,
    conflicted_files: 0,
    ahead: 0,
    behind: 0,
    operation: null,
    last_commit: null,
    last_commit_message: null,
    last_commit_age: null,
  };

  if (statusResult.status === "fulfilled") {
    const status = statusResult.value;
    state.branch = status.current || null;
    state.detached = status.detached;
    state.uncommitted_files = status.files.length;
    state.conflicted_files = status.conflicted.length;
    state.ahead = status.ahead;
    state.behind = status.behind;
  }
  if (logResult.status === "fulfilled" && logResult.value.latest) {
    const latest = logResult.value.latest;
    state.last_commit = latest.hash.slice(0, 7);
    state.last_commit_message = latest.message;
    const committed = Date.parse(latest.date);
    state.last_commit_age = Number.isNaN(committed) ? null : relativeTime(Date.now() - committed);
  }
  if (gitDirResult.status === "fulfilled") {
    const gitDir = gitDirResult.value.trim();
    if (await exists(path.join(gitDir, "MERGE_HEAD"))) state.operation = "merge";
    else if (
      (await exists(path.join(gitDir, "rebase-merge"))) ||
      (await exists(path.join(gitDir, "rebase-apply")))
    )
      state.operation = "rebase";
    else if (await exists(path.join(gitDir, "CHERRY_PICK_HEAD"))) state.operation = "cherry-pick";
  }
  return state;
}

/** True when package.json declares dependencies but no node_modules exists here or in a parent (workspaces). */
async function nodeDependenciesMissing(cwd: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    const count =
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    if (count === 0) return false;
  } catch {
    return false;
  }
  if (await exists(path.join(cwd, ".pnp.cjs"))) return false; // Yarn Plug'n'Play
  let dir = path.resolve(cwd);
  for (let i = 0; i < 5; i++) {
    if (await exists(path.join(dir, "node_modules"))) return false;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return true;
}

function runtimeIssues(framework: FrameworkInfo, runtimes: RuntimeInfo): string[] {
  const issues: string[] = [];
  if (framework.language === "node" && versionMismatch(runtimes.node, runtimes.required.node)) {
    issues.push(`Node ${runtimes.node} found, but the project asks for ${runtimes.required.node}`);
  }
  if (framework.language === "python" && versionMismatch(runtimes.python, runtimes.required.python)) {
    issues.push(`Python ${runtimes.python} found, but the project asks for ${runtimes.required.python}`);
  }
  return issues;
}

async function probePorts(
  root: string,
  expected: number[],
  recentErrors: ErrorEntry[]
): Promise<ProcessResult> {
  const logPorts = portsFromAddrInUse(recentErrors.map((e) => e.message));
  const ports = [...new Set([...expected, ...logPorts])];
  try {
    return await getRunningServices(ports, root);
  } catch {
    return {
      running: [],
      expected_but_missing: [],
      unchecked_ports: ports,
      detection_available: false,
      detection_method: null,
    };
  }
}

export async function getSessionSnapshot(cwd: string): Promise<SessionSnapshot> {
  const root = path.resolve(cwd);
  const framework = await detectFramework(root);

  const expected = framework.expectedPorts;
  const errorsPromise = getRecentErrors(root, framework.logPaths, 200).catch(() => ({
    errors: [] as ErrorEntry[],
    log_files: [] as string[],
  }));
  // Old log lines shouldn't decide today's verdict; they're still listed below.
  const recentOf = (entries: ErrorEntry[]) =>
    entries.filter((e) => Date.now() - Date.parse(e.at) <= DIAGNOSIS_WINDOW_MS);

  const [runtimes, probe, errors, git, depsMissing] = await Promise.all([
    detectRuntimes(root),
    // Probe the expected ports plus any port a recent EADDRINUSE names, so a
    // conflict on a non-default port can be confirmed (or the port shown free).
    errorsPromise.then((result) => probePorts(root, expected, recentOf(result.errors))),
    errorsPromise,
    getGitState(root).catch(() => null),
    framework.language === "node" ? nodeDependenciesMissing(root) : Promise.resolve(false),
  ]);

  // Expected-port view (what "missing" means), settled for framework defaults.
  const services = settleDefaultPorts(
    {
      ...probe,
      running: probe.running.filter((s) => expected.includes(s.port)),
      expected_but_missing: probe.expected_but_missing.filter((p) => expected.includes(p)),
      unchecked_ports: probe.unchecked_ports.filter((p) => expected.includes(p)),
    },
    framework.portSource
  );

  const diagnosis = diagnose({
    cwd: root,
    projectDetected: framework.projectDetected,
    framework: framework.framework,
    portSource: framework.portSource,
    // All listeners, including holders of EADDRINUSE ports outside the expected set.
    running: probe.running,
    expectedPorts: expected,
    expected_but_missing: services.expected_but_missing,
    freePorts: probe.expected_but_missing,
    uncheckedPorts: services.unchecked_ports,
    detectionAvailable: probe.detection_available,
    recentErrors: recentOf(errors.errors),
    conflictedFiles: git?.conflicted_files ?? 0,
    gitOperation: git?.operation ?? null,
    dependenciesMissing: depsMissing
      ? { packageManager: runtimes.packageManager === "unknown" ? "npm" : runtimes.packageManager }
      : null,
    runtimeIssues: runtimeIssues(framework, runtimes),
  });

  return {
    diagnosis,
    session: {
      project: path.basename(root),
      path: root,
      framework: framework.framework,
      language: framework.language,
      git,
    },
    services: {
      // Includes holders of ports named in recent EADDRINUSE lines.
      running: probe.running,
      expected_but_missing: services.expected_but_missing,
      unchecked_ports: services.unchecked_ports,
      expected_ports: framework.expectedPorts,
      port_source: framework.portSource,
      detection_available: services.detection_available,
    },
    recent_errors: errors.errors.slice(-SNAPSHOT_ERROR_LIMIT),
    log_files: errors.log_files,
    env: {
      node: runtimes.node,
      python: runtimes.python,
      go: runtimes.go,
      package_manager: runtimes.packageManager,
      required_node: runtimes.required.node,
      required_python: runtimes.required.python,
    },
  };
}
