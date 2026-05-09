/**
 * Tests for setup-token-runner.ts (dcp.10 v2 / kobramaz-7ho).
 *
 * Covers:
 *   - Token regex extraction (including ANSI noise, mid-stream, partial)
 *   - stripAnsi helper
 *   - Runner lifecycle via stub PtyFactory
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractTokens,
  stripAnsi,
  createSetupTokenRunner,
  type PtyFactory,
  type PtyProcess,
} from "./setup-token-runner.js";

// ---------------------------------------------------------------------------
// Token extraction tests
// ---------------------------------------------------------------------------

test("extractTokens: returns empty array when no token present", () => {
  assert.deepEqual(extractTokens("Opening browser to sign in...\n"), []);
});

test("extractTokens: finds a clean token", () => {
  const token = "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const result = extractTokens(`Your token is: ${token}\n`);
  assert.deepEqual(result, [token]);
});

test("extractTokens: finds token buried in ANSI escape noise", () => {
  const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz123456";
  // Simulate colorized terminal output wrapping the token.
  const raw =
    "\x1b[38;2;95;215;0m" +
    "Your long-lived token:\x1b[39m\r\n" +
    "\x1b[1m" +
    token +
    "\x1b[22m\r\n";
  const result = extractTokens(raw);
  assert.deepEqual(result, [token]);
});

test("extractTokens: finds token arriving mid-stream with surrounding noise", () => {
  const token = "sk-ant-oat01-MID_STREAM_TOKEN_XYZ987654321abcde";
  const buffer =
    "Welcome to Claude Code\r\n" +
    "Opening browser to sign in…\r\n" +
    "Browser didn't open? Use the URL below:\r\n" +
    "https://claude.ai/oauth?code=xxx\r\n" +
    "Paste code here if prompted > \r\n" +
    `Token saved: ${token}\r\n` +
    "Done!\r\n";
  const result = extractTokens(buffer);
  assert.deepEqual(result, [token]);
});

test("extractTokens: deduplicates the same token appearing twice", () => {
  const token = "sk-ant-oat01-DUPLICATE_TOKEN_123456789abcdefgh";
  const buffer = `${token}\r\n${token}\r\n`;
  const result = extractTokens(buffer);
  assert.deepEqual(result, [token]);
});

test("extractTokens: ignores candidates shorter than minimum length", () => {
  // The regex requires at least 20 chars after the prefix.
  const tooShort = "sk-ant-oat01-short";
  const result = extractTokens(tooShort);
  assert.deepEqual(result, []);
});

test("stripAnsi: removes SGR colour sequences", () => {
  const cleaned = stripAnsi("\x1b[38;2;255;0;0mred text\x1b[39m");
  assert.equal(cleaned, "red text");
});

test("stripAnsi: removes OSC title sequences", () => {
  const cleaned = stripAnsi("\x1b]0;My Terminal\x07normal text");
  assert.equal(cleaned, "normal text");
});

test("stripAnsi: removes cursor movement sequences", () => {
  const cleaned = stripAnsi("foo\x1b[1Abar\x1b[2Kbaz");
  assert.equal(cleaned, "foobarbaz");
});

test("stripAnsi: leaves plain text untouched", () => {
  const plain = "Hello, world!\nNo ANSI here.";
  assert.equal(stripAnsi(plain), plain);
});

// ---------------------------------------------------------------------------
// Runner lifecycle tests
// ---------------------------------------------------------------------------

/** Build a controllable stub PTY process. */
function makeStubPty(): {
  pty: PtyProcess;
  emitData(chunk: string): void;
  emitExit(code: number): void;
  written: string[];
  killed: string[];
} {
  const dataHandlers: Array<(d: string) => void> = [];
  const exitHandlers: Array<(ev: { exitCode: number; signal?: number }) => void> = [];
  const written: string[] = [];
  const killed: string[] = [];

  const pty: PtyProcess = {
    onData(handler) {
      dataHandlers.push(handler);
      return { dispose() { /* no-op */ } };
    },
    onExit(handler) {
      exitHandlers.push(handler);
      return { dispose() { /* no-op */ } };
    },
    write(data) { written.push(data); },
    kill(signal = "SIGTERM") { killed.push(signal); },
  };

  return {
    pty,
    emitData(chunk) { dataHandlers.forEach((h) => h(chunk)); },
    emitExit(code) { exitHandlers.forEach((h) => h({ exitCode: code })); },
    written,
    killed,
  };
}

test("runner: start() spawns the process and onData is called per chunk", () => {
  const stub = makeStubPty();
  const factory: PtyFactory = {
    spawn: (_file, _args, _opts) => stub.pty,
  };

  const received: string[] = [];
  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: (chunk) => received.push(chunk),
    onToken: () => { /* not exercised here */ },
    onExit: () => { /* not exercised here */ },
  });

  runner.start();
  stub.emitData("hello ");
  stub.emitData("world\r\n");

  assert.deepEqual(received, ["hello ", "world\r\n"]);
});

test("runner: onToken fires when token appears in streamed data", () => {
  const stub = makeStubPty();
  const factory: PtyFactory = { spawn: () => stub.pty };

  const tokens: string[] = [];
  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: () => { /* ignored */ },
    onToken: (t) => tokens.push(t),
    onExit: () => { /* ignored */ },
  });

  runner.start();
  stub.emitData("Welcome to Claude Code\r\n");
  assert.deepEqual(tokens, [], "no token yet");

  const token = "sk-ant-oat01-TOKEN_IS_HERE_NOW_12345678901234";
  stub.emitData(`Your token: ${token}\r\n`);
  assert.deepEqual(tokens, [token]);
});

test("runner: onToken fires at most once even if token appears twice", () => {
  const stub = makeStubPty();
  const factory: PtyFactory = { spawn: () => stub.pty };

  const tokens: string[] = [];
  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: () => { /* ignored */ },
    onToken: (t) => tokens.push(t),
    onExit: () => { /* ignored */ },
  });

  runner.start();
  const token = "sk-ant-oat01-ONCE_ONLY_TOKEN_ABCDEFGHIJKLMNO";
  stub.emitData(`${token}\r\n${token}\r\n`);
  assert.equal(tokens.length, 1, "onToken must fire exactly once");
  assert.equal(tokens[0], token);
});

test("runner: onExit fires with the process exit code", () => {
  const stub = makeStubPty();
  const factory: PtyFactory = { spawn: () => stub.pty };

  const codes: number[] = [];
  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: () => { /* ignored */ },
    onToken: () => { /* ignored */ },
    onExit: (code) => codes.push(code),
  });

  runner.start();
  stub.emitExit(0);
  assert.deepEqual(codes, [0]);
});

test("runner: kill() sends SIGTERM to the pty", () => {
  const stub = makeStubPty();
  const factory: PtyFactory = { spawn: () => stub.pty };

  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: () => { /* ignored */ },
    onToken: () => { /* ignored */ },
    onExit: () => { /* ignored */ },
  });

  runner.start();
  runner.kill();
  assert.deepEqual(stub.killed, ["SIGTERM"]);
});

test("runner: write() forwards input to the pty", () => {
  const stub = makeStubPty();
  const factory: PtyFactory = { spawn: () => stub.pty };

  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: () => { /* ignored */ },
    onToken: () => { /* ignored */ },
    onExit: () => { /* ignored */ },
  });

  runner.start();
  runner.write("mycode\r");
  assert.deepEqual(stub.written, ["mycode\r"]);
});

test("runner: start() is idempotent — second call is a no-op", () => {
  let spawnCount = 0;
  const factory: PtyFactory = {
    spawn() {
      spawnCount++;
      return makeStubPty().pty;
    },
  };

  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: () => { /* ignored */ },
    onToken: () => { /* ignored */ },
    onExit: () => { /* ignored */ },
  });

  runner.start();
  runner.start();
  assert.equal(spawnCount, 1, "spawn must only be called once");
});

test("runner: onToken fires on exit scan if token arrived in final chunk", () => {
  const stub = makeStubPty();
  const factory: PtyFactory = { spawn: () => stub.pty };

  const tokens: string[] = [];
  const runner = createSetupTokenRunner({
    claudeBinary: "/fake/claude",
    ptyFactory: factory,
    onData: () => { /* ignored */ },
    onToken: (t) => tokens.push(t),
    onExit: () => { /* ignored */ },
  });

  runner.start();
  // Simulate a scenario where the token and exit happen in the same flush.
  const token = "sk-ant-oat01-FINAL_CHUNK_TOKEN_xyzABCDEFGH12345";
  stub.emitData(`Token: ${token}`);
  // onToken should already have fired via the data handler, but let's verify
  // exit scan handles the case where somehow data arrived without triggering.
  // We verify the count is exactly 1 and the value is correct.
  stub.emitExit(0);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0], token);
});
