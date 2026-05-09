/**
 * Preload script for the first-run setup window (dcp.10).
 *
 * Exposes a narrow `window.claudeosSetup` bridge so the inline page rendered
 * by `renderSetupHtml()` can hand the pasted token back to the main process
 * over IPC. Kept intentionally tiny — one method, one channel.
 */

import { contextBridge, ipcRenderer } from "electron";

export type SubmitResult =
  | { ok: true; mode: "encrypted" }
  | { ok: true; mode: "plaintext"; warning: string }
  | { ok: false; error: string };

export const SAVE_TOKEN_CHANNEL = "claudeos:save-token";

contextBridge.exposeInMainWorld("claudeosSetup", {
  submit: (token: string): Promise<SubmitResult> =>
    ipcRenderer.invoke(SAVE_TOKEN_CHANNEL, token),
});
