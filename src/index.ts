#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  RootsListChangedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { detectFramework } from "./detectors/frameworks.js";
import { getRecentErrors } from "./tools/errors.js";
import { getRunningServices, settleDefaultPorts } from "./tools/processes.js";
import { getSessionSnapshot } from "./tools/snapshot.js";
import { VERSION } from "./version.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CWD_PROPERTY = {
  type: "string",
  description:
    "Absolute path to the project root. Optional: defaults to the client's workspace root, or the server's working directory.",
} as const;

const TOOLS = [
  {
    name: "get_session_snapshot",
    title: "Dev environment snapshot",
    description:
      "Diagnoses the user's local dev environment in one call: health verdict with the likely cause and a suggested fix, framework, git state (branch, uncommitted and conflicted files), dev server ports and who holds them, the 10 most recent log errors, and runtime versions. Call this first whenever the user reports something broken, before asking them what's wrong. Use the other tools only to dig deeper.",
    inputSchema: { type: "object", properties: { cwd: CWD_PROPERTY }, additionalProperties: false },
    annotations: { title: "Dev environment snapshot", ...READ_ONLY },
  },
  {
    name: "get_recent_errors",
    title: "Recent log errors",
    description:
      "Returns ERROR and WARN entries from the project's .log files (logs/, log/ and the project root), with stack traces, timestamps and repeat counts. Secrets are redacted. Use this when the snapshot shows errors and you need more than its 10 most recent, or the full stack traces.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD_PROPERTY,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum number of entries to return, newest last. Default 50.",
        },
      },
      additionalProperties: false,
    },
    annotations: { title: "Recent log errors", ...READ_ONLY },
  },
  {
    name: "get_running_services",
    title: "Dev server ports",
    description:
      "Checks the ports this project's dev server should use (read from its config, or framework defaults) and reports which are listening, the process holding each, and whether that process belongs to this project. Use this to confirm a port conflict or check whether the dev server came back up after a restart, without rerunning the full snapshot.",
    inputSchema: { type: "object", properties: { cwd: CWD_PROPERTY }, additionalProperties: false },
    annotations: { title: "Dev server ports", ...READ_ONLY },
  },
];

const CwdArgs = z.object({ cwd: z.string().min(1).optional() }).strict();
const ErrorArgs = z
  .object({
    cwd: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const server = new Server(
  { name: "devpulse", version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      "devpulse inspects the user's local dev environment. When the user reports an error, a broken build or a server that won't start, call get_session_snapshot before asking them for context.",
  }
);

// ---------- Working directory resolution ----------

let cachedRoot: string | null | undefined;

async function clientRoot(): Promise<string | null> {
  if (cachedRoot !== undefined) return cachedRoot;
  cachedRoot = null;
  if (server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.listRoots(undefined, { timeout: 3000 });
      const fileRoot = roots.find((root) => root.uri.startsWith("file://"));
      if (fileRoot) cachedRoot = fileURLToPath(fileRoot.uri);
    } catch {
      // Client advertised roots but didn't answer; fall back to cwd.
    }
  }
  return cachedRoot;
}

server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  cachedRoot = undefined;
});

/**
 * Order: explicit `cwd` argument, the client's workspace root (MCP roots),
 * DEVPULSE_PROJECT_DIR (set by the Claude Desktop extension or by hand),
 * then the directory the server was launched from.
 */
async function resolveCwd(cwd: string | undefined): Promise<string> {
  const envDir = process.env.DEVPULSE_PROJECT_DIR?.trim() || null;
  const base = (await clientRoot()) ?? envDir ?? process.cwd();
  if (!cwd) return base;
  return isAbsolute(cwd) ? resolve(cwd) : resolve(base, cwd);
}

// ---------- Handlers ----------

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown, tool: string): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);
    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${tool}: ${issues.join("; ")}`);
  }
  return parsed.data;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_session_snapshot": {
      const { cwd } = parseArgs(CwdArgs, args, name);
      try {
        return ok(await getSessionSnapshot(await resolveCwd(cwd)));
      } catch (error) {
        return fail(`Failed to get session snapshot: ${String(error)}`);
      }
    }
    case "get_recent_errors": {
      const { cwd, limit } = parseArgs(ErrorArgs, args, name);
      try {
        const root = await resolveCwd(cwd);
        const framework = await detectFramework(root);
        return ok(await getRecentErrors(root, framework.logPaths, limit ?? 50));
      } catch (error) {
        return fail(`Failed to get recent errors: ${String(error)}`);
      }
    }
    case "get_running_services": {
      const { cwd } = parseArgs(CwdArgs, args, name);
      try {
        const root = await resolveCwd(cwd);
        const framework = await detectFramework(root);
        const services = settleDefaultPorts(
          await getRunningServices(framework.expectedPorts, root),
          framework.portSource
        );
        return ok({ ...services, expected_ports: framework.expectedPorts, port_source: framework.portSource });
      } catch (error) {
        return fail(`Failed to get running services: ${String(error)}`);
      }
    }
    default:
      // Per the MCP spec, unknown tools are a protocol error, not a tool result.
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  }
});

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`devpulse ${VERSION} MCP server running\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
