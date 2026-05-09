import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { app, BrowserWindow, shell } from "electron";

import { resolveBundledClaude } from "./bundled-claude.js";
import {
  renderPreflightHtml,
  runPreflight,
  type PreflightResult,
} from "./preflight.js";

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

void app.whenReady().then(async () => {
  const bundledClaudePath = resolveBundledClaude({
    resourcesPath: process.resourcesPath,
    electronMainDir: __dirname,
    packaged: app.isPackaged,
  });
  const result = await runPreflight({
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    bundledClaudePath,
  });

  if (!result.ok) {
    mainWindow = createPreflightWindow(result);
    return;
  }

  apiServer = spawnApiServer(result.claudePath);
  mainWindow = createMainWindow();

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
