import { utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLine, collectLogFiles, getRecentErrors } from "../src/tools/errors.js";
import { makeProject } from "./helpers.js";

describe("classifyLine", () => {
  it.each([
    ["Error: listen EADDRINUSE: address already in use :::3000", "ERROR"],
    ["TypeError: Cannot read properties of undefined", "ERROR"],
    ["npm ERR! code ELIFECYCLE", "ERROR"],
    ["Unhandled promise rejection", "ERROR"],
    ["Traceback (most recent call last):", "ERROR"],
    ["Found 3 errors in 2 files.", "ERROR"],
    ["[warn] slow query", "WARN"],
    ["(node:123) DeprecationWarning: Buffer() is deprecated", "WARN"],
    ["Compiled with 3 warnings", "WARN"],
    ["warnings: unused import in src/app.ts", "WARN"],
    ["2 warnings generated.", "WARN"],
    ["Found errors in 2 files", "ERROR"],
  ])("%s -> %s", (line, level) => {
    expect(classifyLine(line)).toBe(level);
  });

  it.each([
    "0 errors, 0 warnings",
    "no warnings",
    "Build finished with no warnings.",
    "warningsAsErrors=false",
    "Compiled successfully. No errors found.",
    "registered errorHandler middleware",
    "GET /api/users 200 12ms",
  ])("ignores: %s", (line) => {
    expect(classifyLine(line)).toBeNull();
  });
});

describe("collectLogFiles", () => {
  it("finds .log files inside log directories and at the project root", async () => {
    const dir = makeProject({
      "logs/app.log": "x",
      "logs/nested/worker.log": "x",
      "log/server.log": "x",
      "npm-debug.log": "x",
      "src/deep/ignored.log": "x",
      "node_modules/pkg/logs/ignored.log": "x",
      "logs/readme.txt": "x",
    });
    const files = (await collectLogFiles(dir, ["logs", "log", "."])).map((f) => f.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("logs/app.log"))).toBe(true);
    expect(files.some((f) => f.endsWith("logs/nested/worker.log"))).toBe(true);
    expect(files.some((f) => f.endsWith("log/server.log"))).toBe(true);
    expect(files.some((f) => f.endsWith("npm-debug.log"))).toBe(true);
    expect(files.some((f) => f.includes("ignored"))).toBe(false);
    expect(files.some((f) => f.endsWith("readme.txt"))).toBe(false);
  });

  it("accepts a direct file path", async () => {
    const dir = makeProject({ "custom/output.log": "x" });
    expect(await collectLogFiles(dir, ["custom/output.log"])).toHaveLength(1);
  });
});

describe("getRecentErrors", () => {
  it("reads errors from a logs/ directory (regression: directories were skipped)", async () => {
    const dir = makeProject({
      "logs/app.log": "info boot\nError: listen EADDRINUSE: address already in use :::3000\n",
    });
    const result = await getRecentErrors(dir, ["logs"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("EADDRINUSE");
    expect(result.errors[0].source).toBe(join("logs", "app.log"));
    expect(result.log_files).toEqual([join("logs", "app.log")]);
  });

  it("groups Node stack traces under the error and keeps file paths intact", async () => {
    const dir = makeProject({
      "logs/app.log": [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at getUser (/app/src/db/user.service.ts:40:12)",
        "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
        "GET /health 200",
      ].join("\n"),
    });
    const [entry] = (await getRecentErrors(dir, ["logs"])).errors;
    expect(entry.level).toBe("ERROR");
    expect(entry.stack).toHaveLength(2);
    expect(entry.stack?.[0]).toContain("src/db/user.service.ts:40:12");
  });

  it("joins a Python traceback with its final exception line", async () => {
    const dir = makeProject({
      "logs/api.log": [
        "Traceback (most recent call last):",
        '  File "/app/main.py", line 12, in handler',
        "    return items[5]",
        "IndexError: list index out of range",
        "INFO: 127.0.0.1 - GET / 200",
      ].join("\n"),
    });
    const { errors } = await getRecentErrors(dir, ["logs"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("IndexError: list index out of range");
    expect(errors[0].stack?.length).toBeGreaterThan(0);
  });

  it("uses timestamps from the log line instead of the file's mtime", async () => {
    const dir = makeProject({
      "logs/app.log": "2026-01-02T03:04:05Z ERROR database unreachable\n",
    });
    const [entry] = (await getRecentErrors(dir, ["logs"])).errors;
    expect(entry.at).toBe("2026-01-02T03:04:05.000Z");
  });

  it("falls back to the file's mtime when lines have no timestamp", async () => {
    const dir = makeProject({ "logs/app.log": "ERROR something broke\n" });
    const mtime = new Date("2026-03-04T05:06:07Z");
    utimesSync(join(dir, "logs/app.log"), mtime, mtime);
    const [entry] = (await getRecentErrors(dir, ["logs"])).errors;
    expect(entry.at).toBe(mtime.toISOString());
  });

  it("dedupes repeated messages and counts them", async () => {
    const dir = makeProject({
      "logs/app.log": "ERROR retry failed\nERROR retry failed\nERROR retry failed\n",
    });
    const { errors } = await getRecentErrors(dir, ["logs"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].count).toBe(3);
  });

  it("only reads the tail of very large files", async () => {
    const filler = "INFO ok\n".repeat(80_000); // ~640 KB
    const dir = makeProject({
      "logs/app.log": `ERROR old problem at the start\n${filler}ERROR new problem at the end\n`,
    });
    const { errors } = await getRecentErrors(dir, ["logs"]);
    expect(errors.map((e) => e.message)).toEqual(["ERROR new problem at the end"]);
  });

  it("respects the limit and keeps the newest entries", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `2026-01-01T00:00:${String(i).padStart(2, "0")}Z ERROR e${i}`);
    const dir = makeProject({ "logs/app.log": lines.join("\n") });
    const { errors } = await getRecentErrors(dir, ["logs"], 5);
    expect(errors).toHaveLength(5);
    expect(errors[4].message).toContain("e29");
  });

  it("redacts secrets in messages and stack lines", async () => {
    const dir = makeProject({
      "logs/app.log": "ERROR auth failed with Bearer abc123secret\n    at call (https://user:pw123456@host/x:1:1)\n",
    });
    const [entry] = (await getRecentErrors(dir, ["logs"])).errors;
    expect(entry.message).not.toContain("abc123secret");
    expect(entry.stack?.[0]).not.toContain("pw123456");
  });

  it("returns empty results without throwing when there are no logs", async () => {
    const dir = makeProject();
    await expect(getRecentErrors(dir, ["logs", "."])).resolves.toEqual({ errors: [], log_files: [] });
    await expect(getRecentErrors(dir, [])).resolves.toEqual({ errors: [], log_files: [] });
  });
});
