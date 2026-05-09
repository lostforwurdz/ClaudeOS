/**
 * Preload script for the main BrowserWindow (kobramaz-46i / xh5.1 follow-up).
 *
 * Exposes a narrow `window.claudeos.token` bridge so the Settings panel can
 * read the saved-token status, forget the current token, and re-open the
 * first-run setup window without requiring the user to relaunch the app.
 *
 * Why a separate file from `preload-setup.ts`: the setup window's preload
 * exposes write paths (`submit`, `startSetupToken`, etc.) that the main app
 * doesn't need. Splitting keeps each surface minimal.
 */

import { contextBridge, ipcRenderer } from "electron";

export const TOKEN_STATUS_CHANNEL = "claudeos:token:status";
export const TOKEN_CLEAR_CHANNEL = "claudeos:token:clear";
export const TOKEN_RESTART_SETUP_CHANNEL = "claudeos:token:restart-setup";

export interface TokenStatus {
  /** True when a non-empty token is persisted in safeStorage. */
  present: boolean;
  /** True when safeStorage is encrypting at rest (vs. fallback plaintext). */
  encrypted: boolean;
}

contextBridge.exposeInMainWorld("claudeos", {
  token: {
    /** Read the current token's persistence state without revealing the value. */
    status: (): Promise<TokenStatus> =>
      ipcRenderer.invoke(TOKEN_STATUS_CHANNEL) as Promise<TokenStatus>,
    /** Drop the persisted token. The user must restart to re-enter setup. */
    clear: (): Promise<void> => ipcRenderer.invoke(TOKEN_CLEAR_CHANNEL),
    /** Pop the first-run setup window so the user can paste a fresh token. */
    restartSetup: (): Promise<void> => ipcRenderer.invoke(TOKEN_RESTART_SETUP_CHANNEL),
  },
});
