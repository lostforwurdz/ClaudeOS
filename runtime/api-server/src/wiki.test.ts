import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { bm25Search, formatExcerpts, loadWikiIndex } from "./wiki.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudeos-wiki-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, body: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

test("loadWikiIndex returns an empty list when the dir does not exist", () => {
  assert.deepEqual(loadWikiIndex(join(root, "missing")), []);
});

test("loadWikiIndex walks subdirs, picks up .md, ignores _schema.md and dotfiles", () => {
  seed("topics/auth.md", "# Auth tokens\n\nUse JWT, not sessions.");
  seed("decisions/layout.md", "# Layout\n\nFlat over nested.");
  seed("_schema.md", "# Schema\n\n(governance file, not retrieved)");
  seed(".hidden.md", "# Hidden\n\n(should be skipped)");
  seed("notes.txt", "ignored — not markdown");

  const docs = loadWikiIndex(root);
  const titles = docs.map((d) => d.title).sort();
  assert.deepEqual(titles, ["Auth tokens", "Layout"]);
});

test("loadWikiIndex falls back to the filename for the title when no H1 is present", () => {
  seed("decisions/no-heading.md", "Just a paragraph, no heading.");
  const docs = loadWikiIndex(root);
  assert.equal(docs[0].title, "no-heading");
});

test("bm25Search returns docs with the query terms ranked highest", () => {
  seed("a.md", "# Auth tokens\n\nJWT, not sessions, with refresh.");
  seed("b.md", "# Database backups\n\nAge-encrypted, restic, daily.");
  seed("c.md", "# Auth flow ergonomics\n\nLogin button copy.");
  const docs = loadWikiIndex(root);

  const matches = bm25Search(docs, "JWT auth tokens", 5);
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].doc.title, "Auth tokens");
  // The pure-database doc with no overlapping terms should NOT appear.
  assert.ok(!matches.some((m) => m.doc.title === "Database backups"));
});

test("bm25Search returns [] for an empty corpus or empty query", () => {
  assert.deepEqual(bm25Search([], "anything", 5), []);
  seed("a.md", "# Hi\n\nx");
  const docs = loadWikiIndex(root);
  assert.deepEqual(bm25Search(docs, "", 5), []);
});

test("bm25Search caps results at topK", () => {
  for (let i = 0; i < 10; i++) seed(`doc${i}.md`, `# Title ${i}\n\nshared keyword foo bar`);
  const docs = loadWikiIndex(root);
  const matches = bm25Search(docs, "foo bar", 3);
  assert.equal(matches.length, 3);
});

test("formatExcerpts returns empty string when there are no matches", () => {
  assert.equal(formatExcerpts([]), "");
});

test("formatExcerpts emits a markdown block with title + relPath + truncated body per match", () => {
  seed("decisions/auth.md", "# Auth tokens\n\n" + "x".repeat(800));
  const docs = loadWikiIndex(root);
  const matches = bm25Search(docs, "auth", 1);
  const out = formatExcerpts(matches);
  assert.match(out, /Operator wiki context/);
  assert.match(out, /Auth tokens/);
  assert.match(out, /decisions\/auth\.md/);
  // Body truncated to ~600 chars + ellipsis.
  assert.ok(out.includes("…"), "long bodies should be truncated with ellipsis");
});
