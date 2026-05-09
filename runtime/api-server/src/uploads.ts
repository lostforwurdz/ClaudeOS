/**
 * File upload endpoint for staging attachments into a workspace.
 *
 * Desktop POSTs `multipart/form-data` to `/workspaces/:id/uploads`; the bytes
 * are written to `<workspaceDir>/uploads/<uuid>-<safe-name>` and the response
 * is an `Attachment` ready to be embedded in a subsequent RunRequest.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Attachment } from "@claudeos/runtime-client/contracts";

export const UPLOADS_SUBDIR = "uploads";

/** Max bytes per uploaded file. Mirrors @fastify/multipart `limits.fileSize`. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Strip path separators and shell-hostile characters out of a user-supplied
 * filename. Keeps unicode letters/numbers, dots, dashes, underscores; collapses
 * everything else to `_`. Strips leading dots so we never produce `.dotfiles`
 * or `..` traversal segments. Falls back to `file` if the cleaned name is empty.
 */
export function sanitizeFilename(input: string): string {
  // Drop any path components — only keep the basename.
  const base = input.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/** Map a MIME type to the Attachment.kind discriminator. */
export function attachmentKindFor(mimeType: string): Attachment["kind"] {
  return mimeType.startsWith("image/") ? "image" : "file";
}

export interface SaveUploadInput {
  workspaceDir: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Write `bytes` to `<workspaceDir>/uploads/<uuid>-<safe-name>` and return the
 * Attachment record describing it. The upload directory is created lazily.
 */
export async function saveUpload(input: SaveUploadInput): Promise<Attachment> {
  const safeName = sanitizeFilename(input.filename);
  const fileName = `${randomUUID()}-${safeName}`;
  const workspacePath = `${UPLOADS_SUBDIR}/${fileName}`;

  const uploadsDir = join(input.workspaceDir, UPLOADS_SUBDIR);
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(join(uploadsDir, fileName), input.bytes);

  return {
    kind: attachmentKindFor(input.mimeType),
    workspace_path: workspacePath,
    mime_type: input.mimeType,
  };
}
