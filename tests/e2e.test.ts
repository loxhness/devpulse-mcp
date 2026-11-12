import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeProject } from "./helpers.js";

const repoRoot = resolve(__dirname, "..");
const entry = resolve(repoRoot, "dist", "index.js");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

let client: Client | null = null;

beforeAll(() => {
  // Always test the built server, exactly as npx runs it.
  execFileSync(process.execPath, [resolve(repoRoot, "node_modules", "typescript", "bin", "tsc")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  expect(existsSync(entry)).toBe(true);
}, 120_000);

afterEach(async () => {
  await client?.close();
  client = null;
});

async function connect(rootDir?: string): Promise<Client> {
  client = new Client(
    { name: "devpulse-e2e", version: "1.0.0" },
    { capabilities: rootDir ? { roots: { listChanged: true } } : {} }
  );
  if (rootDir) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(rootDir).href, name: "project" }],
    }));
  }
  // Launch from tmpdir, like Claude Desktop launches servers outside the project.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: tmpdir(),
    stderr: "ignore",
  });
  await client.connect(transport);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe("devpulse over stdio", () => {
  it("reports the package.json version", async () => {
    const c = await connect();
    expect(c.getServerVersion()?.version).toBe(pkg.version);
  });

  it("lists three read-only tools with described parameters", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_recent_errors",
      "get_running_services",
      "get_session_snapshot",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      const props = tool.inputSchema.properties as Record<string, { description?: string }>;
      for (const prop of Object.values(props)) expect(prop.description).toBeTruthy();
    }
  });

  it("uses the client's workspace root when cwd is omitted", async () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ dependencies: {} }),
      "logs/app.log": "Error: listen EADDRINUSE: address already in use :::3000\n",
    });
    const c = await connect(dir);
    const snapshot = parse(await c.callTool({ name: "get_session_snapshot", arguments: {} }));
    expect(snapshot.session.path).toBe(dir);
    expect(snapshot.recent_errors).toHaveLength(1);
  });

  it("accepts an explicit cwd for each tool", async () => {
    const dir = makeProject({ "package.json": JSON.stringify({ devDependencies: { vite: "5" } }) });
    const c = await connect();
    const errors = parse(await c.callTool({ name: "get_recent_errors", arguments: { cwd: dir, limit: 5 } }));
    expect(errors).toEqual({ errors: [], log_files: [] });
    const services = parse(await c.callTool({ name: "get_running_services", arguments: { cwd: dir } }));
    expect(services.expected_ports).toEqual([5173]);
  });

  it("rejects unknown tools and invalid arguments with protocol errors", async () => {
    const c = await connect();
    await expect(c.callTool({ name: "nope", arguments: {} })).rejects.toMatchObject({ code: -32602 });
    await expect(
      c.callTool({ name: "get_recent_errors", arguments: { limit: 0 } })
    ).rejects.toMatchObject({ code: -32602 });
  });
});
