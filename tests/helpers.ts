import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length > 0) children.pop()?.kill();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Creates a temp directory with the given files (paths relative to it). */
export function makeProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "devpulse-test-"));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** Starts a TCP listener in a child process with the given cwd and resolves to its port and pid. */
export function startListener(cwd: string): Promise<{ port: number; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
      ],
      { cwd, stdio: ["ignore", "pipe", "inherit"] }
    );
    children.push(child);
    child.on("error", reject);
    child.stdout?.once("data", (data) => {
      resolve({ port: Number(String(data).trim()), pid: child.pid ?? -1 });
    });
  });
}
