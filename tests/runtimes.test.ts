import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRuntimes, versionMismatch } from "../src/detectors/runtimes.js";
import { makeProject } from "./helpers.js";

describe("detectRuntimes", () => {
  it("returns the expected shape", async () => {
    const result = await detectRuntimes(resolve("."));
    expect(result.node).toMatch(/^\d+\.\d+\.\d+$/); // tests run under Node
    expect(["npm", "yarn", "pnpm", "bun", "unknown"]).toContain(result.packageManager);
    expect(result.required).toBeDefined();
  });

  it("detects bun from the text lockfile (Bun 1.2+)", async () => {
    const dir = makeProject({ "bun.lock": "{}" });
    expect((await detectRuntimes(dir)).packageManager).toBe("bun");
  });

  it("reads required versions from .nvmrc and .python-version", async () => {
    const dir = makeProject({ ".nvmrc": "v20.11.0\n", ".python-version": "3.12\n" });
    expect((await detectRuntimes(dir)).required).toEqual({ node: "20.11.0", python: "3.12" });
  });

  it("falls back to engines.node", async () => {
    const dir = makeProject({ "package.json": JSON.stringify({ engines: { node: ">=18" } }) });
    expect((await detectRuntimes(dir)).required.node).toBe(">=18");
  });
});

describe("versionMismatch", () => {
  it.each([
    ["20.11.0", "20", false],
    ["22.1.0", "20", true],
    ["20.11.0", "20.11.0", false],
    ["20.10.0", "20.11", true],
    ["22.1.0", ">=18", false],
    ["16.20.0", ">=18", true],
    ["20.5.0", "^20.1.0", false],
    ["20.11.0", "lts/iron", null],
    [null, "20", null],
    ["20.11.0", null, null],
  ])("installed %s, required %s -> %s", (installed, required, expected) => {
    expect(versionMismatch(installed, required)).toBe(expected);
  });
});
