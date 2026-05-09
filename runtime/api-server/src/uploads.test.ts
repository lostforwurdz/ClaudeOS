import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FastifyInstance } from "fastify";

import type { Attachment, Workspace } from "@claudeos/runtime-client/contracts";

import { createServer } from "./index.js";
import { attachmentKindFor, sanitizeFilename } from "./uploads.js";

let tmpDir: string;
let workspaceDir: string;
let app: FastifyInstance | null = null;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-uploads-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "claudeos-uploads-ws-"));
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function createTestServer(): Promise<{ app: FastifyInstance; workspace: Workspace }> {
  const server = await createServer({ dbPath: join(tmpDir, "test.db") });
  const res = await server.inject({
    method: "POST",
    url: "/workspaces",
    payload: { name: "ws", dir: workspaceDir },
  });
  assert.equal(res.statusCode, 200);
  return { app: server, workspace: res.json() as Workspace };
}

function multipartBody(opts: {
  filename: string;
  contentType: string;
  body: Buffer;
  boundary: string;
  fieldName?: string;
}): Buffer {
  const { filename, contentType, body, boundary, fieldName = "file" } = opts;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([head, body, tail]);
}

test("sanitizeFilename strips path traversal and shell-hostile chars", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("a b c.txt"), "a_b_c.txt");
  assert.equal(sanitizeFilename("../.hidden"), "hidden");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename("good_name-1.png"), "good_name-1.png");
  assert.equal(sanitizeFilename("café.jpg"), "café.jpg");
  assert.equal(sanitizeFilename("C:\\Windows\\evil.exe"), "evil.exe");
});

test("attachmentKindFor maps mime types correctly", () => {
  assert.equal(attachmentKindFor("image/png"), "image");
  assert.equal(attachmentKindFor("image/jpeg"), "image");
  assert.equal(attachmentKindFor("application/pdf"), "file");
  assert.equal(attachmentKindFor("text/plain"), "file");
});

test("POST /workspaces/:id/uploads writes file and returns Attachment", async () => {
  const ctx = await createTestServer();
  app = ctx.app;

  const boundary = "----claudeostest";
  const body = multipartBody({
    filename: "screenshot.png",
    contentType: "image/png",
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
    boundary,
  });

  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${ctx.workspace.id}/uploads`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });

  assert.equal(res.statusCode, 200);
  const att = res.json() as Attachment;
  assert.equal(att.kind, "image");
  assert.equal(att.mime_type, "image/png");
  assert.match(att.workspace_path, /^uploads\/[a-f0-9-]{36}-screenshot\.png$/);

  const onDisk = join(workspaceDir, att.workspace_path);
  assert.equal(statSync(onDisk).size, 10);
  const content = readFileSync(onDisk);
  assert.equal(content[0], 0x89);
  assert.equal(content[1], 0x50);
});

test("POST /workspaces/:id/uploads sanitizes filename with traversal attempt", async () => {
  const ctx = await createTestServer();
  app = ctx.app;

  const boundary = "----claudeostest";
  const body = multipartBody({
    filename: "../../etc/passwd",
    contentType: "text/plain",
    body: Buffer.from("root:x:0:0\n", "utf8"),
    boundary,
  });

  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${ctx.workspace.id}/uploads`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });

  assert.equal(res.statusCode, 200);
  const att = res.json() as Attachment;
  assert.equal(att.kind, "file");
  assert.match(att.workspace_path, /^uploads\/[a-f0-9-]{36}-passwd$/);

  // Confirm nothing landed outside the workspace.
  const uploadsDir = join(workspaceDir, "uploads");
  const entries = readdirSync(uploadsDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /-passwd$/);
});

test("POST /workspaces/:id/uploads returns 404 for unknown workspace", async () => {
  const ctx = await createTestServer();
  app = ctx.app;

  const boundary = "----claudeostest";
  const body = multipartBody({
    filename: "x.txt",
    contentType: "text/plain",
    body: Buffer.from("hi", "utf8"),
    boundary,
  });

  const res = await app.inject({
    method: "POST",
    url: `/workspaces/does-not-exist/uploads`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });

  assert.equal(res.statusCode, 404);
});

test("POST /workspaces/:id/uploads returns 415 when not multipart", async () => {
  const ctx = await createTestServer();
  app = ctx.app;

  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${ctx.workspace.id}/uploads`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ hi: "there" }),
  });

  assert.equal(res.statusCode, 415);
});
