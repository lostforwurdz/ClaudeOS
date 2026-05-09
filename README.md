# ClaudeOS

A single-user desktop agent computer powered by Claude Code.

ClaudeOS wraps the [Claude Code](https://claude.com/claude-code) headless CLI in an Electron desktop shell with persistent workspaces, multi-session concurrency, browser-tool MCP, and continuity artifacts. Forked from [holaOS](https://github.com/holaboss-ai/holaOS) for inspiration; rebuilt from the ground up.

**Status:** Phase 1 — foundations. Not yet runnable.

## Layout

| Path | What |
|---|---|
| `runtime/harness/` | Spawns `claude` CLI, parses stream-json, emits `RunEvent`s |
| `runtime/api-server/` | Workspace + session + run lifecycle (Fastify + WebSocket) |
| `runtime/state-store/` | SQLite-backed workspace state |
| `sdk/bridge/` | Desktop ↔ runtime IPC contract |
| `sdk/runtime-client/` | TypeScript client for the api-server |
| `desktop/` | Electron shell |
| `packages/browser-mcp/` | Stdio MCP server: Playwright-driven `navigate`/`click`/`screenshot`/`extract` tools |

## Prerequisites

- Node 24
- `claude` CLI on `PATH`
- `CLAUDE_CODE_OAUTH_TOKEN` from a Claude Pro/Max subscription (`claude setup-token`)
- For the browser MCP: `npx playwright install chromium` (one-time, ~150 MB)

On first launch the desktop app opens a paste-token window if no `CLAUDE_CODE_OAUTH_TOKEN` is set; the token is persisted via Electron's `safeStorage` (libsecret on this Debian host) and auto-injected on subsequent launches.

## Packaging

Single-machine, Debian Linux x64. Run from the repo root after one-time setup:

```bash
npm run desktop:install   # once
npm --prefix desktop run pack   # AppImage + .deb in desktop/build/
```

The api-server, browser-mcp, and pinned `@anthropic-ai/claude-code` CLI are bundled as `extraResources`; `better-sqlite3` is unpacked from the asar so it can load at runtime. `electron-updater` checks for updates from the matching GitHub Releases feed on launch.

## License

MIT (inherited from holaOS).
