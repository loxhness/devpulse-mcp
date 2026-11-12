import { execFile } from "node:child_process";

/**
 * Like run(), but also reports the exit code so callers can tell "ran and
 * found nothing" (e.g. lsof exits 1) from "could not run" (code null: missing
 * command, timeout, killed). Never throws.
 */
export function runWithStatus(
  command: string,
  args: string[] = [],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? 2000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: options.env,
        },
        (error, stdout) => {
          if (!error) return resolve({ stdout: String(stdout ?? ""), code: 0 });
          const code = (error as { code?: unknown }).code;
          resolve({
            stdout: String(stdout ?? ""),
            code: typeof code === "number" && !error.killed ? code : null,
          });
        }
      );
    } catch {
      resolve({ stdout: "", code: null });
    }
  });
}

/**
 * Runs a command without a shell and resolves to its trimmed stdout,
 * or null if the command is missing, fails, or times out. Never throws.
 */
export function run(
  command: string,
  args: string[] = [],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? 2000,
          windowsHide: true,
          cwd: options.cwd,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve(null);
            return;
          }
          // Some tools (e.g. older `python --version`) print to stderr.
          const out = String(stdout ?? "").trim() || String(stderr ?? "").trim();
          resolve(out);
        }
      );
    } catch {
      resolve(null);
    }
  });
}
