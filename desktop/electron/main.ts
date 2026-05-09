import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { app, BrowserWindow, shell } from "electron";

const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.CLAUDEOS_PORT ?? 7878);
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? null;

let apiServer: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function spawnApiServer(): ChildProcess {
  const apiServerEntry = join(__dirname, "..", "..", "..", "runtime", "api-server", "dist", "index.mjs");
  const child = spawn(process.execPath, [apiServerEntry], {
    env: {
      ...process.env,
      CLAUDEOS_HOST: API_HOST,
      CLAUDEOS_PORT: String(API_PORT),
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.error(`[claudeos] api-server exited with code ${code}`);
  });
  return child;
}

function createWindow(): BrowserWindow {
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

void app.whenReady().then(() => {
  apiServer = spawnApiServer();
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
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
