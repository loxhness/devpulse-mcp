export type HealthStatus = "healthy" | "degraded" | "broken" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface DiagnosisService {
  port: number;
  pid: number | null;
  name: string;
  process_cwd?: string | null;
  owned_by_project: boolean | null;
}

export interface DiagnosisInput {
  cwd?: string;
  projectDetected?: boolean;
  framework: string;
  portSource?: "config" | "default" | "none";
  running: DiagnosisService[];
  expected_but_missing: number[];
  detectionAvailable?: boolean;
  recentErrors: Array<{ level: string; message: string }>;
  conflictedFiles?: number;
  gitOperation?: string | null;
  dependenciesMissing?: { packageManager: string } | null;
  runtimeIssues?: string[];
}

export interface DiagnosisResult {
  health: HealthStatus;
  primary_issue: string | null;
  secondary_signals: string[];
  suggested_action: string | null;
  confidence: Confidence;
}

const ADDR_IN_USE_RE = /EADDRINUSE|address already in use/i;

/** Ports named in "address in use" errors, e.g. "listen EADDRINUSE: address already in use :::3000". */
export function portsFromAddrInUse(messages: string[]): number[] {
  const ports = new Set<number>();
  for (const message of messages) {
    if (!ADDR_IN_USE_RE.test(message)) continue;
    const match = message.match(/(?:EADDRINUSE|address already in use)[^\n]*?(?::|port\s)(\d{2,5})\b/i);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

function describe(service: DiagnosisService): string {
  const who = service.pid !== null ? `${service.name} (pid ${service.pid})` : service.name;
  const where = service.process_cwd ? `, started from ${service.process_cwd}` : "";
  return `Port ${service.port} is held by ${who}${where}`;
}

function topErrors(errors: Array<{ level: string; message: string }>): string[] {
  return errors.filter((e) => e.level.toUpperCase() === "ERROR").slice(-3).map((e) => e.message);
}

function core(input: DiagnosisInput): DiagnosisResult {
  const running = input.running ?? [];
  const missing = input.expected_but_missing ?? [];
  const errors = input.recentErrors ?? [];
  const errorEntries = errors.filter((e) => e.level.toUpperCase() === "ERROR");
  const detectionAvailable = input.detectionAvailable ?? true;

  // 0. Nothing to diagnose.
  if (input.projectDetected === false) {
    return {
      health: "unknown",
      primary_issue: `No project detected at ${input.cwd ?? "the current directory"}`,
      secondary_signals: [
        "No package.json, pyproject.toml, requirements.txt, .csproj, go.mod or Cargo.toml found",
      ],
      suggested_action: "Call again with `cwd` set to the project's root directory",
      confidence: "high",
    };
  }

  // 1. Merge conflicts break builds regardless of anything else.
  if ((input.conflictedFiles ?? 0) > 0) {
    return {
      health: "broken",
      primary_issue: `Unresolved merge conflicts in ${input.conflictedFiles} file(s)`,
      secondary_signals: input.gitOperation ? [`A git ${input.gitOperation} is in progress`] : [],
      suggested_action: "Resolve the conflicts (git status lists them), then rerun the dev server",
      confidence: "high",
    };
  }

  // 2. Dependencies not installed.
  if (input.dependenciesMissing) {
    return {
      health: "broken",
      primary_issue: "Dependencies are not installed (node_modules is missing)",
      secondary_signals: topErrors(errors),
      suggested_action: `Run \`${input.dependenciesMissing.packageManager} install\``,
      confidence: "high",
    };
  }

  const up = running.filter((s) => s.owned_by_project !== false);
  const foreign = running.filter((s) => s.owned_by_project === false);
  const addrInUseLogged = errors.some((e) => ADDR_IN_USE_RE.test(e.message));
  const loggedPorts = portsFromAddrInUse(errors.map((e) => e.message));

  // 3. Port conflicts.
  if (foreign.length > 0 && up.length === 0) {
    const corroborated =
      addrInUseLogged && (loggedPorts.length === 0 || foreign.some((s) => loggedPorts.includes(s.port)));
    return {
      health: "broken",
      primary_issue: "Port conflict: another process is using this project's dev server port",
      secondary_signals: foreign.map(describe),
      suggested_action:
        "Stop the other process (it belongs to a different directory) or run this dev server on a different port",
      confidence: corroborated ? "high" : "medium",
    };
  }
  if (addrInUseLogged && up.length === 0 && detectionAvailable) {
    const ports = loggedPorts.length > 0 ? loggedPorts.join(", ") : "its port";
    return {
      health: "broken",
      primary_issue: `Dev server failed to start: ${ports} was already in use`,
      secondary_signals: [
        ...(missing.length > 0 ? [`Nothing is listening on ${missing.join(", ")} now`] : []),
        ...topErrors(errors),
      ],
      suggested_action: "The port appears free now; restart the dev server",
      confidence: "medium",
    };
  }

  // 4. Can't check ports on this machine.
  if (!detectionAvailable) {
    return errorEntries.length > 0
      ? {
          health: "degraded",
          primary_issue: "Errors found in the logs (port status unavailable on this machine)",
          secondary_signals: topErrors(errors),
          suggested_action: "Review the recent errors",
          confidence: "medium",
        }
      : {
          health: "unknown",
          primary_issue: "Could not check which ports are in use on this machine",
          secondary_signals: ["Install `ss` or `lsof` to enable service detection"],
          suggested_action: null,
          confidence: "low",
        };
  }

  const expectsServer = (input.portSource ?? "default") !== "none";

  // 5. Project without a dev server (library, CLI, console app).
  if (!expectsServer) {
    return errorEntries.length > 0
      ? {
          health: "degraded",
          primary_issue: "Errors found in the logs",
          secondary_signals: topErrors(errors),
          suggested_action: "Review the recent errors",
          confidence: "medium",
        }
      : {
          health: "healthy",
          primary_issue: null,
          secondary_signals: ["No dev server port is expected for this project type"],
          suggested_action: null,
          confidence: "low",
        };
  }

  // With ports read from config, every port must be up; with defaults, any one is enough.
  const serverUp =
    input.portSource === "config" ? up.length > 0 && missing.length === 0 : up.length > 0;

  // 6. Crashed.
  if (!serverUp && errorEntries.length > 0) {
    return {
      health: "broken",
      primary_issue: "Dev server appears to have crashed",
      secondary_signals: topErrors(errors),
      suggested_action: "Fix the error above, then restart the dev server",
      confidence: "medium",
    };
  }

  // 7. Not running, no errors.
  if (!serverUp) {
    return {
      health: "degraded",
      primary_issue: "Dev server is not running",
      secondary_signals: missing.map((port) => `Nothing is listening on port ${port}`),
      suggested_action: "Start the dev server",
      confidence: "medium",
    };
  }

  // 8. Running with errors.
  if (errorEntries.length > 0) {
    return {
      health: "degraded",
      primary_issue: "Dev server is running but errors were logged",
      secondary_signals: topErrors(errors),
      suggested_action: "Review the recent errors; the server is up but something is failing",
      confidence: "medium",
    };
  }

  // 9. Healthy.
  const ownershipKnown = up.every((s) => s.owned_by_project === true);
  return {
    health: "healthy",
    primary_issue: null,
    secondary_signals: up.map((s) => `Port ${s.port}: ${s.name}${s.pid !== null ? ` (pid ${s.pid})` : ""}`),
    suggested_action: null,
    confidence: ownershipKnown ? "high" : "medium",
  };
}

export function diagnose(input: DiagnosisInput): DiagnosisResult {
  const result = core(input);
  const runtimeIssues = input.runtimeIssues ?? [];
  // Runtime versions are read from the environment devpulse runs in, which can
  // differ from the user's shell (nvm, pyenv), so they are signals, not verdicts.
  if (runtimeIssues.length === 0 || result.health === "unknown") return result;
  return { ...result, secondary_signals: [...result.secondary_signals, ...runtimeIssues] };
}
