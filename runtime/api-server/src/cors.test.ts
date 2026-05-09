import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import { createServer } from "./index.js";

let tmpDir: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-cors-"));
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

test("CORS allows the Vite dev origin by default", async () => {
  app = await createServer({ dbPath: join(tmpDir, "test.db") });

  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://localhost:5173" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
});

test("CORS rejects unknown origins (no allow-origin header)", async () => {
  app = await createServer({ dbPath: join(tmpDir, "test.db") });

  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://evil.example.com" },
  });

  // Request still completes (server-to-server is fine), but no allow-origin header
  // means the browser will block the response.
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("CORS responds to preflight OPTIONS for the allowed origin", async () => {
  app = await createServer({ dbPath: join(tmpDir, "test.db") });

  const res = await app.inject({
    method: "OPTIONS",
    url: "/runs",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.match(String(res.headers["access-control-allow-methods"] ?? ""), /POST/);
});

test("CORS honors a custom origin list passed via ServerOptions", async () => {
  app = await createServer({
    dbPath: join(tmpDir, "test.db"),
    corsOrigins: ["http://localhost:9999"],
  });

  const allowed = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://localhost:9999" },
  });
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:9999");

  const denied = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});

test("Setting corsOrigins=false disables CORS entirely", async () => {
  app = await createServer({
    dbPath: join(tmpDir, "test.db"),
    corsOrigins: false,
  });

  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});
