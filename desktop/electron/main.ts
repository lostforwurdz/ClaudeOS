import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { autoUpdater } from "electron-updater";

import { createAuthStore, type SaveResult } from "./auth-store.js";
import {
  installAutoUpdater,
  type AutoUpdaterLike,
} from "./auto-updater.js";
import { resolveBundledClaude } from "./bundled-claude.js";
import {
  renderPreflightHtml,
  renderSetupHtml,
  runPreflight,
  type PreflightResult,
} from "./preflight.js";

const SAVE_TOKEN_CHANNEL = "claudeos:save-token";

const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.CLAUDEOS_PORT ?? 7878);
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? null;

let apiServer: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * Resolve the api-server entry path. In dev `electron/main.ts` is built to
 * `desktop/out/electron/main.js`, so the api-server lives at
 * `../../runtime/api-server/dist/index.mjs` from there. In a packaged build
 * the `extraResources` config copies api-server into `resources/api-server/`,
 * so we look there first.
 */
function resolveApiServerEntry(): string {
  const packagedCandidates = [
    join(process.resourcesPath, "api-server", "dist", "index.mjs"),
  ];
  const devCandidates = [
    // From `desktop/out/electron/main.js` up to repo root.
    resolve(__dirname, "..", "..", "..", "runtime", "api-server", "dist", "index.mjs"),
    // From `desktop/electron/main.js` (raw tsc layout, fallback).
    resolve(__dirname, "..", "..", "runtime", "api-server", "dist", "index.mjs"),
  ];
  const candidates = app.isPackaged ? packagedCandidates : devCandidates;
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  // Return the first candidate so the resulting spawn error is informative
  // (the path it tried) rather than a silent existsSync miss.
  return candidates[0];
}

function resolveBrowserMcpEntry(): string | null {
  const packaged = join(process.resourcesPath, "browser-mcp", "dist", "index.mjs");
  const devCandidates = [
    resolve(__dirname, "..", "..", "..", "packages", "browser-mcp", "dist", "index.mjs"),
    resolve(__dirname, "..", "..", "packages", "browser-mcp", "dist", "index.mjs"),
  ];
  if (app.isPackaged) {
    return existsSync(packaged) ? packaged : null;
  }
  for (const path of devCandidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function spawnApiServer(claudePath: string): ChildProcess {
  const apiServerEntry = resolveApiServerEntry();
  const browserMcp = resolveBrowserMcpEntry();
  const child = spawn(process.execPath, [apiServerEntry], {
    env: {
      ...process.env,
      CLAUDEOS_HOST: API_HOST,
      CLAUDEOS_PORT: String(API_PORT),
      // Resolved here so the harness can find claude even when the user's
      // GUI session inherited a stripped PATH (common on macOS).
      CLAUDEOS_CLAUDE_BINARY: claudePath,
      ...(browserMcp ? { CLAUDEOS_BROWSER_MCP_BIN: browserMcp } : {}),
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.error(`[claudeos] api-server exited with code ${code}`);
  });
  return child;
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#0a0a0a",
    title: "ClaudeOS",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  }
  return win;
}

function createPreflightWindow(failure: Extract<PreflightResult, { ok: false }>): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 480,
    backgroundColor: "#0e0e0e",
    title: `ClaudeOS — ${failure.title}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const html = renderPreflightHtml(failure);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

function resolveSetupPreloadPath(): string {
  const candidates = app.isPackaged
    ? [join(__dirname, "preload-setup.js")]
    : [
        join(__dirname, "preload-setup.js"),
        // Raw tsc layout fallback when running from desktop/electron/.
        resolve(__dirname, "..", "out", "electron", "preload-setup.js"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    backgroundColor: "#0e0e0e",
    title: "ClaudeOS — Sign in",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolveSetupPreloadPath(),
    },
  });
  const html = renderSetupHtml();
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

void app.whenReady().then(async () => {
  const authStore = createAuthStore({
    userDataDir: app.getPath("userData"),
    safeStorage,
  });

  const bundledClaudePath = resolveBundledClaude({
    resourcesPath: process.resourcesPath,
    electronMainDir: __dirname,
    packaged: app.isPackaged,
  });

  // Token resolution order: explicit env var (lets advanced users override),
  // then a previously-saved token from safeStorage. The setup flow writes
  // into safeStorage, so subsequent launches skip the prompt.
  const startupToken =
    (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim().length > 0
      ? process.env.CLAUDE_CODE_OAUTH_TOKEN
      : authStore.loadToken();

  const startMain = async (token: string): Promise<void> => {
    const result = await runPreflight({
      oauthToken: token,
      bundledClaudePath,
    });
    if (!result.ok) {
      mainWindow = createPreflightWindow(result);
      return;
    }
    // Make sure the api-server child sees the token even when it wasn't in
    // the original env (e.g. token came from safeStorage).
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    apiServer = spawnApiServer(result.claudePath);
    mainWindow = createMainWindow();

    // dcp.11: silent check + download, prompt before restart. No-op in dev.
    installAutoUpdater({
      isPackaged: app.isPackaged,
      updater: autoUpdater as unknown as AutoUpdaterLike,
      showConfirmDialog: async (opts) => dialog.showMessageBox(opts),
    });
  };

  // Wire the IPC handler before opening the setup window so the renderer
  // can submit as soon as the page is interactive.
  ipcMain.handle(SAVE_TOKEN_CHANNEL, async (_event, raw: unknown): Promise<SaveResult> => {
    if (typeof raw !== "string") {
      return { ok: false, error: "token must be a string" };
    }
    const result = authStore.saveToken(raw);
    if (result.ok) {
      // Close the setup window and proceed with normal startup. Schedule on
      // the next tick so the renderer has a chance to display the success.
      const setupWindow = mainWindow;
      setTimeout(() => {
        if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
        void startMain(raw.trim());
      }, 350);
    }
    return result;
  });

  if (startupToken && startupToken.trim().length > 0) {
    await startMain(startupToken);
  } else {
    mainWindow = createSetupWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (apiServer && !apiServer.killed) {
    apiServer.kill("SIGTERM");
  }
});
