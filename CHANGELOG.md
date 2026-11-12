# Changelog

All notable changes to devpulse-mcp. Versions follow [semver](https://semver.org/).

## [0.1.3] - 2026-11-12

The two headline features now work: log errors are actually read, and port conflicts are detected.

### Fixed

- **Log errors were always empty.** Log paths are directories (`logs/`, `log/`), but only files were read. devpulse now reads `.log` files inside them and at the project root, tailing the last 256 KB of each.
- **Port conflicts could never be detected.** The rule needed an `EADDRINUSE` error and a free port at the same time. It now checks which process holds the port and whether it belongs to your project.
- **"Healthy" meant "anything is on port 3000".** A server from another project no longer counts as yours.
- **Ports looked free on Linux machines without `netstat`.** devpulse reads `/proc` directly, then falls back to `ss` and `lsof`, and says so when it can't check instead of reporting nothing listening.
- **Wrong project outside Claude Code.** The project folder now comes from the client's workspace roots when available, then `DEVPULSE_PROJECT_DIR`, then the launch directory.
- **Redaction removed file paths, hostnames, versions and git SHAs.** Secrets are now matched by their real formats (JWT, GitHub, AWS, Stripe, Anthropic, OpenAI, Slack, Google, npm).
- **"0 errors, 0 warnings" was reported as an error**, as were words like `errorHandler`.
- **A repo with no commits lost its branch name.**
- **FastAPI was detected from `package.json`**, which Python projects don't have.
- The server reported version 0.1.0; tool failures weren't flagged with `isError`; unknown tools returned a misleading message.

### Added

- Stack traces (Node and Python) grouped under their error, per-line timestamps, repeat counts and source file.
- Diagnoses for merge conflicts, missing `node_modules`, "failed to start but the port is free now", and runtime version mismatches (`.nvmrc`, `engines`, `.python-version`).
- Detection for Django, Flask, ASP.NET Core (ports from `launchSettings.json`), Nuxt, SvelteKit, Astro, Remix, Angular, NestJS, Fastify, Go and Rust.
- Ports read from your dev script, `.env` `PORT` and `vite.config`.
- Git details: last commit message and age, ahead/behind, conflicted files, in-progress merge or rebase.
- Read-only tool annotations, parameter descriptions and argument validation.
- One-click installs: Cursor and VS Code buttons, a Claude Code plugin with a `/devpulse:diagnose` skill, and a Claude Desktop extension (`.mcpb`).
- `--version` flag.

## [0.1.2] - 2026-11-12

- Moved the repository to `loxhness/devpulse-mcp`.

## [0.1.1] - 2026-05-07

- MCP Registry metadata.

## [0.1.0] - 2026-05-07

- Initial release: `get_session_snapshot`, `get_recent_errors`, `get_running_services`.
