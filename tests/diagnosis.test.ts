import { describe, expect, it } from "vitest";
import { diagnose, portsFromAddrInUse, type DiagnosisInput } from "../src/diagnosis/engine.js";

function input(overrides: Partial<DiagnosisInput>): DiagnosisInput {
  return {
    cwd: "/work/app",
    projectDetected: true,
    framework: "nextjs",
    portSource: "default",
    running: [],
    expected_but_missing: [],
    detectionAvailable: true,
    recentErrors: [],
    ...overrides,
  };
}

const own = { port: 3000, pid: 10, name: "node", owned_by_project: true as const };
const foreign = {
  port: 3000,
  pid: 99,
  name: "node",
  process_cwd: "/work/other-app",
  owned_by_project: false as const,
};
const addrInUse = { level: "ERROR", message: "Error: listen EADDRINUSE: address already in use :::3000" };

describe("diagnose", () => {
  it("no project detected -> unknown, tells the agent to pass cwd", () => {
    const result = diagnose(input({ projectDetected: false }));
    expect(result.health).toBe("unknown");
    expect(result.primary_issue).toContain("/work/app");
    expect(result.suggested_action).toContain("cwd");
  });

  it("port conflict (regression): EADDRINUSE logged and a foreign process holds the port -> broken/high", () => {
    const result = diagnose(input({ running: [foreign], recentErrors: [addrInUse] }));
    expect(result.health).toBe("broken");
    expect(result.confidence).toBe("high");
    expect(result.primary_issue).toContain("Port conflict");
    expect(result.secondary_signals[0]).toContain("pid 99");
    expect(result.secondary_signals[0]).toContain("/work/other-app");
  });

  it("foreign process on the port with no log evidence -> broken/medium", () => {
    const result = diagnose(input({ running: [foreign] }));
    expect(result.health).toBe("broken");
    expect(result.confidence).toBe("medium");
  });

  it("EADDRINUSE logged but the port is free now -> broken, suggests restart", () => {
    const result = diagnose(input({ expected_but_missing: [3000], recentErrors: [addrInUse] }));
    expect(result.health).toBe("broken");
    expect(result.primary_issue).toContain("3000");
    expect(result.suggested_action).toContain("restart");
  });

  it("only says a port is free now when it was probed and found free", () => {
    const on4000 = { level: "ERROR", message: "Error: listen EADDRINUSE: address already in use :::4000" };
    const notProbed = diagnose(
      input({ expected_but_missing: [3000], freePorts: [3000], recentErrors: [on4000] })
    );
    expect(notProbed.health).toBe("broken");
    expect(JSON.stringify(notProbed)).not.toMatch(/free now/i);

    const probedFree = diagnose(
      input({ expected_but_missing: [3000], freePorts: [3000, 4000], recentErrors: [on4000] })
    );
    expect(probedFree.suggested_action).toMatch(/4000 appears free now/);
  });

  it("EADDRINUSE without a port number never claims the port is free", () => {
    const result = diagnose(
      input({ expected_but_missing: [3000], recentErrors: [{ level: "ERROR", message: "OSError: [Errno 98] Address already in use" }] })
    );
    expect(result.health).toBe("broken");
    expect(JSON.stringify(result)).not.toMatch(/free now/i);
  });

  describe("EADDRINUSE on a port that is occupied now", () => {
    const errorAt = "2026-11-12T10:00:00.000Z";
    const loggedAt = { ...addrInUse, at: errorAt };
    const before = "2026-11-12T09:30:00.000Z";
    const after = "2026-11-12T10:05:00.000Z";

    it("ownership unknown -> conflict/medium naming the process", () => {
      const result = diagnose(input({ running: [{ ...own, owned_by_project: null }], recentErrors: [loggedAt] }));
      expect(result).toMatchObject({ health: "broken", confidence: "medium" });
      expect(result.primary_issue).toBe(
        "Port 3000 is in use by node (pid 10); devpulse can't tell whose process it is"
      );
    });

    it("own process started before the error -> earlier instance still running, broken/medium", () => {
      const result = diagnose(input({ running: [{ ...own, started_at: before }], recentErrors: [loggedAt] }));
      expect(result).toMatchObject({ health: "broken", confidence: "medium" });
      expect(result.primary_issue).toBe(
        "An earlier instance of this project is still running on port 3000; the new one couldn't start"
      );
      expect(result.suggested_action).toContain("pid 10");
    });

    it("own process started after the error -> stale error, no conflict (current logic)", () => {
      const result = diagnose(input({ running: [{ ...own, started_at: after }], recentErrors: [loggedAt] }));
      expect(result.health).toBe("degraded");
      expect(result.primary_issue).toBe("Dev server is running but errors were logged");
    });

    it("own process with unknown start time -> conflict/low", () => {
      const result = diagnose(input({ running: [{ ...own, started_at: null }], recentErrors: [loggedAt] }));
      expect(result).toMatchObject({ health: "broken", confidence: "low" });
      expect(result.primary_issue).toContain("port 3000");
    });

    it("own process but the error line has no timestamp -> conflict/low", () => {
      const result = diagnose(input({ running: [{ ...own, started_at: before }], recentErrors: [addrInUse] }));
      expect(result).toMatchObject({ health: "broken", confidence: "low" });
    });

    it("holder on a non-expected port named by the log still counts as a conflict", () => {
      const holder = { port: 4000, pid: 5, name: "python", owned_by_project: null };
      const result = diagnose(
        input({
          expectedPorts: [3000],
          running: [holder],
          expected_but_missing: [3000],
          recentErrors: [{ level: "ERROR", message: "listen EADDRINUSE: address already in use :::4000", at: errorAt }],
        })
      );
      expect(result.health).toBe("broken");
      expect(result.primary_issue).toContain("Port 4000 is in use by python (pid 5)");
    });
  });

  it("server down with errors -> crashed", () => {
    const result = diagnose(
      input({ expected_but_missing: [5173], recentErrors: [{ level: "ERROR", message: "Unhandled exception" }] })
    );
    expect(result).toMatchObject({ health: "broken", confidence: "medium" });
    expect(result.primary_issue).toContain("crashed");
  });

  it("server down without errors -> not running", () => {
    const result = diagnose(input({ expected_but_missing: [8080] }));
    expect(result).toMatchObject({ health: "degraded", primary_issue: "Dev server is not running" });
  });

  it("server up with errors -> degraded", () => {
    const result = diagnose(
      input({ running: [own], recentErrors: [{ level: "ERROR", message: "DB connection timeout" }] })
    );
    expect(result.health).toBe("degraded");
    expect(result.secondary_signals).toContain("DB connection timeout");
  });

  it("server up, owned, no errors -> healthy/high", () => {
    expect(diagnose(input({ running: [own] }))).toMatchObject({ health: "healthy", confidence: "high" });
  });

  it("server up with only warnings -> healthy/medium, warnings listed", () => {
    const result = diagnose(
      input({ running: [own], recentErrors: [{ level: "WARN", message: "DeprecationWarning: punycode" }] })
    );
    expect(result).toMatchObject({ health: "healthy", confidence: "medium" });
    expect(result.secondary_signals).toContain("Warning: DeprecationWarning: punycode");
  });

  it("ownership unknown (e.g. Windows) -> healthy/medium", () => {
    const result = diagnose(input({ running: [{ ...own, owned_by_project: null }] }));
    expect(result).toMatchObject({ health: "healthy", confidence: "medium" });
  });

  it("config ports: every configured port must be up", () => {
    const result = diagnose(input({ portSource: "config", running: [own], expected_but_missing: [4000] }));
    expect(result.health).toBe("degraded");
  });

  it("port detection unavailable never claims nothing is listening", () => {
    const quiet = diagnose(input({ detectionAvailable: false }));
    expect(quiet.health).toBe("unknown");
    expect(quiet.primary_issue).toContain("Could not check");
    const noisy = diagnose(
      input({ detectionAvailable: false, recentErrors: [{ level: "ERROR", message: "boom" }] })
    );
    expect(noisy.health).toBe("degraded");
  });

  it("never claims nothing is listening on an unchecked port", () => {
    const result = diagnose(input({ expected_but_missing: [8080], uncheckedPorts: [3000] }));
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/Nothing is listening on (port )?3000/);
    expect(result.health).toBe("unknown");
    expect(text).toContain("3000");
    expect(result.secondary_signals.join(" ")).toContain("Could not check port 3000");
  });

  it("crash diagnosis flags unchecked ports instead of calling them free", () => {
    const result = diagnose(
      input({ uncheckedPorts: [3000], recentErrors: [{ level: "ERROR", message: "Unhandled exception" }] })
    );
    expect(result.secondary_signals).toContain("Could not check port 3000");
    expect(JSON.stringify(result)).not.toMatch(/Nothing is listening on (port )?3000/);
  });

  it("projects with no dev server port are healthy when there are no errors", () => {
    expect(diagnose(input({ portSource: "none" })).health).toBe("healthy");
  });

  it("merge conflicts take priority", () => {
    const result = diagnose(input({ running: [own], conflictedFiles: 2, gitOperation: "rebase" }));
    expect(result).toMatchObject({ health: "broken", confidence: "high" });
    expect(result.secondary_signals[0]).toContain("rebase");
  });

  it("missing node_modules -> broken with the right install command", () => {
    const result = diagnose(input({ dependenciesMissing: { packageManager: "pnpm" } }));
    expect(result.health).toBe("broken");
    expect(result.suggested_action).toContain("pnpm install");
  });

  it("runtime mismatches are added as signals without changing the verdict", () => {
    const result = diagnose(input({ running: [own], runtimeIssues: ["Node 18.0.0 found, but the project asks for 20"] }));
    expect(result.health).toBe("healthy");
    expect(result.secondary_signals).toContain("Node 18.0.0 found, but the project asks for 20");
  });
});

describe("portsFromAddrInUse", () => {
  it.each([
    ["listen EADDRINUSE: address already in use :::3000", [3000]],
    ["Error: listen EADDRINUSE: address already in use 127.0.0.1:5173", [5173]],
    ["OSError: [Errno 98] Address already in use", []],
    ["unrelated error on port 3000", []],
  ])("%s", (message, ports) => {
    expect(portsFromAddrInUse([message])).toEqual(ports);
  });
});
