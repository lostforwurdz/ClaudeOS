import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  installAutoUpdater,
  type AutoUpdaterLike,
  type ShowConfirmDialog,
} from "./auto-updater.js";

class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
  public autoDownload = true;
  public autoInstallOnAppQuit = true;
  public checkForUpdatesCalls = 0;
  public quitAndInstallCalls = 0;
  public nextCheckResult: Promise<unknown> = Promise.resolve(null);
  async checkForUpdates(): Promise<unknown> {
    this.checkForUpdatesCalls += 1;
    return this.nextCheckResult;
  }
  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }
}

const noopDialog: ShowConfirmDialog = async () => ({ response: 1 });

test("installAutoUpdater is a no-op when running unpackaged", async () => {
  const updater = new FakeUpdater();
  const handle = installAutoUpdater({
    isPackaged: false,
    updater,
    showConfirmDialog: noopDialog,
  });
  assert.equal(handle.enabled, false);
  assert.equal(updater.checkForUpdatesCalls, 0);
  // Manual trigger also short-circuits.
  await handle.checkForUpdates();
  assert.equal(updater.checkForUpdatesCalls, 0);
});

test("installAutoUpdater on a packaged build kicks an initial check and pins safe defaults", async () => {
  const updater = new FakeUpdater();
  installAutoUpdater({
    isPackaged: true,
    updater,
    showConfirmDialog: noopDialog,
    log: () => {},
  });
  // electron-updater's default `autoInstallOnAppQuit` is true; we must turn it
  // off so the user always gets a prompt instead of a surprise restart loop.
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.checkForUpdatesCalls, 1);
});

test("update-downloaded prompts the user; choosing 'Restart now' calls quitAndInstall", async () => {
  const updater = new FakeUpdater();
  let dialogShown = false;
  const dialog: ShowConfirmDialog = async (opts) => {
    dialogShown = true;
    assert.match(opts.message, /1\.2\.3/);
    return { response: 0 }; // RESTART_BUTTON
  };
  installAutoUpdater({
    isPackaged: true,
    updater,
    showConfirmDialog: dialog,
    log: () => {},
  });

  // Simulate electron-updater's event after the download finishes.
  updater.emit("update-downloaded", { version: "1.2.3" });
  // Let the async dialog handler settle.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dialogShown, true);
  assert.equal(updater.quitAndInstallCalls, 1);
});

test("update-downloaded with 'Later' does NOT call quitAndInstall", async () => {
  const updater = new FakeUpdater();
  const dialog: ShowConfirmDialog = async () => ({ response: 1 }); // LATER
  installAutoUpdater({
    isPackaged: true,
    updater,
    showConfirmDialog: dialog,
    log: () => {},
  });
  updater.emit("update-downloaded", { version: "1.2.3" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.quitAndInstallCalls, 0);
});

test("startup-check rejection is swallowed via the error event (does not throw)", async () => {
  const updater = new FakeUpdater();
  updater.nextCheckResult = Promise.reject(new Error("network down"));
  const errorMessages: string[] = [];
  installAutoUpdater({
    isPackaged: true,
    updater,
    showConfirmDialog: noopDialog,
    log: (level, message) => {
      if (level === "error") errorMessages.push(message);
    },
  });
  // Emit the error the way electron-updater would; the listener installed by
  // the wrapper logs it instead of crashing.
  updater.emit("error", new Error("network down"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    errorMessages.some((m) => m.includes("network down")),
    "error event must be logged via the configured logger",
  );
});

test("manual checkForUpdates() invokes the underlying updater", async () => {
  const updater = new FakeUpdater();
  const handle = installAutoUpdater({
    isPackaged: true,
    updater,
    showConfirmDialog: noopDialog,
    log: () => {},
  });
  // Initial check counts as 1; manual is the second.
  assert.equal(updater.checkForUpdatesCalls, 1);
  await handle.checkForUpdates();
  assert.equal(updater.checkForUpdatesCalls, 2);
});

test("manual checkForUpdates() catches rejections so callers don't have to", async () => {
  const updater = new FakeUpdater();
  const handle = installAutoUpdater({
    isPackaged: true,
    updater,
    showConfirmDialog: noopDialog,
    log: () => {},
  });
  updater.nextCheckResult = Promise.reject(new Error("bad feed"));
  await handle.checkForUpdates(); // must not throw
});
