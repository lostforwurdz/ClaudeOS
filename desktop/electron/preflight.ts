/**
 * Startup preflight: verify the host has everything ClaudeOS needs to run.
 *
 * Runs in the main Electron process before the BrowserWindow is created. If
 * any check fails we still create a window — but it loads a static error page
 * instead of the renderer, so the user sees actionable copy instead of a
 * broken-looking blank screen or a runtime exception in the console.
 *
 * Pure module: no Electron imports, no hard-coded paths. Test with
 * synthetic env + a stub `which` lookup.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type WhichLookup = (binary: string) => Promise<string | null>;

export interface PreflightInputs {
  /** OAuth token; in production this is `process.env.CLAUDE_CODE_OAUTH_TOKEN`. */
  oauthToken: string | undefined;
  /** Which-lookup; defaults to spawning `which`/`where`. Injectable for tests. */
  which?: WhichLookup;
  /** Override the binary name used for the PATH lookup. Defaults to "claude". */
  claudeBinary?: string;
  /**
   * Absolute path to a claude binary that ships with the app (dcp.9). When
   * present, preflight skips the PATH lookup entirely so packaged users don't
   * need their own Claude Code install. Verified for existence by the caller.
   */
  bundledClaudePath?: string | null;
}

export interface PreflightFailure {
  ok: false;
  /** Short, headline-style summary. */
  title: string;
  /** Markdown-ish body for the error overlay. */
  body: string;
  /** Stable id so tests and analytics can match without scraping the title. */
  code: "missing_claude_cli" | "missing_oauth_token";
}

export interface PreflightSuccess {
  ok: true;
  claudePath: string;
}

export type PreflightResult = PreflightSuccess | PreflightFailure;

const defaultWhich: WhichLookup = async (binary) => {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileP(lookup, [binary]);
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
};

export async function runPreflight(inputs: PreflightInputs): Promise<PreflightResult> {
  const which = inputs.which ?? defaultWhich;
  const binary = inputs.claudeBinary ?? "claude";

  // Bundled CLI (dcp.9) wins when present — skip the PATH lookup so the user
  // never needs a system-wide `claude` install.
  const claudePath = inputs.bundledClaudePath ?? (await which(binary));
  if (!claudePath) {
    return {
      ok: false,
      code: "missing_claude_cli",
      title: "Claude Code CLI not found",
      body: [
        "ClaudeOS spawns the `claude` CLI to run sessions, but it isn't on this machine's PATH.",
        "",
        "Install it from https://claude.com/claude-code, then restart ClaudeOS.",
      ].join("\n"),
    };
  }

  if (!inputs.oauthToken || inputs.oauthToken.trim().length === 0) {
    return {
      ok: false,
      code: "missing_oauth_token",
      title: "Claude OAuth token missing",
      body: [
        "ClaudeOS needs CLAUDE_CODE_OAUTH_TOKEN set in the environment to authenticate as your Claude subscription.",
        "",
        "Generate a long-lived token by running:",
        "    claude setup-token",
        "",
        "Then export the token in your shell profile and restart ClaudeOS:",
        "    export CLAUDE_CODE_OAUTH_TOKEN=<your-token>",
      ].join("\n"),
    };
  }

  return { ok: true, claudePath };
}

/**
 * Render a preflight failure as a self-contained HTML page suitable for
 * `BrowserWindow.loadURL("data:text/html,...")`. No external CSS, no fonts,
 * no Vite — works whether or not the renderer build is present.
 */
export function renderPreflightHtml(failure: PreflightFailure): string {
  // Minimal, dark, readable. Pre-formatted body so commands stay literal.
  const escapedTitle = escapeHtml(failure.title);
  const escapedBody = escapeHtml(failure.body);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapedTitle}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        padding: 48px;
        background: #0e0e0e;
        color: #e5e5e5;
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      h1 { font-size: 18px; letter-spacing: -0.2px; margin: 0 0 16px; }
      pre {
        white-space: pre-wrap;
        word-wrap: break-word;
        background: transparent;
        margin: 0;
        font: inherit;
      }
      code { color: #9bc1ff; }
      .pill {
        display: inline-block;
        padding: 2px 8px;
        font-size: 11px;
        background: #3a1010;
        color: #ff8c8c;
        border-radius: 999px;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        margin-bottom: 12px;
      }
    </style>
  </head>
  <body>
    <span class="pill">ClaudeOS preflight failed</span>
    <h1>${escapedTitle}</h1>
    <pre>${escapedBody}</pre>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render an interactive token-paste page (dcp.10 / kobramaz-7ho). Replaces
 * the static missing_oauth_token preflight error with two paths:
 *
 *   1. **Interactive PTY path** (primary): "Run claude setup-token in-app"
 *      spawns the bundled CLI inside the window, streams live output, and
 *      auto-captures the token when it appears.
 *
 *   2. **Paste path** (fallback): the original form where the user copies
 *      the token from an external terminal and pastes it.
 *
 * Self-contained: no external CSS, no fonts, no Vite. The preload script
 * (loaded by the BrowserWindow that displays this page) exposes
 * `window.claudeosSetup.submit(token)` and the PTY bridge methods.
 */
export function renderSetupHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ClaudeOS — sign in</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        padding: 36px 48px;
        background: #0e0e0e;
        color: #e5e5e5;
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      h1 { font-size: 18px; letter-spacing: -0.2px; margin: 0 0 16px; }
      p { margin: 0 0 12px; }
      ol { margin: 0 0 16px 20px; padding: 0; }
      ol li { margin-bottom: 6px; }
      code, pre {
        font-family: "JetBrains Mono", Menlo, Consolas, monospace;
        font-size: 12px;
        color: #9bc1ff;
      }
      pre.cmd {
        background: #161616;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        padding: 8px 12px;
        margin: 8px 0;
      }
      textarea {
        width: 100%;
        min-height: 80px;
        max-height: 200px;
        background: #161616;
        color: #e5e5e5;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        padding: 10px;
        font-family: "JetBrains Mono", Menlo, Consolas, monospace;
        font-size: 12px;
        box-sizing: border-box;
        resize: vertical;
      }
      button {
        background: #1f1f1f;
        color: #e5e5e5;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        padding: 8px 16px;
        font-size: 13px;
        cursor: pointer;
        margin-top: 12px;
      }
      button:hover:not(:disabled) { background: #2a2a2a; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      button.primary {
        background: #1a3a2a;
        color: #5fdcb6;
        border-color: #2a5a3a;
      }
      button.primary:hover:not(:disabled) { background: #224a34; }
      .pill {
        display: inline-block;
        padding: 2px 8px;
        font-size: 11px;
        background: #1a3a2a;
        color: #5fdcb6;
        border-radius: 999px;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        margin-bottom: 12px;
      }
      .section-divider {
        border: none;
        border-top: 1px solid #222;
        margin: 20px 0;
      }
      .section-label {
        font-size: 11px;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }
      #terminal {
        background: #0a0a0a;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        padding: 10px 12px;
        margin-top: 12px;
        min-height: 80px;
        max-height: 220px;
        overflow-y: auto;
        font-family: "JetBrains Mono", Menlo, Consolas, monospace;
        font-size: 11px;
        line-height: 1.5;
        color: #c8c8c8;
        white-space: pre-wrap;
        word-break: break-all;
        display: none;
      }
      #terminal.active { display: block; }
      #pty-input-row {
        display: none;
        margin-top: 8px;
        gap: 8px;
        align-items: center;
      }
      #pty-input-row.active { display: flex; }
      #pty-input {
        flex: 1;
        background: #161616;
        color: #e5e5e5;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        padding: 6px 10px;
        font-family: "JetBrains Mono", Menlo, Consolas, monospace;
        font-size: 12px;
      }
      #pty-send { margin-top: 0; }
      #status { margin-top: 12px; min-height: 18px; font-size: 12px; }
      #status.ok { color: #5fdcb6; }
      #status.err { color: #ff6464; }
    </style>
  </head>
  <body>
    <span class="pill">First-run setup</span>
    <h1>Sign in to Claude</h1>
    <p>ClaudeOS needs a long-lived OAuth token to authenticate against your Claude subscription.</p>

    <!-- Primary: in-app PTY flow -->
    <div class="section-label">Option 1 — run in-app</div>
    <p style="margin:0 0 8px">Click the button below to open the sign-in flow inside this window. Your browser will open for authentication.</p>
    <button class="primary" id="run-pty">Run claude setup-token in-app</button>
    <pre id="terminal" aria-live="polite" aria-label="Terminal output"></pre>
    <div id="pty-input-row">
      <input id="pty-input" type="text" placeholder="Paste code here if prompted…" autocomplete="off" spellcheck="false" />
      <button id="pty-send">Send</button>
    </div>

    <hr class="section-divider" />

    <!-- Fallback: manual paste -->
    <div class="section-label">Option 2 — paste manually</div>
    <ol>
      <li>Open a terminal and run:<pre class="cmd">claude setup-token</pre></li>
      <li>Sign in via the browser flow that opens.</li>
      <li>Copy the token printed at the end and paste it below.</li>
    </ol>
    <textarea id="token" placeholder="Paste token here…" autocomplete="off" spellcheck="false"></textarea>
    <div>
      <button id="save" disabled>Save token</button>
    </div>

    <div id="status" role="status"></div>

    <script>
      /* ------------------------------------------------------------------ */
      /* Helpers                                                              */
      /* ------------------------------------------------------------------ */

      // Strip ANSI escape sequences so the plain <pre> stays readable.
      function stripAnsi(str) {
        return str
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\\\)/g, "")
          .replace(/\x1b[^[\]]/g, "");
      }

      function setStatus(msg, cls) {
        const el = document.getElementById("status");
        el.className = cls || "";
        el.textContent = msg;
      }

      /* Save token via IPC and handle success/failure feedback. */
      async function saveAndClose(token) {
        setStatus("Saving token…", "");
        try {
          const result = await window.claudeosSetup.submit(token);
          if (result.ok) {
            setStatus(
              result.warning
                ? "Saved (" + result.mode + "): " + result.warning
                : "Saved (" + result.mode + "). Starting ClaudeOS…",
              "ok"
            );
          } else {
            setStatus(result.error, "err");
          }
        } catch (err) {
          setStatus(String(err && err.message ? err.message : err), "err");
        }
      }

      /* ------------------------------------------------------------------ */
      /* PTY flow                                                             */
      /* ------------------------------------------------------------------ */

      const runBtn   = document.getElementById("run-pty");
      const terminal = document.getElementById("terminal");
      const inputRow = document.getElementById("pty-input-row");
      const ptyInput = document.getElementById("pty-input");
      const ptySend  = document.getElementById("pty-send");

      // Register PTY data/exit listeners once (they accumulate across calls).
      window.claudeosSetup.onSetupData(function(chunk) {
        const clean = stripAnsi(chunk)
          .replace(/\\r\\n/g, "\\n")
          .replace(/\\r/g, "\\n");
        terminal.textContent += clean;
        terminal.scrollTop = terminal.scrollHeight;
        // Show the input row if the CLI is waiting for a code paste.
        if (/Paste code here/i.test(terminal.textContent)) {
          inputRow.classList.add("active");
        }
      });

      window.claudeosSetup.onSetupExit(function(code) {
        inputRow.classList.remove("active");
        if (code !== 0) {
          setStatus("setup-token exited with code " + code + ". Check output above.", "err");
        }
      });

      runBtn.addEventListener("click", async function() {
        runBtn.disabled = true;
        terminal.textContent = "";
        terminal.classList.add("active");
        setStatus("", "");
        try {
          await window.claudeosSetup.startSetupToken();
        } catch (err) {
          setStatus("Failed to start: " + String(err && err.message ? err.message : err), "err");
          runBtn.disabled = false;
        }
      });

      ptySend.addEventListener("click", function() {
        const val = ptyInput.value;
        if (!val.trim()) return;
        window.claudeosSetup.writeSetupInput(val + "\\r");
        ptyInput.value = "";
      });

      ptyInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") ptySend.click();
      });

      /* ------------------------------------------------------------------ */
      /* Paste-token fallback                                                 */
      /* ------------------------------------------------------------------ */

      const tokenEl = document.getElementById("token");
      const saveBtn  = document.getElementById("save");

      tokenEl.addEventListener("input", function() {
        saveBtn.disabled = tokenEl.value.trim().length === 0;
      });

      saveBtn.addEventListener("click", async function() {
        saveBtn.disabled = true;
        await saveAndClose(tokenEl.value);
        if (document.getElementById("status").className !== "ok") {
          saveBtn.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}
