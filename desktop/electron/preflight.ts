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
  /** Override the binary name. Defaults to "claude". */
  claudeBinary?: string;
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

  const claudePath = await which(binary);
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
