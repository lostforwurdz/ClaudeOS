/**
 * Type declarations for the contextBridge surfaces exposed by the main
 * BrowserWindow's preload (kobramaz-46i / xh5.1 follow-up).
 *
 * `window.claudeos` is undefined in dev when the renderer is loaded outside
 * Electron (e.g. plain `vite` against http://localhost:5173 with no main
 * process), so callers must check before using it.
 */

export interface TokenStatus {
  present: boolean;
  encrypted: boolean;
}

export interface ClaudeOsBridge {
  token: {
    status: () => Promise<TokenStatus>;
    clear: () => Promise<void>;
    restartSetup: () => Promise<void>;
  };
}

declare global {
  interface Window {
    claudeos?: ClaudeOsBridge;
  }
}

export {};
