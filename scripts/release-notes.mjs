// Prints one version's section of CHANGELOG.md (without its heading).
// Usage: node scripts/release-notes.mjs 0.1.3
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(`^## \\[?${escaped}\\]?(?:\\s|$)`);

const start = lines.findIndex((line) => heading.test(line));
if (start === -1) process.exit(0); // caller falls back to "See CHANGELOG.md"
let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end === -1) end = lines.length;

process.stdout.write(lines.slice(start + 1, end).join("\n").trim() + "\n");
