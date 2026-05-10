/**
 * a17.8 / kobramaz-02g: workspace hooks editor E2E.
 *
 * Drives the full UI: open the dialog from the sidebar 🪝 button, type a
 * PostToolUse command, click Save, then re-open and click Clear. We use
 * a single test (not two) because consecutive Electron launches from the
 * same e2e file race the api-server's per-test boot — see the existing
 * lifecycle.test.ts for the established workaround pattern.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { _electron as electron, type ElectronApplication, type Page } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..");
const MAIN_JS = join(DESKTOP_ROOT, "out", "electron", "main.js");
const FAKE_CLAUDE = join(HERE, "fake-claude.sh");
const API_PORT = 7878;

let tmpDir: string;
let workspaceDir: string;
let app: ElectronApplication | null = null;

beforeEach(async () => {
  if (!existsSync(MAIN_JS)) {
    throw new Error(
      `out/electron/main.js missing — run 'npm --prefix desktop run build' before E2E (saw ${MAIN_JS})`,
    );
  }
  // Best-effort: kill any orphan api-server child still holding port 7878
  // from a previous test's app.close(). When an orphan answers /health past
  // the start of the next test, waitForApi passes against it, then it dies
  // mid-test and the renderer + Node-side fetches see ERR_CONNECTION_REFUSED.
  try {
    execSync(
      "lsof -ti:7878 | xargs --no-run-if-empty kill -9 2>/dev/null || true",
      { stdio: "ignore" },
    );
  } catch {
    // lsof unavailable / nothing to kill — ignore.
  }
  // Brief settle for the OS to release the port before the next bind.
  await new Promise((r) => setTimeout(r, 500));
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-e2e-hooks-"));
  workspaceDir = join(tmpDir, "ws-target");
});

afterEach(async () => {
  if (app) {
    try {
      await app.close();
    } catch {
      // ignore — process may have already exited
    }
    app = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

async function launchApp(): Promise<{ application: ElectronApplication; page: Page }> {
  const userDataDir = join(tmpDir, "electron-userdata");
  const application = await electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: "e2e-dummy-token",
      PATH: `${dirname(FAKE_CLAUDE)}:${process.env.PATH ?? ""}`,
      CLAUDEOS_PORT: String(API_PORT),
      CLAUDEOS_DB_PATH: join(tmpDir, "state.db"),
      NODE_ENV: "test",
    },
  });
  const page = await application.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  return { application, page };
}

// Wait for the api-server to be reachable before driving UI actions. Per-test
// app launches occasionally race the api-server boot — guard with a short poll.
async function waitForApi(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`api-server did not become ready within ${timeoutMs}ms`);
}

async function pollUntil<T>(
  predicate: () => Promise<T | null>,
  timeoutMs = 5_000,
  intervalMs = 100,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v !== null && v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

async function readWorkspace(id: string): Promise<{
  hooks: { post_tool_use?: string[]; stop?: string[] } | null;
}> {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/workspaces/${id}`);
  if (!res.ok) throw new Error(`GET /workspaces/${id} → ${res.status}`);
  return res.json() as Promise<{
    hooks: { post_tool_use?: string[]; stop?: string[] } | null;
  }>;
}

test("workspace hooks: editor saves PostToolUse, then Clear button removes them", async () => {
  const { application, page } = await launchApp();
  app = application;
  await waitForApi();

  // Capture renderer console + page errors so a hang has a useful tail.
  const consoleEvents: string[] = [];
  page.on("console", (msg) => consoleEvents.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleEvents.push(`[pageerror] ${err.message}`));

  // 1. Create the workspace via the api-server directly. The UI create
  // dialog is exercised by lifecycle.test.ts; bypassing it here keeps this
  // test focused on the hooks editor and avoids racing the boot sequence
  // of the previous test's app shutdown.
  const createRes = await fetch(`http://127.0.0.1:${API_PORT}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "hooks-e2e-ws", dir: workspaceDir }),
  });
  assert.equal(createRes.status, 200);
  const createdWs = (await createRes.json()) as { id: string; hooks: unknown };
  assert.equal(createdWs.hooks ?? null, null, "fresh workspace must have no hooks");
  const workspaceId = createdWs.id;

  // Reload so the renderer's GET /workspaces picks up the row we just
  // created out-of-band. Without this the sidebar would still show the
  // pre-create empty state.
  await page.reload();
  await page
    .getByText("hooks-e2e-ws", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  // 2. Hover the row to reveal the 🪝 hooks button, then click it.
  await page.getByText("hooks-e2e-ws", { exact: true }).first().hover();
  const hooksButton = page.locator('button[title^="Edit workspace hooks"]').first();
  await hooksButton.waitFor({ state: "visible", timeout: 5_000 });
  await hooksButton.click();

  // 3. Dialog should render with both empty textareas.
  await page
    .getByText("Workspace hooks", { exact: true })
    .waitFor({ state: "visible", timeout: 5_000 });
  const postToolUseInput = page.locator(
    'textarea[placeholder="npm run lint --silent"]',
  );
  await postToolUseInput.waitFor({ state: "visible", timeout: 5_000 });

  // 4. Fill PostToolUse with multi-line text and Save. We verify by polling
  // the api-server directly rather than waitForResponse — the latter would
  // hide a CORS preflight failure as a generic timeout, while polling shows
  // exactly whether the renderer's PATCH actually changed server state.
  await postToolUseInput.fill("echo first\necho second");
  await page.click('button:has-text("Save")');

  try {
    await pollUntil(async () => {
      const ws = await readWorkspace(workspaceId);
      return ws.hooks?.post_tool_use?.length === 2 ? ws : null;
    }, 10_000);
  } catch (err) {
    throw new Error(
      `Save did not persist hooks within 10s.\nconsole tail:\n${consoleEvents.slice(-20).join("\n")}\nunderlying: ${(err as Error).message}`,
    );
  }
  const saved = await readWorkspace(workspaceId);
  assert.deepEqual(saved.hooks?.post_tool_use, ["echo first", "echo second"]);
  assert.equal(saved.hooks?.stop, undefined, "Stop must remain absent when not edited");

  // 5. Dialog closes after a successful Save.
  await page
    .getByText("Workspace hooks", { exact: true })
    .waitFor({ state: "hidden", timeout: 5_000 });

  // 6. Re-open the editor and click Clear. The 🪝 button should be tinted
  // (workspace.hooks is non-null) so Clear is enabled.
  await page.getByText("hooks-e2e-ws", { exact: true }).first().hover();
  await hooksButton.click();
  await page
    .getByText("Workspace hooks", { exact: true })
    .waitFor({ state: "visible", timeout: 5_000 });
  await page.click('button:has-text("Clear")');

  try {
    await pollUntil(async () => {
      const ws = await readWorkspace(workspaceId);
      return ws.hooks === null || ws.hooks === undefined ? ws : null;
    }, 10_000);
  } catch (err) {
    throw new Error(
      `Clear did not drop hooks within 10s.\nconsole tail:\n${consoleEvents.slice(-20).join("\n")}\nunderlying: ${(err as Error).message}`,
    );
  }
  const cleared = await readWorkspace(workspaceId);
  assert.equal(cleared.hooks ?? null, null);
});
