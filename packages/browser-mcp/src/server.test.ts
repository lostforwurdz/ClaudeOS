import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { BrowserHandle } from "./browser.js";
import {
  BROWSER_MCP_NAME,
  BROWSER_MCP_VERSION,
  createBrowserMcpServer,
} from "./server.js";

// A minimal Playwright Page stub. Tests only exercise the methods each tool
// touches; everything else throws so accidental coupling is loud.
interface FakePage {
  isClosed(): boolean;
  goto: (url: string, opts?: { waitUntil?: string }) => Promise<{ status(): number } | null>;
  url(): string;
  title(): Promise<string>;
  locator: (selector: string) => {
    first(): { click(opts?: { timeout?: number }): Promise<void>; innerText(): Promise<string> };
    innerText(): Promise<string>;
  };
  screenshot: (opts?: { type?: string; fullPage?: boolean }) => Promise<Buffer>;
  close(): Promise<void>;
}

interface CallLog {
  goto: Array<{ url: string; waitUntil: string | undefined }>;
  click: Array<{ selector: string; timeout: number | undefined }>;
  innerText: Array<{ selector: string | null }>;
  screenshot: Array<{ fullPage: boolean | undefined }>;
}

function fakeBrowser(): { handle: BrowserHandle; calls: CallLog; capture: (p: FakePage) => Promise<Buffer> } {
  const calls: CallLog = { goto: [], click: [], innerText: [], screenshot: [] };
  const page: FakePage = {
    isClosed: () => false,
    url: () => "https://example.com/landing",
    title: async () => "Example Domain",
    goto: async (url, opts) => {
      calls.goto.push({ url, waitUntil: opts?.waitUntil });
      return { status: () => 200 };
    },
    locator: (selector) => ({
      first: () => ({
        click: async (o) => {
          calls.click.push({ selector, timeout: o?.timeout });
        },
        innerText: async () => {
          calls.innerText.push({ selector });
          return `text-for:${selector}`;
        },
      }),
      innerText: async () => {
        calls.innerText.push({ selector });
        return `body-text-of-${selector}`;
      },
    }),
    screenshot: async (opts) => {
      calls.screenshot.push({ fullPage: opts?.fullPage });
      return Buffer.from("fake-png");
    },
    close: async () => {},
  };

  const handle: BrowserHandle = {
    async getPage() {
      return page as unknown as import("playwright").Page;
    },
    async closePage() {},
    async shutdown() {},
  };

  const capture = async (_p: FakePage): Promise<Buffer> => {
    calls.screenshot.push({ fullPage: undefined });
    return Buffer.from("captured-png");
  };

  return { handle, calls, capture };
}

async function connectClient(handle: BrowserHandle, capture?: (p: FakePage) => Promise<Buffer>) {
  const server = createBrowserMcpServer({
    browser: handle,
    capture: capture as ((p: import("playwright").Page) => Promise<Buffer>) | undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("server advertises name/version and lists the four browser tools", async () => {
  const { handle } = fakeBrowser();
  const { client, server } = await connectClient(handle);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["click", "extract", "navigate", "screenshot"]);

    const navigate = tools.tools.find((t) => t.name === "navigate");
    assert.ok(navigate);
    // inputSchema is materialized as JSON Schema by the SDK
    assert.equal(navigate.inputSchema.type, "object");
    assert.ok(navigate.inputSchema.properties && "url" in navigate.inputSchema.properties);
  } finally {
    await client.close();
    await server.close();
  }
});

test("navigate forwards URL and waitUntil to the page", async () => {
  const { handle, calls } = fakeBrowser();
  const { client, server } = await connectClient(handle);
  try {
    const result = await client.callTool({
      name: "navigate",
      arguments: { url: "https://example.com/", wait_until: "networkidle" },
    });
    assert.equal(calls.goto.length, 1);
    assert.equal(calls.goto[0].url, "https://example.com/");
    assert.equal(calls.goto[0].waitUntil, "networkidle");

    const text = (result.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(text.text);
    assert.equal(payload.title, "Example Domain");
    assert.equal(payload.status, 200);
  } finally {
    await client.close();
    await server.close();
  }
});

test("click forwards selector and custom timeout to page.locator", async () => {
  const { handle, calls } = fakeBrowser();
  const { client, server } = await connectClient(handle);
  try {
    await client.callTool({
      name: "click",
      arguments: { selector: "button[type=submit]", timeout_ms: 2000 },
    });
    assert.equal(calls.click.length, 1);
    assert.deepEqual(calls.click[0], {
      selector: "button[type=submit]",
      timeout: 2000,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("screenshot returns base64 PNG via injected capture function", async () => {
  const { handle, capture } = fakeBrowser();
  const { client, server } = await connectClient(handle, capture);
  try {
    const result = await client.callTool({ name: "screenshot", arguments: {} });
    const block = (result.content as Array<{ type: string; data: string; mimeType: string }>)[0];
    assert.equal(block.type, "image");
    assert.equal(block.mimeType, "image/png");
    assert.equal(Buffer.from(block.data, "base64").toString(), "captured-png");
  } finally {
    await client.close();
    await server.close();
  }
});

test("screenshot full_page=true bypasses capture override and uses page.screenshot", async () => {
  const { handle, calls, capture } = fakeBrowser();
  const { client, server } = await connectClient(handle, capture);
  try {
    await client.callTool({ name: "screenshot", arguments: { full_page: true } });
    // page.screenshot was called with fullPage:true; our capture override was NOT invoked.
    assert.equal(calls.screenshot.length, 1);
    assert.equal(calls.screenshot[0].fullPage, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("extract without selector returns body text", async () => {
  const { handle } = fakeBrowser();
  const { client, server } = await connectClient(handle);
  try {
    const result = await client.callTool({ name: "extract", arguments: {} });
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    assert.equal(block.text, "body-text-of-body");
  } finally {
    await client.close();
    await server.close();
  }
});

test("extract truncates output to max_chars with a trailing ellipsis", async () => {
  const longText = "x".repeat(20000);
  const handle: BrowserHandle = {
    async getPage() {
      return {
        isClosed: () => false,
        url: () => "x",
        title: async () => "x",
        locator: () => ({
          first: () => ({
            click: async () => {},
            innerText: async () => longText,
          }),
          innerText: async () => longText,
        }),
        screenshot: async () => Buffer.alloc(0),
        close: async () => {},
      } as unknown as import("playwright").Page;
    },
    async closePage() {},
    async shutdown() {},
  };

  const { client, server } = await connectClient(handle);
  try {
    const result = await client.callTool({
      name: "extract",
      arguments: { max_chars: 100 },
    });
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    assert.equal(block.text.length, 101); // 100 chars + ellipsis
    assert.ok(block.text.endsWith("…"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("server identity matches the constants exported for auto-registration", () => {
  // Sanity for downstream consumers (e.g., api-server auto-register) that
  // pin tool config off these constants.
  assert.equal(BROWSER_MCP_NAME, "claudeos-browser");
  assert.match(BROWSER_MCP_VERSION, /^\d+\.\d+\.\d+$/);
});
