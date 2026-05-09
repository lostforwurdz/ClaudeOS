/**
 * Persistent OAuth token storage for ClaudeOS.
 *
 * Wraps Electron's `safeStorage` (keychain on macOS, DPAPI on Windows,
 * libsecret/kwallet on Linux) and persists the encrypted blob alongside
 * the app's userData directory. Falls back to a plaintext file with a
 * loud warning when the OS keystore is unavailable (most Linux desktops
 * without a keyring daemon).
 *
 * Pure-ish: the safeStorage and fs handles are injected so the module is
 * test-friendly. The default factory wires up the real Electron module.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface AuthStoreInputs {
  /** Directory the encrypted blob lives in. In production: `app.getPath("userData")`. */
  userDataDir: string;
  /** Electron's `safeStorage`. Optional in tests. */
  safeStorage: SafeStorageLike;
  /** When true, never write a plaintext fallback even if encryption is unavailable. */
  refusePlaintext?: boolean;
}

const ENCRYPTED_FILENAME = "auth.bin";
const PLAINTEXT_FILENAME = "auth.txt";

export interface AuthStore {
  /** Reads the stored token (encrypted preferred, plaintext fallback). null when nothing stored. */
  loadToken(): string | null;
  /** Writes the token using the strongest mechanism available. */
  saveToken(token: string): SaveResult;
  /** Removes any stored token (encrypted + fallback). Idempotent. */
  clearToken(): void;
}

export type SaveResult =
  | { ok: true; mode: "encrypted" }
  | { ok: true; mode: "plaintext"; warning: string }
  | { ok: false; error: string };

export function createAuthStore(inputs: AuthStoreInputs): AuthStore {
  const { userDataDir, safeStorage, refusePlaintext } = inputs;
  const encryptedPath = join(userDataDir, ENCRYPTED_FILENAME);
  const plaintextPath = join(userDataDir, PLAINTEXT_FILENAME);

  function ensureDir(): void {
    const dir = dirname(encryptedPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  return {
    loadToken() {
      if (existsSync(encryptedPath) && safeStorage.isEncryptionAvailable()) {
        try {
          const blob = readFileSync(encryptedPath);
          const text = safeStorage.decryptString(blob).trim();
          return text.length > 0 ? text : null;
        } catch {
          // Corrupted blob — treat as missing so the user re-runs setup.
          return readPlaintextFallback(plaintextPath);
        }
      }
      return readPlaintextFallback(plaintextPath);
    },

    saveToken(token) {
      const trimmed = token.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: "token is empty" };
      }
      ensureDir();
      if (safeStorage.isEncryptionAvailable()) {
        try {
          const blob = safeStorage.encryptString(trimmed);
          writeFileSync(encryptedPath, blob, { mode: 0o600 });
          // If a plaintext fallback existed from a prior run, scrub it.
          if (existsSync(plaintextPath)) {
            try {
              unlinkSync(plaintextPath);
            } catch {
              // best effort
            }
          }
          return { ok: true, mode: "encrypted" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, error: `encryption failed: ${message}` };
        }
      }
      if (refusePlaintext) {
        return {
          ok: false,
          error:
            "OS keystore is unavailable and plaintext storage is disabled. " +
            "Install a keyring (gnome-keyring / kwallet) or set CLAUDE_CODE_OAUTH_TOKEN in your environment.",
        };
      }
      try {
        writeFileSync(plaintextPath, trimmed, { mode: 0o600 });
        return {
          ok: true,
          mode: "plaintext",
          warning:
            "OS keystore unavailable — token stored as plaintext at " +
            `${plaintextPath} with mode 0600. Install a keyring (gnome-keyring/kwallet) for encryption.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `failed to write fallback: ${message}` };
      }
    },

    clearToken() {
      for (const p of [encryptedPath, plaintextPath]) {
        if (existsSync(p)) {
          try {
            unlinkSync(p);
          } catch {
            // best effort
          }
        }
      }
    },
  };
}

function readPlaintextFallback(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
