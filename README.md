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

## Prerequisites

- Node 24
- `claude` CLI on `PATH`
- `CLAUDE_CODE_OAUTH_TOKEN` from a Claude Pro/Max subscription (`claude setup-token`)

## License

MIT (inherited from holaOS).
