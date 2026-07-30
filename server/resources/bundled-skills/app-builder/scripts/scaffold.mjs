#!/usr/bin/env node

import { cp, lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error("Usage: scaffold.mjs --workspace-root <absolute> --target <absolute> --name <name> --slug <slug>");
  }
  args.set(key.slice(2), value);
}

const workspaceInput = args.get("workspace-root");
const targetInput = args.get("target");
const name = args.get("name")?.trim();
const slug = args.get("slug")?.trim();
if (!workspaceInput || !targetInput || !name || !slug) throw new Error("Missing required scaffold argument");
if (!path.isAbsolute(workspaceInput) || !path.isAbsolute(targetInput)) {
  throw new Error("Workspace root and target must be absolute paths");
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Slug must be lowercase hyphen-case");

const workspaceRoot = await realpath(workspaceInput);
const target = path.resolve(targetInput);
if (target === workspaceRoot || !target.startsWith(`${workspaceRoot}${path.sep}`)) {
  throw new Error("Target must be inside the workspace root");
}

await mkdir(path.dirname(target), { recursive: true });
const parent = await realpath(path.dirname(target));
if (parent !== workspaceRoot && !parent.startsWith(`${workspaceRoot}${path.sep}`)) {
  throw new Error("Target parent escapes the workspace through a symlink");
}

const existing = await lstat(target).catch(() => null);
if (existing?.isSymbolicLink()) throw new Error("Refusing to scaffold into a symlink");
if (existing && !existing.isDirectory()) throw new Error("Target exists and is not a directory");
if (existing && (await readdir(target)).length > 0) throw new Error("Refusing to overwrite a non-empty target");

const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(skillRoot, "assets", "scaffold");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, errorOnExist: true, force: false });

const packagePath = path.join(target, "package.json");
const manifestPath = path.join(target, "rudder.app.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
packageJson.name = slug;
manifest.app = { name, slug };
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`${target}\n`);
