# devpulse

[![npm](https://img.shields.io/npm/v/devpulse-mcp)](https://www.npmjs.com/package/devpulse-mcp)
[![CI](https://github.com/loxhness/devpulse-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/loxhness/devpulse-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Your AI coding assistant can't see your terminal.** It doesn't know your dev server crashed, that another project is squatting on port 3000, or that you're mid-rebase with conflicts. So it asks you, and you copy-paste.

devpulse is an MCP server that answers all of that in one tool call, with a verdict and a suggested fix.

[<img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Install in Cursor" height="32">](https://cursor.com/en/install-mcp?name=devpulse&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImRldnB1bHNlLW1jcCJdfQ%3D%3D)
[<img src="https://img.shields.io/badge/VS_Code-Install_devpulse-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install in VS Code" height="32">](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22devpulse%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22devpulse-mcp%22%5D%7D)
[<img src="https://img.shields.io/badge/Claude_Desktop-Download_extension-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Download for Claude Desktop" height="32">](https://github.com/loxhness/devpulse-mcp/releases/latest/download/devpulse.mcpb)

## What your assistant sees

Real output for a Next.js project whose dev server won't start:

```json
{
  "diagnosis": {
    "health": "broken",
    "primary_issue": "Port conflict: another process is using this project's dev server port",
    "secondary_signals": ["Port 3000 is held by node (pid 1576), started from /home/you/old-app"],
    "suggested_action": "Stop the other process (it belongs to a different directory) or run this dev server on a different port",
    "confidence": "high"
  },
  "session": {
    "project": "my-app",
    "framework": "nextjs",
    "git": { "branch": "feat/auth", "uncommitted_files": 5, "conflicted_files": 0, "last_commit_message": "Add login form" }
  },
  "services": {
    "running": [{ "port": 3000, "pid": 1576, "name": "node", "process_cwd": "/home/you/old-app", "owned_by_project": false }]
  },
  "recent_errors": [
    {
      "time": "2m ago",
      "level": "ERROR",
      "message": "Error: listen EADDRINUSE: address already in use :::3000",
      "stack": ["at Server.setupListenHandle [as _listen2] (node:net:1872:16)"],
      "source": "logs/dev.log",
      "count": 1
    }
  ],
  "env": { "node": "22.11.0", "package_manager": "pnpm" }
}
```

(Shortened; the full snapshot also includes runtime versions, ahead/behind counts and the log files scanned.)

## Install

**Claude Code** (plugin, adds a `/devpulse:diagnose` skill too)

```
/plugin install devpulse --marketplace loxhness/devpulse-mcp
```

or just the MCP server:

```bash
claude mcp add devpulse -- npx -y devpulse-mcp
```

**Cursor, VS Code:** use the buttons above.

**Claude Desktop:** download [devpulse.mcpb](https://github.com/loxhness/devpulse-mcp/releases/latest/download/devpulse.mcpb) and double-click it. Pick a default project folder in the extension's settings.

**Any other MCP client** (Windsurf, Cline, Zed, ...):

```json
{
  "mcpServers": {
    "devpulse": {
      "command": "npx",
      "args": ["-y", "devpulse-mcp"]
    }
  }
}
```

No API key, no account, no config file. Requires Node 18+.

## What it diagnoses

| Problem | How devpulse knows |
| --- | --- |
| Port conflict | The dev server's port is held by a process started from a different folder; `EADDRINUSE` in the logs raises confidence |
| Dev server crashed | Nothing on the expected port, errors in the last hour of logs |
| Dev server not started | Nothing on the expected port, no errors |
| Failed to start, port free now | `EADDRINUSE` logged but the port has since been released |
| Merge conflicts | Conflicted files, or a merge or rebase in progress |
| Dependencies not installed | `package.json` has dependencies but there's no `node_modules` |
| Runtime mismatch | Installed Node or Python differs from `.nvmrc`, `.node-version`, `engines` or `.python-version` |
| Errors while running | Server is up, but errors were logged |

## Tools

| Tool | Use it for |
| --- | --- |
| `get_session_snapshot` | Everything above in one call. Call this first. |
| `get_recent_errors` | More than the snapshot's 10 newest errors, with full stack traces (`limit` 1 to 200) |
| `get_running_services` | Re-checking ports after a restart, without the full snapshot |

All three are read-only and accept an optional `cwd`.

## Supported projects

| Language | Detected from | Frameworks |
| --- | --- | --- |
| JavaScript / TypeScript | `package.json` | Next.js, Nuxt, SvelteKit, Astro, Remix, Angular, Vite, NestJS, Fastify, Express, Create React App |
| Python | `pyproject.toml`, `requirements.txt`, `Pipfile`, `manage.py` | FastAPI, Django, Flask |
| .NET | `*.csproj`, `*.sln` | ASP.NET Core (ports from `Properties/launchSettings.json`) |
| Go, Rust | `go.mod`, `Cargo.toml` | Any |

Ports come from your config when devpulse can find them (`--port` / `-p` / `PORT=` in your dev script, `PORT` in `.env`, `server.port` in `vite.config`, `launchSettings.json`), and framework defaults otherwise.

## Which project it looks at

1. The `cwd` the assistant passes, if any
2. The workspace folder your editor reports over MCP (roots)
3. `DEVPULSE_PROJECT_DIR`, if set (the Claude Desktop extension sets this from its settings)
4. The folder the server was launched from (Claude Code launches it in your project)

## Limitations

- **Errors come from log files.** Most dev servers print to the terminal instead of writing a log file, so if your project has no `.log` files, `recent_errors` will be empty. Ports, git and dependency checks still work. Terminal capture is planned for 0.2.
- **Ownership checks don't run on Windows.** Ports and processes are still detected, but devpulse can't tell whose process it is, so confidence is lower.
- **Runtime versions** are read from the environment devpulse runs in, which can differ from your shell if you use nvm or pyenv. Mismatches are reported as signals, not verdicts.

## Privacy

Runs entirely on your machine and makes no network requests. Secrets (API keys, tokens, passwords, credentials in URLs) are redacted from log lines before your assistant sees them.

## Development

```bash
npm install
npm test          # unit + end-to-end tests over stdio
npm run build
```

Releasing: `npm version patch && git push --follow-tags`. The release workflow tests, publishes to npm and the MCP Registry, builds the Claude Desktop extension, and creates the GitHub release from [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
