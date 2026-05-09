import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveBundledClaude, type FileExists } from "./bundled-claude.js";

const POSIX_RES = "/Applications/ClaudeOS.app/Contents/Resources";
const WIN_RES = "C:/Program Files/ClaudeOS/resources";

function existsOnly(allowed: Set<string>): FileExists {
  return (p) => allowed.has(p);
}

test("packaged: returns the resources/claude-cli binary when it exists", () => {
  const expected = join(
    POSIX_RES,
    "claude-cli/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  );
  const path = resolveBundledClaude({
    resourcesPath: POSIX_RES,
    packaged: true,
    platform: "linux",
    exists: existsOnly(new Set([expected])),
  });
  assert.equal(path, expected);
});

test("packaged: returns null when the bundled binary is missing", () => {
  const path = resolveBundledClaude({
    resourcesPath: POSIX_RES,
    packaged: true,
    platform: "linux",
    exists: () => false,
  });
  assert.equal(path, null);
});

test("packaged: lookup composes with whatever resourcesPath we are handed", () => {
  // Verify the resolver doesn't hard-code POSIX assumptions: any string we
  // pass as resourcesPath becomes the prefix of the candidate path. On
  // Windows the runtime path module produces backslash separators; here we
  // just confirm the *logical* composition.
  const expected = join(
    WIN_RES,
    "claude-cli/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  );
  const path = resolveBundledClaude({
    resourcesPath: WIN_RES,
    packaged: true,
    platform: "win32",
    exists: existsOnly(new Set([expected])),
  });
  assert.equal(path, expected);
});

test("dev: walks up from electronMainDir to repo root and finds the sidecar", () => {
  // Simulate `desktop/out/electron/main.js` — three levels up to repo root.
  const electronMainDir = "/home/me/ClaudeOS/desktop/out/electron";
  const expected = join(
    "/home/me/ClaudeOS",
    "packages/claude-cli/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  );
  const path = resolveBundledClaude({
    resourcesPath: "/unused-in-dev",
    electronMainDir,
    packaged: false,
    platform: "linux",
    exists: existsOnly(new Set([expected])),
  });
  assert.equal(path, expected);
});

test("dev: falls back to the two-up layout when the three-up path is missing", () => {
  // Some dev layouts (raw tsc output) put main.js at desktop/electron/main.js.
  const electronMainDir = "/home/me/ClaudeOS/desktop/electron";
  const expected = join(
    "/home/me/ClaudeOS",
    "packages/claude-cli/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  );
  const path = resolveBundledClaude({
    resourcesPath: "/unused-in-dev",
    electronMainDir,
    packaged: false,
    platform: "linux",
    exists: existsOnly(new Set([expected])),
  });
  assert.equal(path, expected);
});

test("dev: returns null when electronMainDir is undefined", () => {
  const path = resolveBundledClaude({
    resourcesPath: "/unused",
    packaged: false,
    platform: "linux",
    exists: () => true,
  });
  assert.equal(path, null);
});
