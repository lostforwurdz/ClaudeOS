import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { Domain, LaunchSkillResponse, Skill, Workspace } from "@claudeos/runtime-client/contracts";

import { createServer } from "./index.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-skills-"));
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

// Helper: create a domain via the API.
async function createDomain(server: FastifyInstance, name = "TestDomain"): Promise<Domain> {
  const res = await server.inject({
    method: "POST",
    url: "/domains",
    payload: { name },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as Domain;
}

// Helper: create a skill via the API.
async function createSkill(
  server: FastifyInstance,
  domainId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Skill> {
  const res = await server.inject({
    method: "POST",
    url: "/skills",
    payload: {
      name: "Test Skill",
      domain_id: domainId,
      prompt_template: "Do {{thing}}",
      ...overrides,
    },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as Skill;
}

// Helper: create a workspace (needed for launch tests).
async function createWorkspace(server: FastifyInstance): Promise<Workspace> {
  const res = await server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "launch-ws", dir: tmpDir },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as Workspace;
}

// Seed counts from fresh DB.
const SEEDED_DOMAINS = 3;
const SEEDED_SKILLS = 5;

// ---------------------------------------------------------------------------
// Seed coverage — explicit per plan requirement
// ---------------------------------------------------------------------------

test("seed: fresh DB has exactly 3 domains and 5 skills", async () => {
  app = await makeServer();

  const dRes = await app.inject({ method: "GET", url: "/domains" });
  assert.equal(dRes.statusCode, 200);
  const domains = dRes.json() as Domain[];
  assert.equal(domains.length, SEEDED_DOMAINS, `expected ${SEEDED_DOMAINS} seeded domains`);

  const sRes = await app.inject({ method: "GET", url: "/skills" });
  assert.equal(sRes.statusCode, 200);
  const skills = sRes.json() as Skill[];
  assert.equal(skills.length, SEEDED_SKILLS, `expected ${SEEDED_SKILLS} seeded skills`);
});

test("seed: re-opening the DB does NOT duplicate seed data", async () => {
  const dbPath = join(tmpDir, "seed-dedup.db");

  // First open — seeds.
  const app1 = await createServer({ dbPath });
  const d1 = (await app1.inject({ method: "GET", url: "/domains" })).json() as Domain[];
  await app1.close();

  // Second open — must not double the seed.
  const app2 = await createServer({ dbPath });
  const d2 = (await app2.inject({ method: "GET", url: "/domains" })).json() as Domain[];
  await app2.close();

  assert.equal(d2.length, d1.length, "re-opening DB must not duplicate domains");

  const app3 = await createServer({ dbPath });
  const s3 = (await app3.inject({ method: "GET", url: "/skills" })).json() as Skill[];
  await app3.close();

  assert.equal(s3.length, SEEDED_SKILLS, "re-opening DB must not duplicate skills");
});

// ---------------------------------------------------------------------------
// Skills CRUD
// ---------------------------------------------------------------------------

test("POST /skills with valid body returns skill with defaults applied", async () => {
  app = await makeServer();
  const domain = await createDomain(app);

  const res = await app.inject({
    method: "POST",
    url: "/skills",
    payload: {
      name: "My Skill",
      domain_id: domain.id,
      prompt_template: "Do the thing",
    },
  });
  assert.equal(res.statusCode, 200);
  const skill = res.json() as Skill;
  assert.equal(skill.name, "My Skill");
  assert.equal(skill.domain_id, domain.id);
  assert.equal(skill.prompt_template, "Do the thing");
  assert.equal(skill.description, "");
  assert.equal(skill.mode_id, "default");
  assert.equal(skill.target_workspace_id, null);
  assert.equal(skill.is_automation, false);
  assert.equal(skill.schedule_cron, null);
  assert.equal(skill.hotkey, null);
  assert.equal(typeof skill.sort_order, "number");
  assert.ok(skill.created_at, "created_at must be set");
  assert.ok(skill.updated_at, "updated_at must be set");
});

test("POST /skills with is_automation=true returns boolean true", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id, { is_automation: true });
  assert.equal(skill.is_automation, true);
  assert.ok(typeof skill.is_automation === "boolean");
});

test("POST /skills accepts any mode_id string (server is lenient)", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id, { mode_id: "some-future-mode" });
  assert.equal(skill.mode_id, "some-future-mode");
});

test("POST /skills rejects when domain_id does not exist (422)", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "POST",
    url: "/skills",
    payload: {
      name: "Orphan",
      domain_id: "non-existent-domain-id",
      prompt_template: "test",
    },
  });
  assert.equal(res.statusCode, 422);
  const body = res.json() as { code: string };
  assert.equal(body.code, "domain_not_found");
});

test("GET /skills lists all skills (seeded + created)", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  await createSkill(app, domain.id, { name: "Extra Skill" });

  const res = await app.inject({ method: "GET", url: "/skills" });
  assert.equal(res.statusCode, 200);
  const skills = res.json() as Skill[];
  assert.ok(skills.length >= SEEDED_SKILLS + 1, "must include seeded + new skill");
});

test("GET /skills?domain_id filters by domain", async () => {
  app = await makeServer();
  const domain = await createDomain(app, "FilterDomain");
  const skill = await createSkill(app, domain.id, { name: "Only Mine" });

  const res = await app.inject({
    method: "GET",
    url: `/skills?domain_id=${domain.id}`,
  });
  assert.equal(res.statusCode, 200);
  const skills = res.json() as Skill[];
  assert.ok(skills.every((s) => s.domain_id === domain.id), "all results must match domain_id");
  assert.ok(skills.some((s) => s.id === skill.id), "our skill must appear");
});

test("GET /skills/:id returns the skill", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const created = await createSkill(app, domain.id);

  const res = await app.inject({ method: "GET", url: `/skills/${created.id}` });
  assert.equal(res.statusCode, 200);
  const fetched = res.json() as Skill;
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.name, created.name);
});

test("GET /skills/:id returns 404 for unknown skill", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/skills/does-not-exist" });
  assert.equal(res.statusCode, 404);
});

test("PATCH /skills/:id round-trips a name update and bumps updated_at", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id, { name: "Original" });

  await new Promise((r) => setTimeout(r, 10));

  const patch = await app.inject({
    method: "PATCH",
    url: `/skills/${skill.id}`,
    payload: { name: "Updated" },
  });
  assert.equal(patch.statusCode, 200);
  const updated = patch.json() as Skill;
  assert.equal(updated.name, "Updated");
  assert.equal(updated.id, skill.id);
  assert.notEqual(updated.updated_at, skill.updated_at, "updated_at must advance");
});

test("PATCH /skills/:id updates mode_id (any string accepted)", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id);

  const patch = await app.inject({
    method: "PATCH",
    url: `/skills/${skill.id}`,
    payload: { mode_id: "architect" },
  });
  assert.equal(patch.statusCode, 200);
  const updated = patch.json() as Skill;
  assert.equal(updated.mode_id, "architect");
});

test("PATCH /skills/:id with empty body returns 400", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id);

  const patch = await app.inject({
    method: "PATCH",
    url: `/skills/${skill.id}`,
    payload: {},
  });
  assert.equal(patch.statusCode, 400);
});

test("PATCH /skills/:id returns 404 for unknown skill", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "PATCH",
    url: "/skills/does-not-exist",
    payload: { name: "X" },
  });
  assert.equal(res.statusCode, 404);
});

test("PATCH /skills/:id with invalid domain_id returns 422", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id);

  const patch = await app.inject({
    method: "PATCH",
    url: `/skills/${skill.id}`,
    payload: { domain_id: "bad-domain-id" },
  });
  assert.equal(patch.statusCode, 422);
  const body = patch.json() as { code: string };
  assert.equal(body.code, "domain_not_found");
});

test("DELETE /skills/:id removes the skill", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id);

  const del = await app.inject({ method: "DELETE", url: `/skills/${skill.id}` });
  assert.equal(del.statusCode, 204);

  const after = await app.inject({ method: "GET", url: `/skills/${skill.id}` });
  assert.equal(after.statusCode, 404, "skill must be gone after DELETE");
});

test("DELETE /skills/:id returns 404 for unknown skill", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "DELETE", url: "/skills/missing" });
  assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Launch endpoint
// ---------------------------------------------------------------------------

test("POST /skills/:id/launch returns LaunchSkillResponse", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const skill = await createSkill(app, domain.id);

  const res = await app.inject({
    method: "POST",
    url: `/skills/${skill.id}/launch`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as LaunchSkillResponse;
  assert.equal(body.skill.id, skill.id);
  assert.equal(body.resolved_workspace_id, null, "no target_workspace_id set → null");
});

test("POST /skills/:id/launch resolves target_workspace_id when workspace exists", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const workspace = await createWorkspace(app);
  const skill = await createSkill(app, domain.id, {
    target_workspace_id: workspace.id,
  });

  const res = await app.inject({
    method: "POST",
    url: `/skills/${skill.id}/launch`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as LaunchSkillResponse;
  assert.equal(body.resolved_workspace_id, workspace.id);
});

test("POST /skills/:id/launch returns null resolved_workspace_id when target workspace deleted", async () => {
  app = await makeServer();
  const domain = await createDomain(app);
  const workspace = await createWorkspace(app);
  const skill = await createSkill(app, domain.id, {
    target_workspace_id: workspace.id,
  });

  // Delete the workspace — skill's target_workspace_id becomes null via ON DELETE SET NULL.
  const del = await app.inject({ method: "DELETE", url: `/workspaces/${workspace.id}` });
  assert.equal(del.statusCode, 200);

  const res = await app.inject({
    method: "POST",
    url: `/skills/${skill.id}/launch`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as LaunchSkillResponse;
  assert.equal(
    body.resolved_workspace_id,
    null,
    "deleted workspace must yield null resolved_workspace_id",
  );
  // Skill itself must still exist.
  assert.equal(body.skill.id, skill.id);
});

test("POST /skills/:id/launch returns 404 for unknown skill", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "POST", url: "/skills/missing/launch" });
  assert.equal(res.statusCode, 404);
});
