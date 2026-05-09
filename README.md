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

If `claude` or the OAuth token are missing, the desktop app shows a preflight error overlay with instructions instead of starting.

## Packaging

Per-OS installer builds are wired through `electron-builder`. Run from the repo root after one-time setup:

```bash
npm run desktop:install   # once
npm --prefix desktop run pack:linux   # AppImage + .deb
npm --prefix desktop run pack:mac     # .dmg (codesigning not configured)
npm --prefix desktop run pack:win     # NSIS .exe
```

Output lands in `desktop/build/`. The api-server and browser-mcp dist trees are bundled as `extraResources`; native modules (`better-sqlite3`) are unpacked from the asar so they can load at runtime. Today the packaged app expects the user to have `claude` on PATH — bundling the CLI itself is tracked as a follow-up.

## License

MIT (inherited from holaOS).
