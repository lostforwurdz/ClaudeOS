import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface TemplateSummary {
  name: string;
  description: string;
}

/**
 * Templates ship as on-disk directories under `runtime/api-server/templates/`.
 * Each template has a `template.json` manifest plus the seed files to copy
 * into a new workspace.
 *
 * Path resolution:
 *  - dev:       dist/index.mjs lives at runtime/api-server/dist/, so
 *               `../templates/` resolves to runtime/api-server/templates/.
 *  - packaged:  electron-builder ships the api-server with extraResources
 *               (api-server/dist + api-server/templates), so the same
 *               `../templates/` from dist/index.mjs resolves correctly.
 *
 * Override with CLAUDEOS_TEMPLATES_DIR for tests or custom installs.
 */
export function defaultTemplatesDir(): string {
  if (process.env.CLAUDEOS_TEMPLATES_DIR) return process.env.CLAUDEOS_TEMPLATES_DIR;
  return fileURLToPath(new URL("../templates/", import.meta.url));
}

interface TemplateManifest {
  name: string;
  description: string;
}

function readManifest(templateDir: string): TemplateManifest | null {
  const manifestPath = join(templateDir, "template.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<TemplateManifest>;
    if (typeof raw.name !== "string" || typeof raw.description !== "string") return null;
    return { name: raw.name, description: raw.description };
  } catch {
    return null;
  }
}

export function listTemplates(templatesDir: string = defaultTemplatesDir()): TemplateSummary[] {
  if (!existsSync(templatesDir)) return [];
  const entries = readdirSync(templatesDir, { withFileTypes: true });
  const out: TemplateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(templatesDir, entry.name));
    if (manifest) out.push(manifest);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly code: "not_found" | "conflict" | "invalid",
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

/**
 * Copy a template's seed files into a target workspace dir. Refuses to clobber
 * existing files — if any seed file would overwrite an existing one, throws
 * TemplateError("conflict") and writes nothing. The workspace dir is created
 * if it does not exist. Returns the relative paths of the seeded files.
 */
export function applyTemplate(
  name: string,
  workspaceDir: string,
  templatesDir: string = defaultTemplatesDir(),
): string[] {
  const templateDir = join(templatesDir, name);
  if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
    throw new TemplateError(`template '${name}' not found`, "not_found");
  }
  const manifest = readManifest(templateDir);
  if (!manifest) {
    throw new TemplateError(`template '${name}' is missing or has invalid template.json`, "invalid");
  }

  const seedFiles = collectSeedFiles(templateDir);

  // Pre-flight: refuse if any seed target already exists.
  for (const rel of seedFiles) {
    const target = join(workspaceDir, rel);
    if (existsSync(target)) {
      throw new TemplateError(
        `template '${name}' would overwrite existing file: ${rel}`,
        "conflict",
      );
    }
  }

  mkdirSync(workspaceDir, { recursive: true });
  const seeded: string[] = [];
  for (const rel of seedFiles) {
    const src = join(templateDir, rel);
    const dst = join(workspaceDir, rel);
    mkdirSync(join(dst, ".."), { recursive: true });
    copyFileSync(src, dst);
    seeded.push(rel);
  }
  return seeded;
}

/**
 * Walk the template dir and return a list of files (relative paths) that
 * should be copied into the workspace. Skips the manifest itself; treats
 * .gitkeep as a real file (so empty directories are preserved in git but
 * also seeded).
 */
function collectSeedFiles(templateDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(templateDir, full);
        if (rel === "template.json") continue;
        out.push(rel);
      }
    }
  };
  walk(templateDir);
  return out.sort();
}
