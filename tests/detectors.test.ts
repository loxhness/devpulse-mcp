import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectFramework,
  portsFromLaunchSettings,
  portsFromScript,
} from "../src/detectors/frameworks.js";
import { makeProject } from "./helpers.js";

const fixture = (name: string) => resolve("tests", "fixtures", name);

describe("detectFramework: fixtures", () => {
  it("nextjs", async () => {
    const info = await detectFramework(fixture("nextjs"));
    expect(info).toMatchObject({ framework: "nextjs", language: "node", projectDetected: true });
    expect(info.expectedPorts).toEqual([3000]);
    expect(info.portSource).toBe("default");
  });

  it("vite", async () => {
    const info = await detectFramework(fixture("vite"));
    expect(info.framework).toBe("vite");
    expect(info.expectedPorts).toEqual([5173]);
  });

  it("express", async () => {
    expect((await detectFramework(fixture("express"))).framework).toBe("express");
  });

  it("fastapi from pyproject.toml (no package.json)", async () => {
    const info = await detectFramework(fixture("fastapi"));
    expect(info).toMatchObject({ framework: "fastapi", language: "python", expectedPorts: [8000] });
  });

  it("aspnetcore with ports from launchSettings.json", async () => {
    const info = await detectFramework(fixture("aspnetcore"));
    expect(info).toMatchObject({ framework: "aspnetcore", language: "dotnet", portSource: "config" });
    expect(info.expectedPorts.sort()).toEqual([5123, 7123]);
  });

  it("a package.json with no known framework is still a Node project", async () => {
    const info = await detectFramework(fixture("empty"));
    expect(info).toMatchObject({ framework: "node", projectDetected: true });
  });

  it("a missing directory is unknown and does not throw", async () => {
    const info = await detectFramework(fixture("missing"));
    expect(info).toMatchObject({ framework: "unknown", projectDetected: false, expectedPorts: [] });
  });
});

describe("detectFramework: Python", () => {
  it("django via manage.py", async () => {
    const dir = makeProject({ "manage.py": "", "requirements.txt": "Django==5.0\n" });
    expect((await detectFramework(dir)).framework).toBe("django");
  });

  it("flask via requirements.txt", async () => {
    const dir = makeProject({ "requirements.txt": "flask==3.0\ngunicorn\n" });
    expect(await detectFramework(dir)).toMatchObject({ framework: "flask", expectedPorts: [5000] });
  });

  it("Flask extensions imply Flask; unrelated packages don't imply a framework", async () => {
    const dir = makeProject({ "requirements.txt": "flask-cors-helper-utils\n" });
    expect((await detectFramework(dir)).framework).toBe("flask");
    const other = makeProject({ "requirements.txt": "requests\n" });
    expect(await detectFramework(other)).toMatchObject({ framework: "python", portSource: "none" });
  });
});

describe("detectFramework: ports from config", () => {
  it("reads --port from the dev script", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ scripts: { dev: "vite --port 4100" }, devDependencies: { vite: "5" } }),
    });
    expect(await detectFramework(dir)).toMatchObject({ expectedPorts: [4100], portSource: "config" });
  });

  it("reads PORT from .env", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      ".env": "NODE_ENV=development\nPORT=4500\n",
    });
    expect(await detectFramework(dir)).toMatchObject({ expectedPorts: [4500], portSource: "config" });
  });

  it("reads server.port from vite.config.ts", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ devDependencies: { vite: "5" } }),
      "vite.config.ts": "export default defineConfig({ server: { host: true, port: 3333 } })",
    });
    expect(await detectFramework(dir)).toMatchObject({ expectedPorts: [3333], portSource: "config" });
  });
});

describe("port parsers", () => {
  it.each([
    ["next dev -p 4000", [4000]],
    ["vite --port=3001", [3001]],
    ["PORT=4000 node server.js", [4000]],
    ["uvicorn main:app --reload --port 8001", [8001]],
    ["node server.js", []],
    [undefined, []],
  ])("portsFromScript(%s)", (script, ports) => {
    expect(portsFromScript(script)).toEqual(ports);
  });

  it("portsFromLaunchSettings ignores IIS Express profiles and bad JSON", () => {
    expect(portsFromLaunchSettings("not json")).toEqual([]);
    expect(
      portsFromLaunchSettings(
        JSON.stringify({ profiles: { iis: { commandName: "IISExpress", applicationUrl: "http://localhost:1234" } } })
      )
    ).toEqual([]);
  });
});
