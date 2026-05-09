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
import {
  createSetupTokenRunner,
  createRealPtyFactory,
  type SetupTokenRunner,
} from "./setup-token-runner.js";

const SAVE_TOKEN_CHANNEL = "claudeos:save-token";
const SETUP_TOKEN_START_CHANNEL = "claudeos:setup-token:start";
const SETUP_TOKEN_WRITE_CHANNEL = "claudeos:setup-token:write";
const SETUP_TOKEN_DATA_CHANNEL = "claudeos:setup-token:data";
const SETUP_TOKEN_EXIT_CHANNEL = "claudeos:setup-token:exit";
// kobramaz-46i: main-window-only channels for the Settings panel.
const TOKEN_STATUS_CHANNEL = "claudeos:token:status";
const TOKEN_CLEAR_CHANNEL = "claudeos:token:clear";
const TOKEN_RESTART_SETUP_CHANNEL = "claudeos:token:restart-setup";

const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.CLAUDEOS_PORT ?? 7878);
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? null;

// Surface promise rejections in the main process with a real stack instead of
// the opaque "(rejection id: N)" warning. Without this any async path that
// rejects (failed window load, IPC handler throw, harness spawn error) is
// effectively invisible at the developer terminal.
process.on("unhandledRejection", (reason) => {
  console.error("[claudeos:main] UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[claudeos:main] UNCAUGHT EXCEPTION:", err);
});

let apiServer: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let setupTokenRunner: SetupTokenRunner | null = null;

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

function resolveMemoryMcpEntry(): string | null {
  const packaged = join(process.resourcesPath, "memory-mcp", "dist", "index.mjs");
  const devCandidates = [
    resolve(__dirname, "..", "..", "..", "packages", "memory-mcp", "dist", "index.mjs"),
    resolve(__dirname, "..", "..", "packages", "memory-mcp", "dist", "index.mjs"),
  ];
  if (app.isPackaged) {
    return existsSync(packaged) ? packaged : null;
  }
  for (const path of devCandidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * xh4.2: locate the bundled permission-hook launcher so the api-server can
 * point claude's --settings at it. Layout mirrors the bundled CLI resolver
 * (packaged: extraResources copy; dev: walk up to repo root).
 */
function resolvePermissionHookEntry(): string | null {
  const packaged = join(process.resourcesPath, "claude-cli", "permission-hook.js");
  const devCandidates = [
    resolve(__dirname, "..", "..", "..", "packages", "claude-cli", "permission-hook.js"),
    resolve(__dirname, "..", "..", "packages", "claude-cli", "permission-hook.js"),
  ];
  if (app.isPackaged) {
    return existsSync(packaged) ? packaged : null;
  }
  for (const path of devCandidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Poll the api-server's /health endpoint until it returns 200, or give up
 * after `timeoutMs`. Without this, createMainWindow() can race the api-server
 * spawn — the renderer mounts and calls fetch() while the server is still
 * binding, which surfaces as a generic "Failed to fetch" in the UI.
 */
async function waitForApiReady(timeoutMs = 10_000): Promise<void> {
  const url = `http://${API_HOST}:${API_PORT}/health`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(
    `api-server did not become ready within ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function spawnApiServer(claudePath: string): ChildProcess {
  const apiServerEntry = resolveApiServerEntry();
  const browserMcp = resolveBrowserMcpEntry();
  const memoryMcp = resolveMemoryMcpEntry();
  const permissionHook = resolvePermissionHookEntry();
  const child = spawn(process.execPath, [apiServerEntry], {
    env: {
      ...process.env,
      CLAUDEOS_HOST: API_HOST,
      CLAUDEOS_PORT: String(API_PORT),
      // Resolved here so the harness can find claude even when the user's
      // GUI session inherited a stripped PATH (common on macOS).
      CLAUDEOS_CLAUDE_BINARY: claudePath,
      ...(browserMcp ? { CLAUDEOS_BROWSER_MCP_BIN: browserMcp } : {}),
      ...(memoryMcp ? { CLAUDEOS_MEMORY_MCP_BIN: memoryMcp } : {}),
      ...(permissionHook ? { CLAUDEOS_PERMISSION_HOOK_BIN: permissionHook } : {}),
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
      preload: resolveMainPreloadPath(),
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // Pipe renderer console messages and load failures to the main-process
  // terminal so dev-mode debugging doesn't require opening DevTools.
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const tag = ["[v]", "[i]", "[w]", "[e]"][level] ?? "[?]";
    console.error(`[claudeos:renderer] ${tag} ${sourceId}:${line}  ${message}`);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[claudeos:renderer] did-fail-load url=${validatedURL} code=${errorCode} reason=${errorDescription}`,
    );
  });
  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL).catch((err) => {
      console.error("[claudeos:main] loadURL failed:", err);
    });
    // Auto-open DevTools in dev so renderer errors are immediately visible.
    win.webContents.once("did-finish-load", () => {
      win.webContents.openDevTools({ mode: "right" });
    });
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

function resolveMainPreloadPath(): string {
  const candidates = app.isPackaged
    ? [join(__dirname, "preload-main.js")]
    : [
        join(__dirname, "preload-main.js"),
        resolve(__dirname, "..", "out", "electron", "preload-main.js"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 620,
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
  // Kill any running PTY when the user closes the setup window early.
  win.on("closed", () => {
    if (setupTokenRunner) {
      setupTokenRunner.kill();
      setupTokenRunner = null;
    }
  });
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
    // kobramaz-46i: startMain is re-runnable from the Settings re-key flow.
    // Tear down a prior api-server child + main window before respawning so
    // the new token actually takes effect (port is freed; the renderer
    // reloads against the fresh server).
    if (apiServer) {
      apiServer.kill();
      apiServer = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
      mainWindow = null;
    }
    // Make sure the api-server child sees the token even when it wasn't in
    // the original env (e.g. token came from safeStorage).
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    apiServer = spawnApiServer(result.claudePath);

    // Block opening the main window until /health responds — otherwise the
    // renderer's first fetch races the server bind and dies with
    // ERR_CONNECTION_REFUSED before any retry logic kicks in.
    try {
      await waitForApiReady();
    } catch (err) {
      console.error("[claudeos:main]", err);
      mainWindow = createPreflightWindow({
        ok: false,
        code: "missing_claude_cli",
        title: "ClaudeOS api-server failed to start",
        body: err instanceof Error ? err.message : String(err),
      });
      return;
    }
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

  // Wire PTY-based setup-token IPC handlers (dcp.10 v2 / kobramaz-7ho).
  ipcMain.handle(SETUP_TOKEN_START_CHANNEL, async (): Promise<void> => {
    // Kill any lingering runner from a previous attempt.
    if (setupTokenRunner) {
      setupTokenRunner.kill();
      setupTokenRunner = null;
    }

    const setupWindow = mainWindow; // mainWindow is the setup window at this point

    setupTokenRunner = createSetupTokenRunner({
      claudeBinary: bundledClaudePath ?? "claude",
      ptyFactory: createRealPtyFactory(),
      onData: (chunk) => {
        if (setupWindow && !setupWindow.isDestroyed()) {
          setupWindow.webContents.send(SETUP_TOKEN_DATA_CHANNEL, chunk);
        }
      },
      onToken: (token) => {
        // Auto-save the captured token via the existing save flow.
        const result = authStore.saveToken(token);
        if (result.ok) {
          setTimeout(() => {
            if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
            void startMain(token.trim());
          }, 350);
        }
      },
      onExit: (code) => {
        setupTokenRunner = null;
        if (setupWindow && !setupWindow.isDestroyed()) {
          setupWindow.webContents.send(SETUP_TOKEN_EXIT_CHANNEL, code);
        }
      },
    });

    setupTokenRunner.start();
  });

  ipcMain.handle(SETUP_TOKEN_WRITE_CHANNEL, (_event, raw: unknown): void => {
    if (typeof raw === "string" && setupTokenRunner) {
      setupTokenRunner.write(raw);
    }
  });

  // kobramaz-46i: Settings-panel handlers. The renderer reads token presence
  // (without ever seeing the value), can drop it, and can pop the setup
  // window for a re-keying flow.
  ipcMain.handle(TOKEN_STATUS_CHANNEL, () => ({
    present: (authStore.loadToken() ?? "").trim().length > 0,
    encrypted: safeStorage.isEncryptionAvailable(),
  }));

  ipcMain.handle(TOKEN_CLEAR_CHANNEL, () => {
    authStore.clearToken();
  });

  ipcMain.handle(TOKEN_RESTART_SETUP_CHANNEL, () => {
    // Open the first-run setup window. When the user completes the flow,
    // the existing SAVE_TOKEN_CHANNEL handler calls startMain again, which
    // is now re-runnable — it kills the old api-server + main window and
    // spawns fresh against the new token. Cancelling the setup window is
    // a no-op for the running app.
    createSetupWindow();
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
