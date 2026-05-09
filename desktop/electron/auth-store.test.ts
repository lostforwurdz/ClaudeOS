import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { createAuthStore, type SafeStorageLike } from "./auth-store.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "claudeos-auth-store-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const realSafeStorage = (): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  // "Encrypt" by reversing — enough to verify the store reads back what it wrote
  // through encrypt/decrypt without being a no-op.
  encryptString: (plain) => Buffer.from(plain.split("").reverse().join(""), "utf8"),
  decryptString: (blob) => blob.toString("utf8").split("").reverse().join(""),
});

const noEncryption = (): SafeStorageLike => ({
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("not available");
  },
  decryptString: () => {
    throw new Error("not available");
  },
});

test("saveToken with available encryption writes auth.bin in encrypted mode", () => {
  const store = createAuthStore({ userDataDir: dataDir, safeStorage: realSafeStorage() });
  const result = store.saveToken("sk-abcdef");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("type narrow");
  assert.equal(result.mode, "encrypted");

  const blob = readFileSync(join(dataDir, "auth.bin"));
  assert.equal(blob.toString("utf8"), "fedcba-ks", "must be encrypted, not plaintext");
});

test("loadToken round-trips an encrypted token", () => {
  const store = createAuthStore({ userDataDir: dataDir, safeStorage: realSafeStorage() });
  store.saveToken("sk-roundtrip");
  assert.equal(store.loadToken(), "sk-roundtrip");
});

test("loadToken returns null when no token has been written", () => {
  const store = createAuthStore({ userDataDir: dataDir, safeStorage: realSafeStorage() });
  assert.equal(store.loadToken(), null);
});

test("saveToken with no encryption falls back to plaintext + warning", () => {
  const store = createAuthStore({ userDataDir: dataDir, safeStorage: noEncryption() });
  const result = store.saveToken("sk-fallback");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("type narrow");
  assert.equal(result.mode, "plaintext");
  assert.match(result.warning, /keystore unavailable/i);

  const text = readFileSync(join(dataDir, "auth.txt"), "utf8");
  assert.equal(text, "sk-fallback");
});

test("saveToken with refusePlaintext fails when no keystore is available", () => {
  const store = createAuthStore({
    userDataDir: dataDir,
    safeStorage: noEncryption(),
    refusePlaintext: true,
  });
  const result = store.saveToken("sk-no-fallback");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("type narrow");
  assert.match(result.error, /plaintext storage is disabled/i);
});

test("saveToken rejects an empty/whitespace-only token", () => {
  const store = createAuthStore({ userDataDir: dataDir, safeStorage: realSafeStorage() });
  const empty = store.saveToken("");
  const ws = store.saveToken("   \n  ");
  assert.equal(empty.ok, false);
  assert.equal(ws.ok, false);
});

test("loadToken falls back to plaintext when the encrypted blob is corrupt", () => {
  const store = createAuthStore({ userDataDir: dataDir, safeStorage: realSafeStorage() });
  // Plant a corrupt encrypted file alongside a valid plaintext fallback.
  writeFileSync(join(dataDir, "auth.bin"), Buffer.from([0xff, 0x00, 0xde, 0xad]));
  writeFileSync(join(dataDir, "auth.txt"), "sk-recovered\n");
  const decryptingStore = createAuthStore({
    userDataDir: dataDir,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => {
        throw new Error("corrupt blob");
      },
    },
  });
  // The original `store` is not used here — the explicit safeStorage above
  // simulates a decryptor that refuses to decode the planted bytes.
  void store;
  assert.equal(decryptingStore.loadToken(), "sk-recovered");
});

test("saveToken cleans up a stale plaintext file once encryption succeeds", () => {
  // First write a plaintext fallback (encryption unavailable).
  const downgraded = createAuthStore({ userDataDir: dataDir, safeStorage: noEncryption() });
  downgraded.saveToken("sk-old-plain");
  // Now an encryption-capable store overwrites with an encrypted blob.
  const upgraded = createAuthStore({ userDataDir: dataDir, safeStorage: realSafeStorage() });
  upgraded.saveToken("sk-new-encrypted");
  assert.equal(upgraded.loadToken(), "sk-new-encrypted");
  // The plaintext file must be scrubbed so a passive disk scan can't find it.
  assert.throws(() => readFileSync(join(dataDir, "auth.txt")));
});

test("clearToken removes encrypted and plaintext copies", () => {
  const store = createAuthStore({ userDataDir: dataDir, safeStorage: realSafeStorage() });
  store.saveToken("sk-remove-me");
  store.clearToken();
  assert.equal(store.loadToken(), null);
});
