import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { Domain } from "@claudeos/runtime-client/contracts";

import { createServer } from "./index.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-domains-"));
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

// Helper: count seeded items from a fresh DB.
const SEEDED_DOMAINS = 3;

test("GET /domains returns seeded domains ordered by sort_order ASC", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "GET", url: "/domains" });
  assert.equal(res.statusCode, 200);
  const domains = res.json() as Domain[];
  assert.equal(domains.length, SEEDED_DOMAINS);
  // sort_order must be non-decreasing
  for (let i = 1; i < domains.length; i++) {
    assert.ok(
      domains[i].sort_order >= domains[i - 1].sort_order,
      "domains must be ordered by sort_order ASC",
    );
  }
});

test("POST /domains assigns ascending sort_order when omitted", async () => {
  app = await makeServer();
  // Insert two additional domains without explicit sort_order.
  const r1 = await app.inject({
    method: "POST",
    url: "/domains",
    payload: { name: "Alpha" },
  });
  assert.equal(r1.statusCode, 200);
  const d1 = r1.json() as Domain;

  const r2 = await app.inject({
    method: "POST",
    url: "/domains",
    payload: { name: "Beta" },
  });
  assert.equal(r2.statusCode, 200);
  const d2 = r2.json() as Domain;

  assert.ok(d2.sort_order > d1.sort_order, "second domain sort_order must exceed first");
});

test("POST /domains with explicit sort_order respects it", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "POST",
    url: "/domains",
    payload: { name: "Explicit", sort_order: 99 },
  });
  assert.equal(res.statusCode, 200);
  const domain = res.json() as Domain;
  assert.equal(domain.sort_order, 99);
  assert.equal(domain.name, "Explicit");
});

test("POST /domains rejects missing name (400)", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "POST",
    url: "/domains",
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH /domains/:id updates name and bumps updated_at", async () => {
  app = await makeServer();
  const create = await app.inject({
    method: "POST",
    url: "/domains",
    payload: { name: "Old" },
  });
  const domain = create.json() as Domain;

  await new Promise((r) => setTimeout(r, 10));

  const patch = await app.inject({
    method: "PATCH",
    url: `/domains/${domain.id}`,
    payload: { name: "New" },
  });
  assert.equal(patch.statusCode, 200);
  const updated = patch.json() as Domain;
  assert.equal(updated.name, "New");
  assert.equal(updated.id, domain.id);
  assert.notEqual(updated.updated_at, domain.updated_at, "updated_at must advance");
});

test("PATCH /domains/:id updates sort_order", async () => {
  app = await makeServer();
  const create = await app.inject({
    method: "POST",
    url: "/domains",
    payload: { name: "SortTest", sort_order: 5 },
  });
  const domain = create.json() as Domain;

  const patch = await app.inject({
    method: "PATCH",
    url: `/domains/${domain.id}`,
    payload: { sort_order: 42 },
  });
  assert.equal(patch.statusCode, 200);
  const updated = patch.json() as Domain;
  assert.equal(updated.sort_order, 42);
});

test("PATCH /domains/:id with empty body returns 400", async () => {
  app = await makeServer();
  const create = await app.inject({
    method: "POST",
    url: "/domains",
    payload: { name: "EmptyPatch" },
  });
  const domain = create.json() as Domain;

  const patch = await app.inject({
    method: "PATCH",
    url: `/domains/${domain.id}`,
    payload: {},
  });
  assert.equal(patch.statusCode, 400);
});

test("PATCH /domains/:id returns 404 for unknown domain", async () => {
  app = await makeServer();
  const res = await app.inject({
    method: "PATCH",
    url: "/domains/does-not-exist",
    payload: { name: "X" },
  });
  assert.equal(res.statusCode, 404);
});

test("DELETE /domains/:id cascades to skills", async () => {
  app = await makeServer();

  // Create a domain.
  const createDomain = await app.inject({
    method: "POST",
    url: "/domains",
    payload: { name: "CascadeTest" },
  });
  assert.equal(createDomain.statusCode, 200);
  const domain = createDomain.json() as Domain;

  // Create a skill in that domain.
  const createSkill = await app.inject({
    method: "POST",
    url: "/skills",
    payload: {
      name: "Skill in domain",
      domain_id: domain.id,
      prompt_template: "test prompt",
    },
  });
  assert.equal(createSkill.statusCode, 200);
  const skill = createSkill.json() as { id: string };

  // Delete the domain — should cascade.
  const del = await app.inject({ method: "DELETE", url: `/domains/${domain.id}` });
  assert.equal(del.statusCode, 204);

  // Domain gone.
  const afterDomain = await app.inject({ method: "GET", url: `/domains` });
  const domains = afterDomain.json() as Domain[];
  assert.ok(
    !domains.some((d) => d.id === domain.id),
    "deleted domain must not appear in list",
  );

  // Skill cascaded.
  const afterSkill = await app.inject({ method: "GET", url: `/skills/${skill.id}` });
  assert.equal(afterSkill.statusCode, 404, "skill must be cascade-deleted with domain");
});

test("DELETE /domains/:id returns 404 for unknown domain", async () => {
  app = await makeServer();
  const res = await app.inject({ method: "DELETE", url: "/domains/missing" });
  assert.equal(res.statusCode, 404);
});
