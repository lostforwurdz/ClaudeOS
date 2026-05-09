import test from "node:test";
import assert from "node:assert/strict";

import {
  renderPreflightHtml,
  renderSetupHtml,
  runPreflight,
  type WhichLookup,
} from "./preflight.js";

const okWhich: WhichLookup = async (b) => `/usr/local/bin/${b}`;
const noWhich: WhichLookup = async () => null;

test("preflight returns ok with the claude path when both checks pass", async () => {
  const result = await runPreflight({
    oauthToken: "sk-...",
    which: okWhich,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("type narrow");
  assert.equal(result.claudePath, "/usr/local/bin/claude");
});

test("preflight fails with missing_claude_cli when which finds nothing", async () => {
  const result = await runPreflight({
    oauthToken: "sk-...",
    which: noWhich,
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("type narrow");
  assert.equal(result.code, "missing_claude_cli");
  assert.match(result.body, /isn't on this machine's PATH/);
});

test("preflight fails with missing_oauth_token when token is unset/empty/whitespace", async () => {
  for (const token of [undefined, "", "   "]) {
    const result = await runPreflight({ oauthToken: token, which: okWhich });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("type narrow");
    assert.equal(result.code, "missing_oauth_token");
    assert.match(result.body, /claude setup-token/);
  }
});

test("missing_claude_cli short-circuits before the token check", async () => {
  const result = await runPreflight({
    oauthToken: undefined, // would fail on its own
    which: noWhich,
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("type narrow");
  assert.equal(result.code, "missing_claude_cli", "claude check must run first");
});

test("preflight: bundledClaudePath wins over PATH lookup (skips `which`)", async () => {
  let whichCalled = false;
  const whichSpy: WhichLookup = async () => {
    whichCalled = true;
    return "/usr/local/bin/claude";
  };
  const result = await runPreflight({
    oauthToken: "sk-...",
    bundledClaudePath: "/opt/claudeos/resources/claude-cli/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    which: whichSpy,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("type narrow");
  assert.equal(
    result.claudePath,
    "/opt/claudeos/resources/claude-cli/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  );
  assert.equal(whichCalled, false, "PATH lookup must not run when bundled CLI is available");
});

test("preflight: a null bundledClaudePath falls back to PATH lookup", async () => {
  const result = await runPreflight({
    oauthToken: "sk-...",
    bundledClaudePath: null,
    which: okWhich,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("type narrow");
  assert.equal(result.claudePath, "/usr/local/bin/claude");
});

test("renderSetupHtml exposes the paste form, button, and IPC bridge call", () => {
  const html = renderSetupHtml();
  // Bridge call must match the channel exposed by preload-setup.ts.
  assert.match(html, /claudeosSetup\.submit/);
  // Critical UI hooks the page's JS targets via getElementById.
  assert.match(html, /id="token"/);
  assert.match(html, /id="save"/);
  assert.match(html, /id="status"/);
  // The setup-token instruction stays prominent so users know how to get a token.
  assert.match(html, /claude setup-token/);
});

test("renderPreflightHtml escapes user-controlled content and embeds the body", () => {
  const html = renderPreflightHtml({
    ok: false,
    code: "missing_claude_cli",
    title: "<script>alert(1)</script>",
    body: "& \"test\" <html>",
  });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&amp; &quot;test&quot; &lt;html&gt;/);
  assert.match(html, /<title>&lt;script&gt;/);
});
