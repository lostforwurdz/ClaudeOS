import test from "node:test";
import assert from "node:assert/strict";

import type { RunRequest } from "@claudeos/runtime-client/contracts";

import {
  buildStreamUserMessage,
  needsStreamInput,
  type AttachmentReader,
} from "./stream-input.js";

const BASE: RunRequest = {
  workspace_id: "ws-1",
  session_id: "s-1",
  input_id: "in-1",
  instruction: "Summarize the screenshot.",
};

const fakeReader = (contents: Record<string, Buffer>): AttachmentReader =>
  async (path: string) => {
    if (!(path in contents)) throw new Error(`unexpected read: ${path}`);
    return contents[path];
  };

test("needsStreamInput is false when no attachments", () => {
  assert.equal(needsStreamInput(BASE), false);
  assert.equal(needsStreamInput({ ...BASE, attachments: [] }), false);
});

test("needsStreamInput is true with any attachment", () => {
  assert.equal(
    needsStreamInput({
      ...BASE,
      attachments: [{ kind: "file", workspace_path: "x.txt", mime_type: "text/plain" }],
    }),
    true,
  );
});

test("buildStreamUserMessage with no attachments returns just the text block", async () => {
  const msg = await buildStreamUserMessage(BASE, { workspaceDir: "/ws" });
  assert.deepEqual(msg, {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "Summarize the screenshot." }],
    },
  });
});

test("buildStreamUserMessage embeds image attachments as base64 content blocks", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const reader = fakeReader({ "/ws/uploads/diag.png": png });

  const msg = await buildStreamUserMessage(
    {
      ...BASE,
      attachments: [
        {
          kind: "image",
          workspace_path: "uploads/diag.png",
          mime_type: "image/png",
        },
      ],
    },
    { workspaceDir: "/ws", reader },
  );

  assert.equal(msg.message.content.length, 2);
  assert.equal(msg.message.content[0].type, "text");
  assert.equal(msg.message.content[1].type, "image");

  if (msg.message.content[1].type !== "image") throw new Error("type narrow");
  assert.deepEqual(msg.message.content[1].source, {
    type: "base64",
    media_type: "image/png",
    data: png.toString("base64"),
  });
});

test("buildStreamUserMessage appends a 'Attached files' footer for non-image attachments", async () => {
  const msg = await buildStreamUserMessage(
    {
      ...BASE,
      attachments: [
        {
          kind: "file",
          workspace_path: "uploads/spec.md",
          mime_type: "text/markdown",
        },
        {
          kind: "file",
          workspace_path: "uploads/sample.json",
          mime_type: "application/json",
        },
      ],
    },
    { workspaceDir: "/ws" },
  );

  assert.equal(msg.message.content.length, 1); // only text block
  if (msg.message.content[0].type !== "text") throw new Error("type narrow");
  const text = msg.message.content[0].text;
  assert.match(text, /Summarize the screenshot\./);
  assert.match(text, /Attached files \(already staged in your workspace\):/);
  assert.match(text, /- uploads\/spec\.md \(text\/markdown\)/);
  assert.match(text, /- uploads\/sample\.json \(application\/json\)/);
});

test("buildStreamUserMessage handles a mix: text + footer + image blocks, ordered correctly", async () => {
  const png = Buffer.from("fake-png");
  const jpg = Buffer.from("fake-jpg");
  const reader = fakeReader({
    "/ws/uploads/a.png": png,
    "/ws/uploads/b.jpg": jpg,
  });

  const msg = await buildStreamUserMessage(
    {
      ...BASE,
      attachments: [
        { kind: "image", workspace_path: "uploads/a.png", mime_type: "image/png" },
        { kind: "file", workspace_path: "uploads/notes.txt", mime_type: "text/plain" },
        { kind: "image", workspace_path: "uploads/b.jpg", mime_type: "image/jpeg" },
      ],
    },
    { workspaceDir: "/ws", reader },
  );

  // Block order: text first, then images in original order.
  assert.equal(msg.message.content.length, 3);
  assert.equal(msg.message.content[0].type, "text");
  assert.equal(msg.message.content[1].type, "image");
  assert.equal(msg.message.content[2].type, "image");

  if (msg.message.content[0].type !== "text") throw new Error("type narrow");
  assert.match(msg.message.content[0].text, /uploads\/notes\.txt/);

  if (msg.message.content[1].type !== "image") throw new Error("type narrow");
  if (msg.message.content[2].type !== "image") throw new Error("type narrow");
  assert.equal(msg.message.content[1].source.media_type, "image/png");
  assert.equal(msg.message.content[2].source.media_type, "image/jpeg");
  assert.equal(msg.message.content[1].source.data, png.toString("base64"));
  assert.equal(msg.message.content[2].source.data, jpg.toString("base64"));
});
