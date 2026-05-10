/**
 * a4x.1 — Static agent catalog.
 *
 * Single source of truth for all agents ClaudeOS knows about. Catalog edits
 * ship via electron-updater; no DB rows involved.
 *
 * Auth detection split (by design):
 *   - This module: reads env vars only. Stateless. No subprocess calls.
 *   - Desktop electron main (a4x.9): detects underlying CLI OAuth state
 *     (gemini, codex, gh) and safeStorage API keys; injects flags + keys
 *     as the env vars below when spawning the api-server process.
 *
 * Env-var contract (desktop sets these; api-server reads them):
 *   CLAUDE_CODE_OAUTH_TOKEN    — Anthropic OAuth token (existing)
 *   CLAUDEOS_GEMINI_AUTH_OK    — "1" when gemini CLI is authed
 *   CLAUDEOS_CODEX_AUTH_OK     — "1" when codex CLI is authed (ChatGPT Plus)
 *   CLAUDEOS_GH_AUTH_OK        — "1" when gh CLI is authed
 *   CLAUDEOS_OPENAI_API_KEY    — OpenAI API key (fallback for codex)
 *   CLAUDEOS_DEEPSEEK_API_KEY  — DeepSeek API key
 *   CLAUDEOS_KIMI_API_KEY      — Moonshot (Kimi) API key
 *   CLAUDEOS_XAI_API_KEY       — xAI API key
 *   CLAUDEOS_MISTRAL_API_KEY   — Mistral API key
 *   CLAUDEOS_GROQ_API_KEY      — Groq API key
 *
 * If the desktop hasn't set CLAUDEOS_GEMINI_AUTH_OK=1, gemini agents show as
 * needs_setup even if the user has an authed gemini CLI on PATH. The full UX
 * gap closes when a4x.9 lands.
 *
 * DO NOT subprocess to underlying CLIs (gh auth status, etc.) from here.
 * That is slow per call, leaks subprocesses, and crosses process boundaries.
 */

import type { Agent, AgentCatalogResponse, AgentWithStatus } from "@claudeos/runtime-client/contracts";

// ============================================================================
// Catalog
// ============================================================================

// Tier 1: OAuth-gated agents (8)

const TIER1_AGENTS: readonly Agent[] = [
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    runner_kind: "claude-code",
    model: "claude-opus-4-7",
    auth: { kind: "oauth", provider: "anthropic" },
    cost_tier: "subscription",
    description: "Anthropic's flagship. Best for complex reasoning, planning, and architecture work.",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    runner_kind: "claude-code",
    model: "claude-sonnet-4-6",
    auth: { kind: "oauth", provider: "anthropic" },
    cost_tier: "subscription",
    description: "Balanced quality and speed. Default coder for most tasks.",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    runner_kind: "claude-code",
    model: "claude-haiku-4-5-20251001",
    auth: { kind: "oauth", provider: "anthropic" },
    cost_tier: "subscription",
    description: "Fastest Claude. Cheap-to-run for routine code edits, classification, light synthesis.",
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    runner_kind: "agent-pool",
    delegate_target: "gemini-cli",
    model: "gemini-3-pro", // TODO: verify model id
    auth: { kind: "oauth", provider: "google" },
    cost_tier: "free",
    description: "Google's flagship. Strong at planning and multi-step reasoning.",
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    runner_kind: "agent-pool",
    delegate_target: "gemini-cli",
    model: "gemini-3-flash", // TODO: verify model id
    auth: { kind: "oauth", provider: "google" },
    cost_tier: "free",
    description: "Fastest Gemini tier. Use for high-volume synthesis.",
  },
  {
    id: "gpt-5-5",
    name: "GPT-5.5",
    runner_kind: "agent-pool",
    delegate_target: "codex-cli",
    model: "gpt-5.5", // TODO: verify model id
    auth: { kind: "oauth", provider: "openai" },
    cost_tier: "subscription",
    description: "OpenAI's flagship via Codex CLI.",
  },
  {
    id: "gpt-5-5-mini",
    name: "GPT-5.5 mini",
    runner_kind: "agent-pool",
    delegate_target: "codex-cli",
    model: "gpt-5.5-mini", // TODO: verify model id
    auth: { kind: "oauth", provider: "openai" },
    cost_tier: "subscription",
    description: "Cheap GPT-5.5 tier.",
  },
  {
    id: "github-copilot-chat",
    name: "GitHub Copilot Chat",
    runner_kind: "agent-pool",
    delegate_target: "gh-copilot",
    model: "copilot-chat", // TODO: verify model id
    auth: { kind: "oauth", provider: "github" },
    cost_tier: "subscription",
    description: "GitHub Copilot via gh CLI.",
  },
] as const;

// Tier 2: API-key-gated agents (5)

const TIER2_AGENTS: readonly Agent[] = [
  {
    id: "deepseek-v4",
    name: "DeepSeek V4",
    runner_kind: "agent-pool",
    delegate_target: "deepseek-api",
    model: "deepseek-v4", // TODO: verify model id
    auth: { kind: "api_key", provider: "deepseek" },
    cost_tier: "paid",
    description: "Strong code model at very low cost per token.",
  },
  {
    id: "kimi-k2",
    name: "Kimi K2",
    runner_kind: "agent-pool",
    delegate_target: "kimi-api",
    model: "kimi-k2", // TODO: verify model id
    auth: { kind: "api_key", provider: "moonshot" },
    cost_tier: "paid",
    description: "Long-context Chinese model. Strong at structured synthesis.",
  },
  {
    id: "grok-4",
    name: "Grok 4",
    runner_kind: "agent-pool",
    delegate_target: "xai-api",
    model: "grok-4", // TODO: verify model id
    auth: { kind: "api_key", provider: "xai" },
    cost_tier: "paid",
    description: "xAI flagship. Useful for off-the-grain prompts.",
  },
  {
    id: "mistral-large-3",
    name: "Mistral Large 3",
    runner_kind: "agent-pool",
    delegate_target: "mistral-api",
    model: "mistral-large-3", // TODO: verify model id
    auth: { kind: "api_key", provider: "mistral" },
    cost_tier: "paid",
    description: "EU-hosted option. Decent code reasoning.",
  },
  {
    id: "llama-4-groq",
    name: "Llama 4 (Groq)",
    runner_kind: "agent-pool",
    delegate_target: "groq-api",
    model: "llama-4-405b", // TODO: verify model id
    auth: { kind: "api_key", provider: "groq" },
    cost_tier: "paid",
    description: "Fastest inference on the planet. Use for routing / triage tasks.",
  },
] as const;

/**
 * Full agent catalog. Order: Tier 1 (OAuth) followed by Tier 2 (API-key),
 * matching the plan's listing order. This is the canonical sequence for
 * UI rendering and `GET /agents` response ordering.
 */
export const AGENTS: readonly Agent[] = [...TIER1_AGENTS, ...TIER2_AGENTS];

/**
 * Role-shaped aliases. Pipeline YAML can say `agent_id: claude-flagship` and
 * survive a model rotation; `resolveAgent` dereferences before lookup.
 */
export const ALIASES: Record<string, string> = {
  "claude-flagship": "claude-opus-4-7",
  "claude-balanced": "claude-sonnet-4-6",
  "claude-fast": "claude-haiku-4-5",
  "gemini-flagship": "gemini-3-pro",
  "gemini-fast": "gemini-3-flash",
  "openai-flagship": "gpt-5-5",
  "openai-fast": "gpt-5-5-mini",
};

// ============================================================================
// Resolution helpers
// ============================================================================

/**
 * Look up an agent by id or alias.
 * Alias dereference runs first; direct id lookup follows.
 * Returns null for unknown ids (including unknown aliases).
 */
export function resolveAgent(id: string): Agent | null {
  const resolved = ALIASES[id] ?? id;
  return AGENTS.find((a) => a.id === resolved) ?? null;
}

// ============================================================================
// Auth detection (env-var-only — no subprocess calls)
// ============================================================================

/**
 * Map from auth provider name to the env var that indicates the agent is
 * connected. OAuth providers use boolean flags set by the desktop (a4x.9);
 * API-key providers use the key var itself as the signal.
 */
const OAUTH_PROVIDER_ENV: Record<string, string> = {
  anthropic: "CLAUDE_CODE_OAUTH_TOKEN",
  google: "CLAUDEOS_GEMINI_AUTH_OK",
  openai: "CLAUDEOS_CODEX_AUTH_OK",
  github: "CLAUDEOS_GH_AUTH_OK",
};

const API_KEY_PROVIDER_ENV: Record<string, string> = {
  openai: "CLAUDEOS_OPENAI_API_KEY",
  deepseek: "CLAUDEOS_DEEPSEEK_API_KEY",
  moonshot: "CLAUDEOS_KIMI_API_KEY",
  xai: "CLAUDEOS_XAI_API_KEY",
  mistral: "CLAUDEOS_MISTRAL_API_KEY",
  groq: "CLAUDEOS_GROQ_API_KEY",
};

/**
 * Determine whether an agent's auth credential is available via env vars.
 *
 * @param agent - the agent to check
 * @param env   - env var map; callers pass process.env (route) or a fixture (tests)
 *
 * For oauth agents: the env var must be non-empty.
 *   - anthropic: CLAUDE_CODE_OAUTH_TOKEN (existing token)
 *   - google/openai/github: CLAUDEOS_*_AUTH_OK must equal "1"
 *     (desktop sets this after CLI auth check in a4x.9)
 * For api_key agents: the corresponding CLAUDEOS_*_API_KEY must be non-empty.
 */
export function getAgentAuthStatus(
  agent: Agent,
  env: NodeJS.ProcessEnv,
): "connected" | "needs_setup" {
  const { kind, provider } = agent.auth;

  if (kind === "oauth") {
    const varName = OAUTH_PROVIDER_ENV[provider];
    if (!varName) return "needs_setup";
    const value = env[varName];
    if (!value || value.length === 0) return "needs_setup";
    // anthropic: any non-empty token is sufficient
    // google/openai/github: desktop sets exactly "1" when authed
    if (provider === "anthropic") return "connected";
    return value === "1" ? "connected" : "needs_setup";
  }

  if (kind === "api_key") {
    const varName = API_KEY_PROVIDER_ENV[provider];
    if (!varName) return "needs_setup";
    const value = env[varName];
    return value && value.length > 0 ? "connected" : "needs_setup";
  }

  return "needs_setup";
}

/**
 * Convenience wrapper: returns all 13 agents with their current auth status.
 * The route handler passes `process.env`; tests pass a fixture object.
 */
export function listAgentsWithStatus(env: NodeJS.ProcessEnv): AgentWithStatus[] {
  return AGENTS.map((agent) => ({
    ...agent,
    status: getAgentAuthStatus(agent, env),
  }));
}

/**
 * Convenience: build the full `GET /agents` response payload.
 */
export function buildAgentCatalogResponse(env: NodeJS.ProcessEnv): AgentCatalogResponse {
  return {
    agents: listAgentsWithStatus(env),
    aliases: ALIASES,
  };
}
