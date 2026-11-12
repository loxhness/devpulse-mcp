// Builds devpulse-<version>.mcpb, a one-click Claude Desktop extension.
// Usage: npm run build && node scripts/build-mcpb.mjs
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, ".mcpb-build");
const out = join(root, `devpulse-${version}.mcpb`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/ is missing; run `npm run build` first");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ["dist", "package.json", "package-lock.json", "manifest.json", "README.md", "LICENSE"]) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(stage, file), { recursive: true });
}

// Production dependencies only; the bundle ships its own node_modules.
execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stage,
  stdio: "inherit",
  shell: process.platform === "win32",
});

const mcpb = ["-y", "@anthropic-ai/mcpb@2"];
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const opts = { cwd: root, stdio: "inherit", shell: process.platform === "win32" };
execFileSync(npx, [...mcpb, "validate", join(stage, "manifest.json")], opts);
execFileSync(npx, [...mcpb, "pack", stage, out], opts);
rmSync(stage, { recursive: true, force: true });
console.log(`Built ${out}`);
