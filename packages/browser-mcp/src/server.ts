/**
 * ClaudeOS browser MCP server.
 *
 * Exposes Playwright-grade browser tools over stdio so a Claude Code subprocess
 * inside ClaudeOS can drive a real browser. The four v0 tools — navigate,
 * click, screenshot, extract — cover the bulk of "agentic web automation"
 * without leaking the full Playwright surface.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { BrowserHandle } from "./browser.js";

export interface BrowserServerOptions {
  /** Browser handle. Injectable so tests can stub Playwright entirely. */
  browser: BrowserHandle;
  /**
   * Capture function used by the screenshot tool. Defaults to calling
   * `page.screenshot({ type: "png" })`. Override in tests to avoid invoking
   * the real renderer.
   */
  capture?: (page: import("playwright").Page) => Promise<Buffer>;
}

export const BROWSER_MCP_NAME = "claudeos-browser";
export const BROWSER_MCP_VERSION = "0.0.0";

/**
 * Build a configured `McpServer` with the four browser tools registered.
 * Caller wires the transport (stdio in production, in-memory pair in tests).
 */
export function createBrowserMcpServer(opts: BrowserServerOptions): McpServer {
  const server = new McpServer(
    { name: BROWSER_MCP_NAME, version: BROWSER_MCP_VERSION },
    {
      instructions:
        "Drive a single persistent browser page. Call `navigate` first, then `click`, `screenshot`, or `extract`. Selectors use Playwright's locator syntax (CSS, text=, role=, etc.).",
    },
  );

  const capture = opts.capture ?? ((page) => page.screenshot({ type: "png" }));

  server.registerTool(
    "navigate",
    {
      description: "Load a URL in the persistent browser page. Waits for the network to be idle.",
      inputSchema: z.object({
        url: z.string().min(1).describe("Absolute URL including scheme."),
        wait_until: z
          .enum(["load", "domcontentloaded", "networkidle", "commit"])
          .optional()
          .describe("Page lifecycle event to wait for. Default: load."),
      }),
    },
    async ({ url, wait_until }) => {
      const page = await opts.browser.getPage();
      const response = await page.goto(url, { waitUntil: wait_until ?? "load" });
      const title = await page.title();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: page.url(),
              title,
              status: response?.status() ?? null,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "click",
    {
      description:
        "Click the first element matching a Playwright locator. Use CSS or text=/role= prefixes.",
      inputSchema: z.object({
        selector: z.string().min(1).describe("Playwright locator string."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Per-action timeout. Default 5000."),
      }),
    },
    async ({ selector, timeout_ms }) => {
      const page = await opts.browser.getPage();
      await page.locator(selector).first().click({ timeout: timeout_ms ?? 5000 });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ clicked: selector, url: page.url() }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "screenshot",
    {
      description:
        "Capture a PNG of the current page. Returned as base64 in an `image` content block.",
      inputSchema: z.object({
        full_page: z
          .boolean()
          .optional()
          .describe("Capture beyond the viewport. Default false."),
      }),
    },
    async ({ full_page }) => {
      const page = await opts.browser.getPage();
      const buf = full_page
        ? await page.screenshot({ type: "png", fullPage: true })
        : await capture(page);
      return {
        content: [
          { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
        ],
      };
    },
  );

  server.registerTool(
    "extract",
    {
      description:
        "Extract text content from the page. Without `selector`, returns body innerText. With one, returns innerText of the first match.",
      inputSchema: z.object({
        selector: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Playwright locator. Default: body."),
        max_chars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Truncate the result. Default 8000."),
      }),
    },
    async ({ selector, max_chars }) => {
      const page = await opts.browser.getPage();
      const limit = max_chars ?? 8000;
      const text = selector
        ? await page.locator(selector).first().innerText()
        : await page.locator("body").innerText();
      const truncated = text.length > limit ? `${text.slice(0, limit)}…` : text;
      return {
        content: [{ type: "text", text: truncated }],
      };
    },
  );

  return server;
}
