/**
 * Auto-update orchestration for the packaged ClaudeOS desktop app (dcp.11).
 *
 * electron-updater handles the download mechanics; this module is just the
 * policy wrapper that decides when to check, when to prompt, and how to
 * surface progress. The real `autoUpdater` from electron-updater is injected
 * so the policy can be unit-tested with a stub.
 *
 * Default policy: silent check on startup → silent download → prompt the
 * user to restart once the install is staged. The user owns the timing of
 * the restart; we never quitAndInstall behind their back.
 */

import type { EventEmitter } from "node:events";

/**
 * Minimal surface we need from electron-updater's autoUpdater. Defined
 * structurally so a test stub doesn't have to drag in the real module.
 */
export interface AutoUpdaterLike extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Subset of Electron's `dialog.showMessageBox` we depend on. */
export type ShowConfirmDialog = (options: {
  type: "info" | "warning";
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}) => Promise<{ response: number }>;

export interface InstallAutoUpdaterInputs {
  /** True when running from a packaged app — never auto-update in dev. */
  isPackaged: boolean;
  /** Real or stub updater. */
  updater: AutoUpdaterLike;
  /** Confirmation dialog used to prompt the user before restarting. */
  showConfirmDialog: ShowConfirmDialog;
  /** Optional logger; defaults to console. */
  log?: (level: "info" | "error", message: string) => void;
}

export interface InstalledAutoUpdater {
  /** True if `installAutoUpdater` actually wired the updater (i.e., packaged). */
  enabled: boolean;
  /** Manual trigger for a "Check for updates" menu item or button. */
  checkForUpdates(): Promise<void>;
}

const RESTART_BUTTON = 0;
const LATER_BUTTON = 1;

export function installAutoUpdater(
  inputs: InstallAutoUpdaterInputs,
): InstalledAutoUpdater {
  const log = inputs.log ?? defaultLog;

  if (!inputs.isPackaged) {
    return {
      enabled: false,
      async checkForUpdates() {
        log("info", "auto-update skipped: not running a packaged build");
      },
    };
  }

  const updater = inputs.updater;
  // Default electron-updater behavior: download eagerly, install at quit.
  // We override the install side so the user gets a prompt instead of a
  // surprise restart loop, then call quitAndInstall ourselves.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;

  updater.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `auto-update error: ${message}`);
  });
  updater.on("update-available", (info: unknown) => {
    log("info", `update available: ${describe(info)}`);
  });
  updater.on("update-not-available", () => {
    log("info", "no update available");
  });
  updater.on("update-downloaded", async (info: unknown) => {
    log("info", `update downloaded: ${describe(info)}`);
    const version = readVersion(info);
    const choice = await inputs.showConfirmDialog({
      type: "info",
      title: "ClaudeOS update ready",
      message: version
        ? `Version ${version} is ready to install.`
        : "A new version is ready to install.",
      detail:
        "ClaudeOS will close, install the update, and reopen. Save any in-flight work before continuing.",
      buttons: ["Restart now", "Later"],
      defaultId: RESTART_BUTTON,
      cancelId: LATER_BUTTON,
    });
    if (choice.response === RESTART_BUTTON) {
      updater.quitAndInstall();
    }
  });

  // Kick off the initial check. We swallow rejections — the `error` event
  // handler above already logs them, and a failed startup check should never
  // block the app from launching.
  void updater.checkForUpdates().catch(() => {
    // already logged via the error event
  });

  return {
    enabled: true,
    async checkForUpdates() {
      try {
        await updater.checkForUpdates();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("error", `manual update check failed: ${message}`);
      }
    },
  };
}

function defaultLog(level: "info" | "error", message: string): void {
  const line = `[claudeos:auto-update] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

function describe(info: unknown): string {
  const v = readVersion(info);
  return v ?? "<no version metadata>";
}

function readVersion(info: unknown): string | null {
  if (info && typeof info === "object" && "version" in info) {
    const v = (info as { version: unknown }).version;
    if (typeof v === "string") return v;
  }
  return null;
}
