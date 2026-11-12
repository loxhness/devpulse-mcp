// Runs during `npm version`: copies the new package.json version into every
// other place that declares one, so npm, the MCP Registry, the Claude Desktop
// extension and the Claude Code plugin never drift apart.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

function update(path, apply) {
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf8"));
  apply(data);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${path} -> ${version}`);
}

update("server.json", (server) => {
  server.version = version;
  for (const pkg of server.packages ?? []) {
    if (pkg.registryType === "npm") pkg.version = version;
  }
});
update("manifest.json", (manifest) => {
  manifest.version = version;
});
update("plugin/.claude-plugin/plugin.json", (plugin) => {
  plugin.version = version;
});
