/**
 * Lazy Playwright browser lifecycle.
 *
 * The MCP server spawns no browser at startup. The first tool call that needs
 * a page calls `getPage()`, which launches a chromium browser and creates one
 * persistent page that subsequent calls reuse — modeling a single agent tab.
 *
 * Multi-tab support is intentionally out of scope for the v0 server; if a
 * tool needs a fresh page (e.g. to recover from a crashed renderer), call
 * `closePage()` first.
 */

import type { Browser, Page } from "playwright";

export interface BrowserHandle {
  /** Get (or lazily launch) the persistent page. */
  getPage(): Promise<Page>;
  /** Close the page but keep the browser process alive for the next call. */
  closePage(): Promise<void>;
  /** Tear down everything; subsequent `getPage()` calls relaunch. */
  shutdown(): Promise<void>;
}

export interface BrowserOptions {
  /** Headless by default. Set false to see the browser window during dev. */
  headless?: boolean;
  /**
   * Playwright `chromium` factory. Injectable so tests can stub the launch
   * without depending on a real browser binary.
   */
  launcher?: () => Promise<Browser>;
}

export function createBrowserHandle(opts: BrowserOptions = {}): BrowserHandle {
  const headless = opts.headless ?? true;
  const launcher =
    opts.launcher ??
    (async () => {
      // Lazy import: importing playwright at module load forces every consumer
      // (including tests) to have it installed even when the browser is never
      // launched. Defer to first use.
      const { chromium } = await import("playwright");
      return chromium.launch({ headless });
    });

  let browser: Browser | null = null;
  let page: Page | null = null;

  async function ensureBrowser(): Promise<Browser> {
    if (!browser) browser = await launcher();
    return browser;
  }

  return {
    async getPage(): Promise<Page> {
      if (page && !page.isClosed()) return page;
      const b = await ensureBrowser();
      const context = await b.newContext();
      page = await context.newPage();
      return page;
    },
    async closePage(): Promise<void> {
      if (page && !page.isClosed()) {
        await page.close();
      }
      page = null;
    },
    async shutdown(): Promise<void> {
      page = null;
      if (browser) {
        const b = browser;
        browser = null;
        await b.close();
      }
    },
  };
}
