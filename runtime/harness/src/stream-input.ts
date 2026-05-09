/**
 * Build the stream-json user message Claude Code consumes via
 * `--input-format stream-json`.
 *
 * Used when a RunRequest carries attachments. Image attachments embed as
 * `image` content blocks (base64 inline). File attachments aren't part of the
 * Claude content-block schema, so we surface them as a footer in the text
 * block — Claude can read them off the workspace via the Read tool.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Attachment, RunRequest } from "@claudeos/runtime-client/contracts";

/** Reads attachment bytes; injectable for tests. */
export type AttachmentReader = (absolutePath: string) => Promise<Buffer>;

const defaultReader: AttachmentReader = (p) => readFile(p);

interface ImageContentBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

interface TextContentBlock {
  type: "text";
  text: string;
}

type ContentBlock = TextContentBlock | ImageContentBlock;

export interface StreamUserMessage {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[];
  };
}

export interface BuildOptions {
  workspaceDir: string;
  reader?: AttachmentReader;
}

/**
 * Build the JSON-RPC-shaped user message that Claude Code reads on stdin
 * when invoked with `--input-format stream-json`. Image bytes are loaded from
 * the workspace; non-image files are mentioned in the trailing text block so
 * the agent knows to Read them.
 *
 * Order of content blocks:
 *   1. Text: the instruction, followed by an "Attached files:" footer if any
 *      non-image attachments exist.
 *   2. Image blocks, in the order the attachments arrived.
 */
export async function buildStreamUserMessage(
  request: RunRequest,
  opts: BuildOptions,
): Promise<StreamUserMessage> {
  const reader = opts.reader ?? defaultReader;
  const attachments = request.attachments ?? [];

  const images: Attachment[] = [];
  const files: Attachment[] = [];
  for (const a of attachments) {
    if (a.kind === "image") images.push(a);
    else files.push(a);
  }

  const text = composeText(request.instruction, files);
  const content: ContentBlock[] = [{ type: "text", text }];

  for (const img of images) {
    const data = await reader(join(opts.workspaceDir, img.workspace_path));
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mime_type,
        data: data.toString("base64"),
      },
    });
  }

  return {
    type: "user",
    message: { role: "user", content },
  };
}

function composeText(instruction: string, files: Attachment[]): string {
  if (files.length === 0) return instruction;
  const list = files.map((f) => `- ${f.workspace_path} (${f.mime_type})`).join("\n");
  return `${instruction}\n\nAttached files (already staged in your workspace):\n${list}`;
}

/**
 * True when the request needs `--input-format stream-json`. Today that's
 * exactly when at least one attachment is present.
 */
export function needsStreamInput(request: RunRequest): boolean {
  return (request.attachments ?? []).length > 0;
}
