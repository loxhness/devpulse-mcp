import { execFile } from "node:child_process";

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
