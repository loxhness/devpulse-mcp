import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getGitState, getSessionSnapshot } from "../src/tools/snapshot.js";
import { makeProject } from "./helpers.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdio: "ignore",
  });
}

describe("getGitState", () => {
  it("keeps the branch in a repo with no commits (regression: git log failure wiped it)", async () => {
    const dir = makeProject({ "a.txt": "x" });
    git(dir, "init");
    const state = await getGitState(dir);
    expect(state?.branch).toBe("main");
    expect(state?.uncommitted_files).toBe(1);
    expect(state?.last_commit).toBeNull();
  });

  it("reports the last commit's short hash, message and age", async () => {
    const dir = makeProject({ "a.txt": "x" });
    git(dir, "init");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "add auth flow");
    const state = await getGitState(dir);
    expect(state?.last_commit).toMatch(/^[0-9a-f]{7}$/);
    expect(state?.last_commit_message).toBe("add auth flow");
    expect(state?.last_commit_age).toBe("just now");
    expect(state?.operation).toBeNull();
  });

  it("returns null outside a git repo", async () => {
    // tmpdir itself isn't a repo in CI or on dev machines.
    expect(await getGitState(makeProject())).toBeNull();
  });
});

let held: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (held ? held.close(() => r()) : r()));
  held = null;
});

/** Holds a free port in a dev-like range (3100-3999) from this test process. */
async function holdDevPort(): Promise<number> {
  for (let port = 3100; port < 4000; port++) {
    const server = createServer();
    const ok = await new Promise<boolean>((r) => {
      server.once("error", () => r(false));
      server.listen(port, "127.0.0.1", () => r(true));
    });
    if (ok) {
      held = server;
      return port;
    }
  }
  throw new Error("no free port in 3100-3999");
}

describe("getSessionSnapshot", () => {
  it("probes the port named in a recent EADDRINUSE even when it isn't an expected port", async () => {
    const port = await holdDevPort();
    const dir = makeProject({
      "package.json": JSON.stringify({ dependencies: {} }), // expects 3000/5173/8080
      "logs/app.log": `${new Date().toISOString()} Error: listen EADDRINUSE: address already in use :::${port}
`,
    });
    const result = await getSessionSnapshot(dir);
    if (!result.services.detection_available) return; // nothing can check ports here
    expect(result.services.running.map((s) => s.port)).toContain(port);
    expect(result.services.expected_but_missing).not.toContain(port);
    expect(result.diagnosis.suggested_action ?? "").not.toMatch(/free now/i);
  });


  it("says no project was detected for an empty directory", async () => {
    const dir = makeProject();
    const result = await getSessionSnapshot(dir);
    expect(result.diagnosis.health).toBe("unknown");
    expect(result.diagnosis.primary_issue).toContain("No project detected");
  });

  it("does not throw on a non-existent directory", async () => {
    const result = await getSessionSnapshot("/this/path/does/not/exist/anywhere");
    expect(result.diagnosis.health).toBe("unknown");
  });

  it("flags missing node_modules for a Node project with dependencies", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "pnpm-lock.yaml": "",
    });
    const result = await getSessionSnapshot(dir);
    expect(result.diagnosis.health).toBe("broken");
    expect(result.diagnosis.suggested_action).toContain("pnpm install");
  });

  it("surfaces log errors from logs/ in the snapshot", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "logs/app.log": "Error: listen EADDRINUSE: address already in use :::3000\n",
    });
    const result = await getSessionSnapshot(dir);
    expect(result.recent_errors).toHaveLength(1);
    expect(result.log_files).toHaveLength(1);
  });
});
