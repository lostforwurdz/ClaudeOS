/**
 * a4x.1 — Agent catalog unit + route tests.
 *
 * Unit tests (no server): resolveAgent, getAgentAuthStatus, listAgentsWithStatus.
 * Route tests: GET /agents via Fastify inject.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { AgentCatalogResponse, AgentWithStatus } from "@claudeos/runtime-client/contracts";

import {
  AGENTS,
  ALIASES,
  getAgentAuthStatus,
  listAgentsWithStatus,
  resolveAgent,
} from "./agents.js";
import { createServer } from "./index.js";

// ============================================================================
// Unit tests — no server required
// ============================================================================

test("AGENTS catalog contains exactly 13 agents", () => {
  assert.equal(AGENTS.length, 13);
});

test("ALIASES contains exactly 7 entries", () => {
  assert.equal(Object.keys(ALIASES).length, 7);
});

test("resolveAgent: direct id returns correct agent", () => {
  const agent = resolveAgent("claude-opus-4-7");
  assert.ok(agent !== null, "expected agent, got null");
  assert.equal(agent.id, "claude-opus-4-7");
  assert.equal(agent.name, "Claude Opus 4.7");
  assert.equal(agent.model, "claude-opus-4-7");
});

test("resolveAgent: alias 'claude-flagship' dereferences to claude-opus-4-7", () => {
  const agent = resolveAgent("claude-flagship");
  assert.ok(agent !== null, "expected agent, got null");
  assert.equal(agent.id, "claude-opus-4-7");
});

test("resolveAgent: alias 'claude-balanced' dereferences to claude-sonnet-4-6", () => {
  const agent = resolveAgent("claude-balanced");
  assert.ok(agent !== null);
  assert.equal(agent.id, "claude-sonnet-4-6");
});

test("resolveAgent: alias 'claude-fast' dereferences to claude-haiku-4-5", () => {
  const agent = resolveAgent("claude-fast");
  assert.ok(agent !== null);
  assert.equal(agent.id, "claude-haiku-4-5");
});

test("resolveAgent: alias 'gemini-flagship' dereferences to gemini-3-pro", () => {
  const agent = resolveAgent("gemini-flagship");
  assert.ok(agent !== null);
  assert.equal(agent.id, "gemini-3-pro");
});

test("resolveAgent: alias 'gemini-fast' dereferences to gemini-3-flash", () => {
  const agent = resolveAgent("gemini-fast");
  assert.ok(agent !== null);
  assert.equal(agent.id, "gemini-3-flash");
});

test("resolveAgent: alias 'openai-flagship' dereferences to gpt-5-5", () => {
  const agent = resolveAgent("openai-flagship");
  assert.ok(agent !== null);
  assert.equal(agent.id, "gpt-5-5");
});

test("resolveAgent: alias 'openai-fast' dereferences to gpt-5-5-mini", () => {
  const agent = resolveAgent("openai-fast");
  assert.ok(agent !== null);
  assert.equal(agent.id, "gpt-5-5-mini");
});

test("resolveAgent: unknown id returns null", () => {
  assert.equal(resolveAgent("nonexistent"), null);
});

test("resolveAgent: unknown alias returns null", () => {
  assert.equal(resolveAgent("totally-bogus-alias"), null);
});

// ============================================================================
// Auth detection — Anthropic (oauth, CLAUDE_CODE_OAUTH_TOKEN)
// ============================================================================

test("getAgentAuthStatus: anthropic agent is connected when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
  const agent = resolveAgent("claude-opus-4-7");
  assert.ok(agent !== null);
  const status = getAgentAuthStatus(agent, { CLAUDE_CODE_OAUTH_TOKEN: "tok_abc123" });
  assert.equal(status, "connected");
});

test("getAgentAuthStatus: anthropic agent is needs_setup when CLAUDE_CODE_OAUTH_TOKEN is absent", () => {
  const agent = resolveAgent("claude-sonnet-4-6");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, {}), "needs_setup");
});

test("getAgentAuthStatus: anthropic agent is needs_setup when CLAUDE_CODE_OAUTH_TOKEN is empty string", () => {
  const agent = resolveAgent("claude-haiku-4-5");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDE_CODE_OAUTH_TOKEN: "" }), "needs_setup");
});

// ============================================================================
// Auth detection — Google (oauth, CLAUDEOS_GEMINI_AUTH_OK)
// ============================================================================

test("getAgentAuthStatus: google agent is connected when CLAUDEOS_GEMINI_AUTH_OK=1", () => {
  const agent = resolveAgent("gemini-3-pro");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_GEMINI_AUTH_OK: "1" }), "connected");
});

test("getAgentAuthStatus: google agent is needs_setup when CLAUDEOS_GEMINI_AUTH_OK is absent", () => {
  const agent = resolveAgent("gemini-3-flash");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, {}), "needs_setup");
});

test("getAgentAuthStatus: google agent is needs_setup when CLAUDEOS_GEMINI_AUTH_OK is not '1'", () => {
  const agent = resolveAgent("gemini-3-pro");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_GEMINI_AUTH_OK: "true" }), "needs_setup");
});

// ============================================================================
// Auth detection — OpenAI / Codex (oauth, CLAUDEOS_CODEX_AUTH_OK)
// ============================================================================

test("getAgentAuthStatus: openai agent is connected when CLAUDEOS_CODEX_AUTH_OK=1", () => {
  const agent = resolveAgent("gpt-5-5");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_CODEX_AUTH_OK: "1" }), "connected");
});

test("getAgentAuthStatus: openai agent is needs_setup when CLAUDEOS_CODEX_AUTH_OK is absent", () => {
  const agent = resolveAgent("gpt-5-5-mini");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, {}), "needs_setup");
});

// ============================================================================
// Auth detection — GitHub (oauth, CLAUDEOS_GH_AUTH_OK)
// ============================================================================

test("getAgentAuthStatus: github agent is connected when CLAUDEOS_GH_AUTH_OK=1", () => {
  const agent = resolveAgent("github-copilot-chat");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_GH_AUTH_OK: "1" }), "connected");
});

test("getAgentAuthStatus: github agent is needs_setup when CLAUDEOS_GH_AUTH_OK is absent", () => {
  const agent = resolveAgent("github-copilot-chat");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, {}), "needs_setup");
});

// ============================================================================
// Auth detection — API-key providers
// ============================================================================

test("getAgentAuthStatus: deepseek agent is connected when CLAUDEOS_DEEPSEEK_API_KEY is set", () => {
  const agent = resolveAgent("deepseek-v4");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_DEEPSEEK_API_KEY: "sk-deep" }), "connected");
});

test("getAgentAuthStatus: deepseek agent is needs_setup when key is absent", () => {
  const agent = resolveAgent("deepseek-v4");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, {}), "needs_setup");
});

test("getAgentAuthStatus: kimi agent is connected when CLAUDEOS_KIMI_API_KEY is set", () => {
  const agent = resolveAgent("kimi-k2");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_KIMI_API_KEY: "sk-kimi" }), "connected");
});

test("getAgentAuthStatus: grok agent is connected when CLAUDEOS_XAI_API_KEY is set", () => {
  const agent = resolveAgent("grok-4");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_XAI_API_KEY: "xai-key" }), "connected");
});

test("getAgentAuthStatus: mistral agent is connected when CLAUDEOS_MISTRAL_API_KEY is set", () => {
  const agent = resolveAgent("mistral-large-3");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_MISTRAL_API_KEY: "mst-key" }), "connected");
});

test("getAgentAuthStatus: groq agent is connected when CLAUDEOS_GROQ_API_KEY is set", () => {
  const agent = resolveAgent("llama-4-groq");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, { CLAUDEOS_GROQ_API_KEY: "gsk_key" }), "connected");
});

test("getAgentAuthStatus: groq agent is needs_setup when key is absent", () => {
  const agent = resolveAgent("llama-4-groq");
  assert.ok(agent !== null);
  assert.equal(getAgentAuthStatus(agent, {}), "needs_setup");
});

// ============================================================================
// listAgentsWithStatus
// ============================================================================

test("listAgentsWithStatus: returns 13 agents", () => {
  const result = listAgentsWithStatus({});
  assert.equal(result.length, 13);
});

test("listAgentsWithStatus: every agent has a status field", () => {
  const result = listAgentsWithStatus({});
  for (const a of result) {
    assert.ok(
      a.status === "connected" || a.status === "needs_setup",
      `agent ${a.id} has invalid status: ${String(a.status)}`,
    );
  }
});

test("listAgentsWithStatus: all agents are needs_setup with empty env", () => {
  const result = listAgentsWithStatus({});
  for (const a of result) {
    assert.equal(a.status, "needs_setup", `agent ${a.id} should be needs_setup with empty env`);
  }
});

test("listAgentsWithStatus: anthropic agents are connected with full fixture env", () => {
  const fixtureEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: "tok_test",
    CLAUDEOS_GEMINI_AUTH_OK: "1",
    CLAUDEOS_CODEX_AUTH_OK: "1",
    CLAUDEOS_GH_AUTH_OK: "1",
    CLAUDEOS_DEEPSEEK_API_KEY: "sk-deep",
    CLAUDEOS_KIMI_API_KEY: "sk-kimi",
    CLAUDEOS_XAI_API_KEY: "xai-test",
    CLAUDEOS_MISTRAL_API_KEY: "mst-test",
    CLAUDEOS_GROQ_API_KEY: "gsk-test",
  };
  const result = listAgentsWithStatus(fixtureEnv);
  assert.equal(result.length, 13);
  for (const a of result) {
    assert.equal(a.status, "connected", `agent ${a.id} should be connected with full fixture env`);
  }
});

test("listAgentsWithStatus: partial env only connects matching agents", () => {
  const partialEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: "tok_test",
  };
  const result = listAgentsWithStatus(partialEnv);
  const connected = result.filter((a) => a.status === "connected");
  const anthropicIds = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];
  assert.equal(connected.length, anthropicIds.length);
  for (const a of connected) {
    assert.ok(anthropicIds.includes(a.id), `unexpected connected agent: ${a.id}`);
  }
});

// ============================================================================
// Route tests — GET /agents
// ============================================================================

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-agents-"));
});
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeServer(): Promise<FastifyInstance> {
  return createServer({ dbPath: join(tmpDir, "test.db") });
}

test("GET /agents returns 200", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/agents" });
  assert.equal(res.statusCode, 200);
});

test("GET /agents returns all 13 agents", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/agents" });
  const body = res.json() as AgentCatalogResponse;
  assert.equal(body.agents.length, 13);
});

test("GET /agents: every agent has a status field", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/agents" });
  const body = res.json() as AgentCatalogResponse;
  for (const a of body.agents as AgentWithStatus[]) {
    assert.ok(
      a.status === "connected" || a.status === "needs_setup",
      `agent ${a.id} missing valid status`,
    );
  }
});

test("GET /agents returns all 7 alias keys", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/agents" });
  const body = res.json() as AgentCatalogResponse;
  const expectedAliases = [
    "claude-flagship",
    "claude-balanced",
    "claude-fast",
    "gemini-flagship",
    "gemini-fast",
    "openai-flagship",
    "openai-fast",
  ];
  assert.equal(Object.keys(body.aliases).length, 7);
  for (const alias of expectedAliases) {
    assert.ok(
      alias in body.aliases,
      `alias '${alias}' missing from GET /agents response`,
    );
  }
});

test("GET /agents: alias values are valid agent ids", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/agents" });
  const body = res.json() as AgentCatalogResponse;
  const agentIds = new Set(body.agents.map((a) => a.id));
  for (const [alias, targetId] of Object.entries(body.aliases)) {
    assert.ok(
      agentIds.has(targetId),
      `alias '${alias}' points to unknown agent id '${targetId}'`,
    );
  }
});
