import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../utils/exec.js";

export interface RuntimeInfo {
  node: string | null;
  python: string | null;
  go: string | null;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | "unknown";
  /** Versions the project asks for (.nvmrc, .node-version, engines.node, .python-version). */
  required: { node: string | null; python: string | null };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTrimmed(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text || null;
  } catch {
    return null;
  }
}

async function detectNodeVersion(): Promise<string | null> {
  const output = await run("node", ["--version"]);
  return output ? output.replace(/^v/, "") : null;
}

async function detectPythonVersion(): Promise<string | null> {
  // On Windows, `py -3` often works even when the `python` alias is disabled.
  const candidates: Array<[string, string[]]> =
    process.platform === "win32"
      ? [["py", ["-3", "--version"]], ["python", ["--version"]]]
      : [["python3", ["--version"]], ["python", ["--version"]]];
  const outputs = await Promise.all(candidates.map(([cmd, args]) => run(cmd, args)));
  for (const output of outputs) {
    const match = output?.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i);
    if (match) return match[1];
  }
  return null;
}

async function detectGoVersion(): Promise<string | null> {
  const output = await run("go", ["version"]);
  return output?.match(/\bgo(\d+\.\d+(?:\.\d+)?)\b/)?.[1] ?? null;
}

async function detectPackageManager(cwd: string): Promise<RuntimeInfo["packageManager"]> {
  if ((await exists(join(cwd, "bun.lock"))) || (await exists(join(cwd, "bun.lockb")))) return "bun";
  if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(join(cwd, "package-lock.json"))) return "npm";
  return "unknown";
}

async function detectRequired(cwd: string): Promise<RuntimeInfo["required"]> {
  let node = (await readTrimmed(join(cwd, ".nvmrc"))) ?? (await readTrimmed(join(cwd, ".node-version")));
  if (!node) {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      node = pkg?.engines?.node ?? null;
    } catch {
      node = null;
    }
  }
  const python = await readTrimmed(join(cwd, ".python-version"));
  return {
    node: node ? node.split(/\r?\n/)[0].replace(/^v/, "") : null,
    python: python ? python.split(/\r?\n/)[0] : null,
  };
}

export async function detectRuntimes(cwd: string): Promise<RuntimeInfo> {
  try {
    const [node, python, go, packageManager, required] = await Promise.all([
      detectNodeVersion(),
      detectPythonVersion(),
      detectGoVersion(),
      detectPackageManager(cwd),
      detectRequired(cwd),
    ]);
    return { node, python, go, packageManager, required };
  } catch {
    return {
      node: null,
      python: null,
      go: null,
      packageManager: "unknown",
      required: { node: null, python: null },
    };
  }
}

/**
 * Best-effort check of an installed version against a requirement such as
 * "20", "20.11.0", "lts/iron" or ">=18". Returns null when it can't tell.
 */
export function versionMismatch(installed: string | null, required: string | null): boolean | null {
  if (!installed || !required) return null;
  const req = required.trim();
  const installedParts = installed.split(".").map(Number);

  const range = req.match(/^(>=|>|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!range) return null; // aliases like lts/iron, complex ranges
  const [, op, majorRaw, minorRaw] = range;
  const major = Number(majorRaw);
  const minor = minorRaw !== undefined ? Number(minorRaw) : null;

  if (op === ">=" || op === ">") {
    if (installedParts[0] !== major) return installedParts[0] < major;
    if (minor === null) return op === ">" ? true : false;
    return installedParts[1] < minor;
  }
  if (installedParts[0] !== major) return true;
  if (op === "^" || minor === null) return false;
  return installedParts[1] !== minor;
}
