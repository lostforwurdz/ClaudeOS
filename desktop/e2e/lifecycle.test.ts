/**
 * MVP-parity #5 (kobramaz-ajr.5): launch the packaged Electron build,
 * exercise workspace create + delete through the UI, and verify the
 * api-server is reachable. Running this regularly catches the kinds of
 * regressions we hit at session start:
 *
 *   - better-sqlite3 ABI drift (api-server fails to boot, preflight times out)
 *   - @fastify/cors v11 method default (DELETE preflight rejected by browser)
 *   - port conflicts from stale dev processes (api-server bind fails)
 *
 * Test harness: node:test + playwright._electron. We run against the
 * production build (out/electron/main.js loads the file:// renderer)
 * because Vite dev mode would require a separate server.
 */

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

// The renderer's API base is hardcoded to http://127.0.0.1:7878, so the
// api-server must bind to the default port. Tests run sequentially and
// afterEach closes the app, so the port is freed between tests.
const API_PORT = 7878;

let tmpDir: string;
let workspaceDir: string;
let app: ElectronApplication | null = null;

beforeEach(() => {
  if (!existsSync(MAIN_JS)) {
    throw new Error(
      `out/electron/main.js missing — run 'npm --prefix desktop run build' before E2E (saw ${MAIN_JS})`,
    );
  }
  tmpDir = mkdtempSync(join(tmpdir(), "claudeos-e2e-"));
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
  const application = await electron.launch({
    args: [MAIN_JS],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Preflight needs a token (any non-empty value passes the env check)
      // and a `claude` binary on PATH. The fake script satisfies the latter.
      CLAUDE_CODE_OAUTH_TOKEN: "e2e-dummy-token",
      PATH: `${dirname(FAKE_CLAUDE)}:${process.env.PATH ?? ""}`,
      // Renderer's API_BASE is hardcoded to 127.0.0.1:7878; keep the default.
      CLAUDEOS_PORT: String(API_PORT),
      CLAUDEOS_DB_PATH: join(tmpDir, "state.db"),
      // Silence packaged-build telemetry + auto-update during tests.
      NODE_ENV: "test",
    },
  });
  const page = await application.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  return { application, page };
}

test("smoke: app boots, api-server health endpoint responds", async () => {
  const { application, page } = await launchApp();
  app = application;

  // Hit /health from inside the renderer — proves both the server is up
  // *and* CORS lets the renderer talk to it (catches the v11 default-methods
  // regression we just fixed).
  const status = await page.evaluate(async () => {
    const res = await fetch(`http://127.0.0.1:7878/health`);
    return res.status;
  });
  assert.equal(status, 200);
});

test("workspace lifecycle: create via UI, then delete via UI", async () => {
  const { application, page } = await launchApp();
  app = application;

  // Capture console + page errors so timeouts give us a useful tail.
  const consoleEvents: string[] = [];
  page.on("console", (msg) => consoleEvents.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleEvents.push(`[pageerror] ${err.message}`));

  // Open the create-workspace modal (the "+" button in the sidebar header).
  // Wait for the button to be visible — by the time it's actionable, the
  // boot-time GET /workspaces has already settled.
  const newButton = page.locator('button[title="Create new workspace"]');
  try {
    await newButton.waitFor({ state: "visible", timeout: 30_000 });
  } catch (err) {
    const title = await page.title().catch(() => "<unknown>");
    const html = await page.content().catch(() => "<unreadable>");
    throw new Error(
      `+ button not found. title=${title}\nhtml (first 1500 chars): ${html.slice(0, 1500)}\nconsole tail:\n${consoleEvents.slice(-15).join("\n")}\nunderlying: ${(err as Error).message}`,
    );
  }
  await newButton.click();

  // Fill the modal and submit.
  await page.fill('input[placeholder="my-project"]', "e2e-test-ws");
  await page.fill(
    'input[placeholder="/home/me/projects/my-project"]',
    workspaceDir,
  );
  await page.click('button:has-text("Create")');

  // Wait for POST /workspaces and assert success.
  const createRes = await page.waitForResponse(
    (res) => res.url().endsWith("/workspaces") && res.request().method() === "POST",
    { timeout: 10_000 },
  );
  assert.equal(createRes.status(), 200);

  // The new workspace tab/name should appear in the DOM.
  const wsLocator = page.getByText("e2e-test-ws", { exact: true }).first();
  await wsLocator.waitFor({ state: "visible", timeout: 10_000 });

  // Auto-accept the delete confirm() dialog. Belt-and-suspenders: register
  // the dialog handler AND override window.confirm in the page directly
  // (Electron's native confirm doesn't always surface as a Playwright dialog
  // event, depending on chromium version).
  page.on("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.evaluate(() => {
    window.confirm = () => true;
  });

  // The trash button only renders while the row is hovered (App.tsx
  // WorkspaceRow). Hover the row by its name first, then click.
  await page.getByText("e2e-test-ws", { exact: true }).first().hover();
  const trash = page.locator('button[title^="Delete workspace"]').first();
  try {
    await trash.click({ timeout: 30_000 });
  } catch (err) {
    const html = await page.content().catch(() => "<unreadable>");
    throw new Error(
      `delete button not found.\nhtml (first 3000 chars): ${html.slice(0, 3000)}\nconsole tail:\n${consoleEvents.slice(-15).join("\n")}\nunderlying: ${(err as Error).message}`,
    );
  }

  const delRes = await page.waitForResponse(
    (res) => res.url().includes("/workspaces/") && res.request().method() === "DELETE",
    { timeout: 10_000 },
  );
  // 200 from the api-server. 0 would indicate the request was blocked by
  // CORS — the regression check for @fastify/cors v11 default methods.
  assert.equal(delRes.status(), 200, `DELETE returned ${delRes.status()}`);
});
