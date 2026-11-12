import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { compress } from "../utils/compress.js";
import { redact } from "../utils/redact.js";

export interface ErrorEntry {
  /** Relative time, e.g. "2m ago". */
  time: string;
  /** ISO timestamp, parsed from the log line when possible, otherwise the file's mtime. */
  at: string;
  level: "ERROR" | "WARN";
  message: string;
  /** Stack trace lines that followed the error (max 10). */
  stack?: string[];
  /** Log file the entry came from, relative to the project root. */
  source: string;
  /** How many times this exact message appeared. */
  count: number;
}

export interface RecentErrorsResult {
  errors: ErrorEntry[];
  log_files: string[];
}

const TAIL_BYTES = 256 * 1024;
const MAX_FILES = 20;
const MAX_DEPTH = 3;
const MAX_STACK_LINES = 10;
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", "bin", "obj"]);

const ERROR_RE =
  /\b(?:\w*error|\w*exception|fatal|uncaught|unhandled|traceback|panic(?:ked)?|EADDRINUSE|ECONNREFUSED)\b|\bERR!/i;
const WARN_RE = /\b(?:\w*warn(?:ing)?|deprecat\w*)\b/i;
const ZERO_SUMMARY_RE = /\b(?:0|no)\s+(?:errors?|warnings?|problems?)\b/gi;
const NONZERO_SUMMARY_RE = /\b[1-9]\d*\s+(?:errors?|problems?)\b/i;
const STACK_LINE_RE = /^\s+(?:at\s|File\s"|\.\.\.\s\d+ more|\^)/;
const TIMESTAMP_RE =
  /^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/;

export function relativeTime(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Classifies a log line, or returns null if it is not an error or warning. */
export function classifyLine(line: string): ErrorEntry["level"] | null {
  // Remove "0 errors" / "no warnings" summaries first: they are good news.
  const stripped = line.replace(ZERO_SUMMARY_RE, " ");
  if (ERROR_RE.test(stripped) || NONZERO_SUMMARY_RE.test(stripped)) return "ERROR";
  if (WARN_RE.test(stripped)) return "WARN";
  return null;
}

function parseTimestamp(line: string): number | null {
  const match = line.match(TIMESTAMP_RE);
  if (!match) return null;
  const ms = Date.parse(match[1].replace(",", ".").replace(" ", "T"));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Expands logPaths (files or directories) into .log files, newest first.
 * Directories are searched recursively; the project root itself only one level
 * deep, so root-level files like npm-debug.log are found without crawling the repo.
 */
export async function collectLogFiles(cwd: string, logPaths: string[]): Promise<string[]> {
  const root = resolve(cwd);
  const found = new Map<string, number>();

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(full, depth - 1);
        }
      } else if (entry.isFile() && /\.log$/i.test(entry.name)) {
        try {
          // realpath dedupes "logs" vs "Logs" on case-insensitive file systems.
          found.set(await realpath(full), (await stat(full)).mtimeMs);
        } catch {
          // unreadable, skip
        }
      }
    }
  }

  for (const logPath of logPaths) {
    const full = resolve(root, logPath);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isFile()) {
      found.set(await realpath(full).catch(() => full), info.mtimeMs);
    } else if (info.isDirectory()) {
      await walk(full, full === root ? 0 : MAX_DEPTH);
    }
  }

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FILES)
    .map(([path]) => path);
}

async function readTail(path: string): Promise<{ text: string; mtimeMs: number }> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    let text = buffer.toString("utf8");
    if (info.size > TAIL_BYTES) {
      // The first line is probably cut off; drop it.
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return { text, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

interface WorkingEntry {
  level: ErrorEntry["level"];
  message: string;
  stack: string[];
  source: string;
  count: number;
  sortMs: number;
  order: number;
}

export async function getRecentErrors(
  cwd: string,
  logPaths: string[],
  limit: number = 50
): Promise<RecentErrorsResult> {
  const files = await collectLogFiles(cwd, logPaths).catch(() => [] as string[]);
  // Files are realpaths, so compute relative paths against the real root too
  // (macOS /tmp -> /private/tmp, symlinked home directories).
  const realRoot = await realpath(cwd).catch(() => cwd);
  const byMessage = new Map<string, WorkingEntry>();
  let order = 0;

  for (const file of files) {
    let tail;
    try {
      tail = await readTail(file);
    } catch {
      continue;
    }
    const source = relative(realRoot, file) || file;
    let lastTimestamp: number | null = null;
    let current: WorkingEntry | null = null;
    let inPythonTraceback = false;

    for (const rawLine of tail.text.split(/\r?\n/)) {
      const ts = parseTimestamp(rawLine);
      if (ts !== null) lastTimestamp = ts;

      // Indented continuation of a stack trace: attach to the current entry.
      if (current && (STACK_LINE_RE.test(rawLine) || (inPythonTraceback && /^\s+\S/.test(rawLine)))) {
        if (current.stack.length < MAX_STACK_LINES) {
          current.stack.push(compress(redact(rawLine.trim())));
        }
        continue;
      }
      // Last line of a Python traceback, e.g. "ValueError: bad input".
      if (current && inPythonTraceback && rawLine.trim()) {
        const summary = compress(redact(rawLine.trim()));
        current.message = `${current.message} ${summary}`;
        inPythonTraceback = false;
        current = null;
        continue;
      }

      current = null;
      inPythonTraceback = false;
      if (!rawLine.trim()) continue;

      const level = classifyLine(rawLine);
      if (!level) continue;

      const message = compress(redact(rawLine.trim()));
      const atMs = ts ?? lastTimestamp ?? tail.mtimeMs;
      inPythonTraceback = /^\s*Traceback \(most recent call last\)/.test(rawLine);

      // Python tracebacks are keyed after the summary line is appended, so
      // keep them out of the dedupe map until then.
      const existing = inPythonTraceback ? undefined : byMessage.get(message);
      if (existing) {
        existing.count += 1;
        existing.sortMs = Math.max(existing.sortMs, atMs);
        existing.order = order++;
        existing.stack = [];
        current = existing;
      } else {
        current = { level, message, stack: [], source, count: 1, sortMs: atMs, order: order++ };
        byMessage.set(inPythonTraceback ? `${message}#${current.order}` : message, current);
      }
    }
  }

  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const now = Date.now();
  const sorted = [...byMessage.values()]
    .sort((a, b) => a.sortMs - b.sortMs || a.order - b.order)
    .slice(-safeLimit);

  return {
    errors: sorted.map((entry) => ({
      time: relativeTime(now - entry.sortMs),
      at: new Date(entry.sortMs).toISOString(),
      level: entry.level,
      message: entry.message,
      ...(entry.stack.length > 0 ? { stack: entry.stack } : {}),
      source: entry.source,
      count: entry.count,
    })),
    log_files: files.map((file) => relative(realRoot, file) || file),
  };
}
