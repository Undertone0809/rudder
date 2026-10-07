/**
 * esbuild configuration for building the rudder CLI for npm.
 *
 * Bundles all workspace packages (@rudderhq/*) into a single file.
 * External npm packages remain as regular dependencies.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workspace packages whose code should be bundled into the thin bootstrap CLI.
// Heavy runtime packages are installed into the versioned runtime cache instead.
const workspacePaths = [
  "cli",
  "packages/shared",
  "packages/agent-runtime-utils",
];

// Workspace packages that should never be pulled into the bootstrap bundle.
// Runtime setup installs these through @rudderhq/server when needed.
const externalWorkspacePackages = new Set([
  "@rudderhq/agent-runtime-claude-local",
  "@rudderhq/agent-runtime-codex-local",
  "@rudderhq/agent-runtime-cursor-local",
  "@rudderhq/agent-runtime-openclaw-gateway",
  "@rudderhq/agent-runtime-opencode-local",
  "@rudderhq/agent-runtime-pi-local",
  "@rudderhq/db",
  "@rudderhq/run-intelligence-core",
  "@rudderhq/server",
]);

// Collect all external (non-workspace) npm package names
const externals = new Set();
for (const p of workspacePaths) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, p, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (externalWorkspacePackages.has(name)) {
      externals.add(name);
    } else if (!name.startsWith("@rudderhq/")) {
      externals.add(name);
    }
  }
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    externals.add(name);
  }
}
// Also add all published workspace packages as external
for (const name of externalWorkspacePackages) {
  externals.add(name);
}

/** @type {import('esbuild').BuildOptions} */
export default {
  // program.ts deliberately loads these by a variable specifier to keep heavy
  // commands out of startup. esbuild cannot discover those imports, so emit
  // their modules explicitly while preserving lazy command registration.
  entryPoints: {
    index: "src/index.ts",
    "commands/worktree": "src/commands/worktree.ts",
    "commands/db-backup": "src/commands/db-backup.ts",
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
};
