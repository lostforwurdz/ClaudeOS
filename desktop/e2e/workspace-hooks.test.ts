/**
 * a17.8 / kobramaz-02g: workspace hooks editor E2E.
 *
 * Smoke-test the full path: open the dialog from the sidebar 🪝 button,
 * type a PostToolUse command, click Save, and verify the PATCH /workspaces/:id
 * round-trips and persists. Uses the same packaged-build harness as
 * lifecycle.test.ts.
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

test("workspace hooks: open editor, save PostToolUse, PATCH round-trips and persists", async () => {
  const { application, page } = await launchApp();
  app = application;

  // 1. Create a workspace through the UI (same pattern as lifecycle.test.ts).
  const newButton = page.locator('button[title^="Create new workspace"]');
  await newButton.waitFor({ state: "visible", timeout: 30_000 });
  await newButton.click();
  await page.fill('input[placeholder="my-project"]', "hooks-e2e-ws");
  await page.fill('input[placeholder="/home/me/projects/my-project"]', workspaceDir);
  const createWait = page.waitForResponse(
    (res) => res.url().endsWith("/workspaces") && res.request().method() === "POST",
    { timeout: 10_000 },
  );
  await page.click('button:has-text("Create")');
  const createRes = await createWait;
  assert.equal(createRes.status(), 200);
  const createdWs = (await createRes.json()) as { id: string; hooks: unknown };
  assert.equal(createdWs.hooks ?? null, null, "fresh workspace must have no hooks");
  const workspaceId = createdWs.id;

  // 2. Hover the row to reveal the 🪝 hooks button, then click it.
  await page.getByText("hooks-e2e-ws", { exact: true }).first().hover();
  const hooksButton = page
    .locator('button[title^="Edit workspace hooks"]')
    .first();
  await hooksButton.waitFor({ state: "visible", timeout: 5_000 });
  await hooksButton.click();

  // 3. Dialog should render with both empty textareas + the workspace name.
  await page
    .getByText("Workspace hooks", { exact: true })
    .waitFor({ state: "visible", timeout: 5_000 });
  // The PostToolUse textarea is identified by its placeholder.
  const postToolUseInput = page.locator(
    'textarea[placeholder="npm run lint --silent"]',
  );
  await postToolUseInput.waitFor({ state: "visible", timeout: 5_000 });

  // 4. Fill PostToolUse with a multi-line value (one command per line) and Save.
  await postToolUseInput.fill("echo first\necho second");
  const patchWait = page.waitForResponse(
    (res) =>
      res.url().includes(`/workspaces/${workspaceId}`) &&
      res.request().method() === "PATCH",
    { timeout: 10_000 },
  );
  await page.click('button:has-text("Save")');
  const patchRes = await patchWait;
  assert.equal(patchRes.status(), 200);
  const updated = (await patchRes.json()) as {
    id: string;
    hooks: { post_tool_use?: string[]; stop?: string[] } | null;
  };
  assert.deepEqual(
    updated.hooks?.post_tool_use,
    ["echo first", "echo second"],
    "saved hooks must round-trip in PATCH response",
  );
  assert.equal(
    updated.hooks?.stop,
    undefined,
    "Stop must remain absent when not edited",
  );

  // 5. Dialog closes after Save (HooksDialog calls onSaved → setEditingHooksWs(null)).
  await page
    .getByText("Workspace hooks", { exact: true })
    .waitFor({ state: "hidden", timeout: 5_000 });

  // 6. Persistence check: GET the workspace directly and confirm the hooks
  // survived. This is the migration-relevant guarantee — the row is real,
  // not just dialog state.
  const persisted = await page.evaluate(async (id) => {
    const res = await fetch(`http://127.0.0.1:7878/workspaces/${id}`);
    return res.json();
  }, workspaceId);
  assert.deepEqual(
    (persisted as { hooks: { post_tool_use?: string[] } }).hooks?.post_tool_use,
    ["echo first", "echo second"],
  );
});

test("workspace hooks: Clear button removes hooks via PATCH {hooks: null}", async () => {
  const { application, page } = await launchApp();
  app = application;

  // Seed via API directly so the test focuses on the Clear path.
  const newButton = page.locator('button[title^="Create new workspace"]');
  await newButton.waitFor({ state: "visible", timeout: 30_000 });
  await newButton.click();
  await page.fill('input[placeholder="my-project"]', "hooks-clear-ws");
  await page.fill('input[placeholder="/home/me/projects/my-project"]', workspaceDir);
  const createWait = page.waitForResponse(
    (res) => res.url().endsWith("/workspaces") && res.request().method() === "POST",
    { timeout: 10_000 },
  );
  await page.click('button:has-text("Create")');
  const createRes = await createWait;
  const createdWs = (await createRes.json()) as { id: string };
  const workspaceId = createdWs.id;

  // Pre-seed hooks via API so Clear has something to remove. The renderer
  // owns the workspace list, so we must reload its view via the UI: open
  // and close the hooks dialog after seeding so the saved row is re-fetched.
  await page.evaluate(
    async ({ id }) => {
      await fetch(`http://127.0.0.1:7878/workspaces/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hooks: { post_tool_use: ["seeded"] } }),
      });
    },
    { id: workspaceId },
  );
  // Force the renderer to refetch by reloading. Simpler than wiring a manual
  // refresh — the localStorage userDataDir keeps the workspace list source-of-truth.
  await page.reload();
  await page
    .getByText("hooks-clear-ws", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  // Open hooks dialog.
  await page.getByText("hooks-clear-ws", { exact: true }).first().hover();
  await page.locator('button[title^="Edit workspace hooks"]').first().click();
  await page
    .getByText("Workspace hooks", { exact: true })
    .waitFor({ state: "visible", timeout: 5_000 });

  // Click Clear (visible because workspace.hooks is non-null after seeding).
  const patchWait = page.waitForResponse(
    (res) =>
      res.url().includes(`/workspaces/${workspaceId}`) &&
      res.request().method() === "PATCH",
    { timeout: 10_000 },
  );
  await page.click('button:has-text("Clear")');
  const patchRes = await patchWait;
  assert.equal(patchRes.status(), 200);
  const updated = (await patchRes.json()) as { hooks: unknown };
  assert.equal(updated.hooks ?? null, null, "Clear must drop hooks back to null");
});
