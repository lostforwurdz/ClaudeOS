/**
 * Preload script for the first-run setup window (dcp.10 / kobramaz-7ho).
 *
 * Exposes a narrow `window.claudeosSetup` bridge so the inline page rendered
 * by `renderSetupHtml()` can hand the pasted token back to the main process
 * over IPC, and stream live PTY output from `claude setup-token`.
 *
 * The existing `submit(token)` paste path is kept unchanged. The PTY bridge
 * methods are additive.
 */

import { contextBridge, ipcRenderer } from "electron";

export type SubmitResult =
  | { ok: true; mode: "encrypted" }
  | { ok: true; mode: "plaintext"; warning: string }
  | { ok: false; error: string };

export const SAVE_TOKEN_CHANNEL = "claudeos:save-token";
export const SETUP_TOKEN_START_CHANNEL = "claudeos:setup-token:start";
export const SETUP_TOKEN_WRITE_CHANNEL = "claudeos:setup-token:write";
export const SETUP_TOKEN_DATA_CHANNEL = "claudeos:setup-token:data";
export const SETUP_TOKEN_EXIT_CHANNEL = "claudeos:setup-token:exit";

contextBridge.exposeInMainWorld("claudeosSetup", {
  // --- existing paste-token path (unchanged) ---
  submit: (token: string): Promise<SubmitResult> =>
    ipcRenderer.invoke(SAVE_TOKEN_CHANNEL, token),

  // --- interactive PTY path (dcp.10 v2) ---

  /** Asks the main process to spawn `claude setup-token` in a PTY. */
  startSetupToken: (): Promise<void> =>
    ipcRenderer.invoke(SETUP_TOKEN_START_CHANNEL),

  /**
   * Write a line to the running PTY's stdin (e.g. the OAuth code the user
   * pastes back when the browser redirects).
   */
  writeSetupInput: (input: string): Promise<void> =>
    ipcRenderer.invoke(SETUP_TOKEN_WRITE_CHANNEL, input),

  /** Subscribe to raw PTY output chunks (may contain ANSI escapes). */
  onSetupData: (handler: (chunk: string) => void): void => {
    ipcRenderer.on(SETUP_TOKEN_DATA_CHANNEL, (_event, chunk: string) =>
      handler(chunk),
    );
  },

  /** Subscribe to PTY process exit. Fired once with the numeric exit code. */
  onSetupExit: (handler: (code: number) => void): void => {
    ipcRenderer.on(SETUP_TOKEN_EXIT_CHANNEL, (_event, code: number) =>
      handler(code),
    );
  },
});
