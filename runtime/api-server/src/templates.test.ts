import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { TemplateSummary, Workspace } from "@claudeos/runtime-client/contracts";

import { createServer } from "./index.js";
import { applyTemplate, listTemplates, TemplateError } from "./templates.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-templates-"));
});
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFakeTemplatesDir(): string {
  const root = join(tmpDir, "templates");
  mkdirSync(join(root, "alpha", "subdir"), { recursive: true });
  writeFileSync(
    join(root, "alpha", "template.json"),
    JSON.stringify({ name: "alpha", description: "alpha description" }),
  );
  writeFileSync(join(root, "alpha", "INSTRUCTIONS.md"), "alpha instructions\n");
  writeFileSync(join(root, "alpha", "subdir", "nested.txt"), "nested\n");

  // A directory with no manifest is silently skipped.
  mkdirSync(join(root, "no-manifest"), { recursive: true });
  writeFileSync(join(root, "no-manifest", "stray.txt"), "stray");

  return root;
}

test("listTemplates returns manifest-bearing dirs sorted by name", () => {
  const root = makeFakeTemplatesDir();
  // Add a second template to verify sort order.
  mkdirSync(join(root, "beta"), { recursive: true });
  writeFileSync(
    join(root, "beta", "template.json"),
    JSON.stringify({ name: "beta", description: "beta description" }),
  );
  const list = listTemplates(root);
  assert.deepEqual(
    list.map((t) => t.name),
    ["alpha", "beta"],
  );
  assert.equal(list[0].description, "alpha description");
});

test("listTemplates returns [] when the dir is missing", () => {
  const list = listTemplates(join(tmpDir, "does-not-exist"));
  assert.deepEqual(list, []);
});

test("applyTemplate copies seed files (skipping template.json) into the target", () => {
  const root = makeFakeTemplatesDir();
  const target = join(tmpDir, "ws");
  const seeded = applyTemplate("alpha", target, root).sort();
  assert.deepEqual(seeded, ["INSTRUCTIONS.md", join("subdir", "nested.txt")].sort());
  assert.equal(readFileSync(join(target, "INSTRUCTIONS.md"), "utf8"), "alpha instructions\n");
  assert.equal(readFileSync(join(target, "subdir", "nested.txt"), "utf8"), "nested\n");
  assert.equal(existsSync(join(target, "template.json")), false, "manifest must not be copied");
});

test("applyTemplate creates the workspace dir if it does not exist", () => {
  const root = makeFakeTemplatesDir();
  const target = join(tmpDir, "ws-fresh");
  assert.equal(existsSync(target), false);
  applyTemplate("alpha", target, root);
  assert.ok(existsSync(target));
});

test("applyTemplate refuses to clobber existing files (atomic)", () => {
  const root = makeFakeTemplatesDir();
  const target = join(tmpDir, "ws-conflict");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "INSTRUCTIONS.md"), "user content");
  assert.throws(
    () => applyTemplate("alpha", target, root),
    (err: Error) => err instanceof TemplateError && (err as TemplateError).code === "conflict",
  );
  // Pre-existing file must be untouched.
  assert.equal(readFileSync(join(target, "INSTRUCTIONS.md"), "utf8"), "user content");
  // No partial state from the other seed file either.
  assert.equal(existsSync(join(target, "subdir", "nested.txt")), false);
});

test("applyTemplate throws not_found for unknown template", () => {
  const root = makeFakeTemplatesDir();
  assert.throws(
    () => applyTemplate("nope", join(tmpDir, "ws"), root),
    (err: Error) => err instanceof TemplateError && (err as TemplateError).code === "not_found",
  );
});

test("GET /templates lists shipped templates (general, web-research)", async () => {
  // Use the real shipped templates dir (default).
  app = await createServer({ dbPath: join(tmpDir, "test.db") });
  const res = await app.inject({ method: "GET", url: "/templates" });
  assert.equal(res.statusCode, 200);
  const list = res.json() as TemplateSummary[];
  const names = list.map((t) => t.name).sort();
  assert.ok(names.includes("general"), `expected 'general' in ${names.join(", ")}`);
  assert.ok(names.includes("web-research"), `expected 'web-research' in ${names.join(", ")}`);
});

test("POST /workspaces with template seeds the dir", async () => {
  const root = makeFakeTemplatesDir();
  app = await createServer({
    dbPath: join(tmpDir, "test.db"),
    templatesDir: root,
  });
  const wsDir = join(tmpDir, "seeded-ws");
  const res = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "seeded", dir: wsDir, template: "alpha" },
  });
  assert.equal(res.statusCode, 200);
  const ws = res.json() as Workspace;
  assert.equal(ws.name, "seeded");
  assert.ok(existsSync(join(wsDir, "INSTRUCTIONS.md")), "template seed file must exist");
  assert.ok(existsSync(join(wsDir, "subdir", "nested.txt")));
});

test("POST /workspaces returns 404 for unknown template", async () => {
  const root = makeFakeTemplatesDir();
  app = await createServer({
    dbPath: join(tmpDir, "test.db"),
    templatesDir: root,
  });
  const res = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "x", dir: join(tmpDir, "nope-ws"), template: "nope" },
  });
  assert.equal(res.statusCode, 404);
  // Workspace must NOT have been inserted.
  const list = await app.inject({ method: "GET", url: "/workspaces" });
  assert.deepEqual(list.json(), []);
});

test("POST /workspaces with template returns 400 on conflict and does not insert", async () => {
  const root = makeFakeTemplatesDir();
  app = await createServer({
    dbPath: join(tmpDir, "test.db"),
    templatesDir: root,
  });
  const wsDir = join(tmpDir, "conflict-ws");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "INSTRUCTIONS.md"), "pre-existing");

  const res = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "x", dir: wsDir, template: "alpha" },
  });
  assert.equal(res.statusCode, 400);
  const list = await app.inject({ method: "GET", url: "/workspaces" });
  assert.deepEqual(list.json(), []);
  assert.equal(readFileSync(join(wsDir, "INSTRUCTIONS.md"), "utf8"), "pre-existing");
});

test("POST /workspaces without template behaves as before (no seeding)", async () => {
  app = await createServer({ dbPath: join(tmpDir, "test.db") });
  const wsDir = join(tmpDir, "plain-ws");
  const res = await app.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "plain", dir: wsDir },
  });
  assert.equal(res.statusCode, 200);
  // No template ⇒ dir is not auto-created.
  assert.equal(existsSync(wsDir), false);
});
