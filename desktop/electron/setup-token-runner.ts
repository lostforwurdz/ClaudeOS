/**
 * PTY-based runner for `claude setup-token` (dcp.10 v2 / kobramaz-7ho).
 *
 * `claude setup-token` requires a real PTY — it outputs nothing to plain
 * pipes.  This module wraps @lydell/node-pty so the setup window can stream
 * live output to the renderer and capture the OAuth token when it appears.
 *
 * Pure module: the PTY factory is injected so unit tests can stub it without
 * spawning a real process.
 */

/** Minimal surface of node-pty's IPty that we actually use. */
export interface PtyProcess {
  readonly onData: { (handler: (data: string) => void): { dispose(): void } };
  readonly onExit: { (handler: (ev: { exitCode: number; signal?: number }) => void): { dispose(): void } };
  write(data: string): void;
  kill(signal?: string): void;
}

export interface PtyFactory {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      env?: Record<string, string | undefined>;
    },
  ): PtyProcess;
}

export interface SetupTokenRunnerOptions {
  claudeBinary: string;
  ptyFactory: PtyFactory;
  onData: (chunk: string) => void;
  onToken: (token: string) => void;
  onExit: (code: number) => void;
}

export interface SetupTokenRunner {
  start(): void;
  write(input: string): void;
  kill(): void;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Scan a buffer for an Anthropic long-lived OAuth token.
 *
 * Tokens have the prefix `sk-ant-oat01-` followed by base64url characters.
 * We match at least 20 chars after the prefix to avoid false positives on
 * partial writes.  ANSI escape codes are stripped before matching so the
 * colour-coded terminal output doesn't defeat the regex.
 */
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_\-]{20,}/g;

export function stripAnsi(raw: string): string {
  // Removes ESC [ ... m colour codes, ESC ] ... BEL/ST OSC sequences, and
  // lone ESC + single char control sequences.
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "");
}

/**
 * Extract all unique OAuth token candidates from raw PTY output.
 * Returns an empty array when none are found.
 */
export function extractTokens(raw: string): string[] {
  const clean = stripAnsi(raw);
  const matches = clean.match(TOKEN_RE);
  if (!matches) return [];
  // Deduplicate while preserving order.
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Create a runner that manages a `claude setup-token` PTY session.
 *
 * Call `start()` once.  The runner streams decoded output through `onData`,
 * fires `onToken` the first time an OAuth token is spotted, and calls
 * `onExit` when the process finishes.
 */
export function createSetupTokenRunner(opts: SetupTokenRunnerOptions): SetupTokenRunner {
  const { claudeBinary, ptyFactory, onData, onToken, onExit } = opts;

  let pty: PtyProcess | null = null;
  let tokenFired = false;
  let accumulated = "";

  function handleData(chunk: string): void {
    accumulated += chunk;
    onData(chunk);

    if (!tokenFired) {
      const found = extractTokens(accumulated);
      if (found.length > 0) {
        tokenFired = true;
        onToken(found[0]);
      }
    }
  }

  function handleExit(ev: { exitCode: number; signal?: number }): void {
    // Final scan in case the token arrived in the very last chunk.
    if (!tokenFired) {
      const found = extractTokens(accumulated);
      if (found.length > 0) {
        tokenFired = true;
        onToken(found[0]);
      }
    }
    onExit(ev.exitCode);
  }

  return {
    start() {
      if (pty) return; // idempotent
      pty = ptyFactory.spawn(claudeBinary, ["setup-token"], {
        name: "xterm-color",
        cols: 120,
        rows: 30,
        env: process.env as Record<string, string | undefined>,
      });
      pty.onData(handleData);
      pty.onExit(handleExit);
    },

    write(input: string) {
      pty?.write(input);
    },

    kill() {
      if (pty) {
        pty.kill("SIGTERM");
        pty = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default real PTY factory (uses the actual @lydell/node-pty package)
// ---------------------------------------------------------------------------

/**
 * Build the real PtyFactory backed by @lydell/node-pty.
 * Loaded lazily so the module is importable in test environments where
 * the native add-on isn't present.
 */
export function createRealPtyFactory(): PtyFactory {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePty = require("@lydell/node-pty") as typeof import("@lydell/node-pty");
  return {
    spawn(file, args, options) {
      return nodePty.spawn(file, args, options);
    },
  };
}
