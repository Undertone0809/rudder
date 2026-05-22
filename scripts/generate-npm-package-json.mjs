#!/usr/bin/env node
/**
 * generate-npm-package-json.mjs
 *
 * Reads the dev package.json (which has workspace:* refs) and produces
 * a publishable package.json in cli/ with:
 *   - workspace:* dependencies removed
 *   - all external dependencies from workspace packages inlined
 *   - proper metadata for npm
 *
 * Reads from cli/package.dev.json if it exists (build already ran),
 * otherwise from cli/package.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function readPkg(relativePath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath, "package.json"), "utf8"));
}

// Read all workspace packages that are bundled into the thin bootstrap CLI.
// Heavy runtime packages are installed into the versioned runtime cache by
// `rudder start` / `rudder run` and must not appear in the CLI dependency tree.
const workspacePaths = [
  "cli",
  "packages/shared",
  "packages/agent-runtime-utils",
];

const runtimeWorkspacePackages = new Set([
  "@rudderhq/agent-runtime-claude-local",
  "@rudderhq/agent-runtime-codex-local",
  "@rudderhq/agent-runtime-cursor-local",
  "@rudderhq/agent-runtime-gemini-local",
  "@rudderhq/agent-runtime-openclaw-gateway",
  "@rudderhq/agent-runtime-opencode-local",
  "@rudderhq/agent-runtime-pi-local",
  "@rudderhq/db",
  "@rudderhq/run-intelligence-core",
  "@rudderhq/server",
]);

// Collect all external dependencies from all workspace packages
const allDeps = {};
const allOptionalDeps = {};

for (const pkgPath of workspacePaths) {
  const pkg = readPkg(pkgPath);
  const deps = pkg.dependencies || {};
  const optDeps = pkg.optionalDependencies || {};

  for (const [name, version] of Object.entries(deps)) {
    if (runtimeWorkspacePackages.has(name)) continue;
    if (name.startsWith("@rudderhq/")) continue;
    // Keep the more specific (pinned) version if conflict
    if (!allDeps[name] || !version.startsWith("^")) {
      allDeps[name] = version;
    }
  }

  for (const [name, version] of Object.entries(optDeps)) {
    allOptionalDeps[name] = version;
  }
}

// Sort alphabetically
const sortedDeps = Object.fromEntries(Object.entries(allDeps).sort(([a], [b]) => a.localeCompare(b)));
const sortedOptDeps = Object.fromEntries(
  Object.entries(allOptionalDeps).sort(([a], [b]) => a.localeCompare(b)),
);

// Read the CLI package metadata — prefer the dev backup if it exists
const devPkgPath = resolve(repoRoot, "cli/package.dev.json");
const cliPkg = existsSync(devPkgPath)
  ? JSON.parse(readFileSync(devPkgPath, "utf8"))
  : readPkg("cli");

// Build the publishable package.json
const publishPkg = {
  name: cliPkg.name,
  version: cliPkg.version,
  description: cliPkg.description,
  type: cliPkg.type,
  bin: cliPkg.bin,
  keywords: cliPkg.keywords,
  license: cliPkg.license,
  repository: cliPkg.repository,
  homepage: cliPkg.homepage,
  bugs: cliPkg.bugs,
  files: cliPkg.files,
  engines: { node: ">=20" },
  dependencies: sortedDeps,
};

if (Object.keys(sortedOptDeps).length > 0) {
  publishPkg.optionalDependencies = sortedOptDeps;
}

const output = JSON.stringify(publishPkg, null, 2) + "\n";
const outPath = resolve(repoRoot, "cli/package.json");
writeFileSync(outPath, output);

console.log(`  ✓  Generated publishable package.json (${Object.keys(sortedDeps).length} deps)`);
console.log(`     Version: ${cliPkg.version}`);
