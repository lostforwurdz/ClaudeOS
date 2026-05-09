# ClaudeOS — Repository Guidelines

ClaudeOS is a single-user desktop agent computer powered by Claude Code. The user's global `~/.claude/CLAUDE.md` constitution applies to all work in this repo.

## Architecture

- `runtime/harness/` — Claude Code subprocess runner. Spawns `claude` CLI, parses stream-json, emits `RunEvent`s.
- `runtime/api-server/` — Workspace + session + run lifecycle. Talks to desktop over WebSocket; spawns harness per run.
- `runtime/state-store/` — SQLite-backed workspace state and session continuity.
- `sdk/bridge/` — Desktop ↔ runtime IPC contract.
- `sdk/runtime-client/` — TypeScript client used by the desktop to talk to the api-server.
- `desktop/` — Electron shell. Chat UI, workspace browser, settings.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `migrate:`).
- Commit body bullets describe what changed and why; include validation coverage.
- Never carry forward Pi/holaOS abstractions. ClaudeOS contracts are designed for Claude Code's stream-json shape, not retrofitted.
- Single-user only — no `holaboss_user_id`, no per-user keychain, no multi-tenant proxy.
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` from a Claude Pro/Max subscription, passed through to the harness via env.
- Validation gates: `npm run runtime:typecheck && npm run runtime:test && npm run desktop:typecheck`.
