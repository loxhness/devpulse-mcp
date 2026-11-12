import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Language = "node" | "python" | "dotnet" | "go" | "rust" | "unknown";

export interface FrameworkInfo {
  framework: string;
  language: Language;
  /** False when the directory contains no recognizable project files. */
  projectDetected: boolean;
  logPaths: string[];
  expectedPorts: number[];
  /**
   * "config": ports were read from the project's own config, so all are expected.
   * "default": framework defaults; the server only needs to be on one of them.
   */
  portSource: "config" | "default" | "none";
}

const DEFAULT_LOG_PATHS = ["logs", "log", "."];

const UNKNOWN: FrameworkInfo = {
  framework: "unknown",
  language: "unknown",
  projectDetected: false,
  logPaths: DEFAULT_LOG_PATHS,
  expectedPorts: [],
  portSource: "none",
};

/** Node frameworks, checked in order (meta-frameworks before the tools they build on). */
const NODE_FRAMEWORKS: Array<{ dep: string; framework: string; ports: number[] }> = [
  { dep: "next", framework: "nextjs", ports: [3000] },
  { dep: "nuxt", framework: "nuxt", ports: [3000] },
  { dep: "@sveltejs/kit", framework: "sveltekit", ports: [5173] },
  { dep: "astro", framework: "astro", ports: [4321] },
  { dep: "@remix-run/dev", framework: "remix", ports: [5173, 3000] },
  { dep: "@angular/core", framework: "angular", ports: [4200] },
  { dep: "@nestjs/core", framework: "nestjs", ports: [3000] },
  { dep: "react-scripts", framework: "create-react-app", ports: [3000] },
  { dep: "vite", framework: "vite", ports: [5173] },
  { dep: "fastify", framework: "fastify", ports: [3000] },
  { dep: "express", framework: "express", ports: [3000, 8080] },
];

const PYTHON_FRAMEWORKS: Array<{ dep: string; framework: string; ports: number[] }> = [
  { dep: "fastapi", framework: "fastapi", ports: [8000] },
  { dep: "django", framework: "django", ports: [8000] },
  { dep: "flask", framework: "flask", ports: [5000] },
];

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function toPorts(values: Iterable<string | number>): number[] {
  const ports = new Set<number>();
  for (const value of values) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports];
}

/** Ports from a dev script, e.g. "next dev -p 4000", "vite --port 3001", "PORT=4000 node server.js". */
export function portsFromScript(script: string | undefined): number[] {
  if (!script) return [];
  const found: string[] = [];
  for (const match of script.matchAll(/(?:--port[= ]|(?:^|\s)-p\s+)(\d{2,5})\b/g)) found.push(match[1]);
  for (const match of script.matchAll(/\bPORT=(\d{2,5})\b/g)) found.push(match[1]);
  return toPorts(found);
}

async function portsFromEnv(cwd: string): Promise<number[]> {
  for (const name of [".env.local", ".env.development", ".env"]) {
    const text = await readText(join(cwd, name));
    const match = text?.match(/^\s*PORT\s*=\s*["']?(\d{2,5})/m);
    if (match) return toPorts([match[1]]);
  }
  return [];
}

async function portsFromViteConfig(cwd: string): Promise<number[]> {
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"]) {
    const text = await readText(join(cwd, name));
    const match = text?.match(/server\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})/s);
    if (match) return toPorts([match[1]]);
  }
  return [];
}

/** Ports from an ASP.NET Core Properties/launchSettings.json. */
export function portsFromLaunchSettings(text: string): number[] {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "");
  let settings: { profiles?: Record<string, { applicationUrl?: string; commandName?: string }> };
  try {
    settings = JSON.parse(withoutComments);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const profile of Object.values(settings.profiles ?? {})) {
    if (profile.commandName && profile.commandName !== "Project") continue;
    for (const url of (profile.applicationUrl ?? "").split(";")) {
      const match = url.match(/:(\d{2,5})(?:\/|$)/);
      if (match) found.push(match[1]);
    }
  }
  return toPorts(found);
}

function withPorts(
  base: Omit<FrameworkInfo, "expectedPorts" | "portSource">,
  configPorts: number[],
  defaultPorts: number[]
): FrameworkInfo {
  if (configPorts.length > 0) return { ...base, expectedPorts: configPorts, portSource: "config" };
  return { ...base, expectedPorts: defaultPorts, portSource: defaultPorts.length > 0 ? "default" : "none" };
}

async function detectNode(cwd: string): Promise<FrameworkInfo | null> {
  const raw = await readText(join(cwd, "package.json"));
  if (raw === null) return null;
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(raw);
  } catch {
    // Malformed package.json is still a Node project.
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};
  const configPorts = [
    ...portsFromScript(scripts.dev ?? scripts.start ?? scripts.serve),
    ...(await portsFromEnv(cwd)),
    ...(await portsFromViteConfig(cwd)),
  ];
  const base = { language: "node" as const, projectDetected: true, logPaths: DEFAULT_LOG_PATHS };

  const match = NODE_FRAMEWORKS.find((candidate) => candidate.dep in deps);
  if (match) return withPorts({ ...base, framework: match.framework }, toPorts(configPorts), match.ports);
  return withPorts({ ...base, framework: "node" }, toPorts(configPorts), [3000, 5173, 8080]);
}

async function detectPython(cwd: string): Promise<FrameworkInfo | null> {
  const files = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "Pipfile", "setup.py"];
  const contents = await Promise.all(files.map((name) => readText(join(cwd, name))));
  const hasManagePy = await exists(join(cwd, "manage.py"));
  if (contents.every((text) => text === null) && !hasManagePy) return null;

  const text = contents.filter(Boolean).join("\n").toLowerCase();
  const base = { language: "python" as const, projectDetected: true, logPaths: DEFAULT_LOG_PATHS };
  const configPorts = await portsFromEnv(cwd);

  if (hasManagePy) return withPorts({ ...base, framework: "django" }, configPorts, [8000]);
  const match = PYTHON_FRAMEWORKS.find((candidate) =>
    new RegExp(`(^|[\\s"'\\[,=])${candidate.dep}\\b`, "m").test(text)
  );
  if (match) return withPorts({ ...base, framework: match.framework }, configPorts, match.ports);
  return withPorts({ ...base, framework: "python" }, configPorts, []);
}

async function detectDotnet(cwd: string): Promise<FrameworkInfo | null> {
  let entries: string[];
  try {
    entries = await readdir(cwd);
  } catch {
    return null;
  }
  const csproj = entries.find((name) => name.endsWith(".csproj"));
  const sln = entries.find((name) => name.endsWith(".sln") || name.endsWith(".slnx"));
  if (!csproj && !sln) return null;

  const base = { language: "dotnet" as const, projectDetected: true, logPaths: ["logs", "Logs", "log", "."] };
  const projectText = csproj ? await readText(join(cwd, csproj)) : null;
  const isWeb = projectText ? /Sdk="Microsoft\.NET\.Sdk\.(?:Web|BlazorWebAssembly|Razor)"/.test(projectText) : false;
  const launch = await readText(join(cwd, "Properties", "launchSettings.json"));
  const configPorts = launch ? portsFromLaunchSettings(launch) : [];

  if (isWeb || configPorts.length > 0) {
    return withPorts({ ...base, framework: "aspnetcore" }, configPorts, [5000, 5001]);
  }
  return withPorts({ ...base, framework: "dotnet" }, configPorts, []);
}

async function detectOther(cwd: string): Promise<FrameworkInfo | null> {
  if (await exists(join(cwd, "go.mod"))) {
    return withPorts(
      { framework: "go", language: "go", projectDetected: true, logPaths: DEFAULT_LOG_PATHS },
      await portsFromEnv(cwd),
      [8080]
    );
  }
  if (await exists(join(cwd, "Cargo.toml"))) {
    return withPorts(
      { framework: "rust", language: "rust", projectDetected: true, logPaths: DEFAULT_LOG_PATHS },
      await portsFromEnv(cwd),
      [8080, 3000]
    );
  }
  return null;
}

export async function detectFramework(cwd: string): Promise<FrameworkInfo> {
  try {
    return (
      (await detectNode(cwd)) ??
      (await detectPython(cwd)) ??
      (await detectDotnet(cwd)) ??
      (await detectOther(cwd)) ??
      UNKNOWN
    );
  } catch {
    return UNKNOWN;
  }
}
