#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const roots = ["packages", "server", "ui", "cli"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function discoverPublicPackages() {
  const packages = [];

  function walk(relDir) {
    const absDir = join(repoRoot, relDir);
    if (!existsSync(absDir)) return;

    const pkgPath = join(absDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (!pkg.private) {
        packages.push({
          dir: relDir,
          pkgPath,
          name: pkg.name,
          version: pkg.version,
          pkg,
        });
      }
      return;
    }

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      walk(join(relDir, entry.name));
    }
  }

  for (const rel of roots) {
    walk(rel);
  }

  return packages;
}

function sortTopologically(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) {
      throw new Error(`cycle detected in public package graph at ${pkg.name}`);
    }

    visiting.add(pkg.name);

    const dependencySections = [
      pkg.pkg.dependencies ?? {},
      pkg.pkg.optionalDependencies ?? {},
      pkg.pkg.peerDependencies ?? {},
    ];

    for (const deps of dependencySections) {
      for (const depName of Object.keys(deps)) {
        const dep = byName.get(depName);
        if (dep) visit(dep);
      }
    }

    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  }

  for (const pkg of [...packages].sort((a, b) => a.dir.localeCompare(b.dir))) {
    visit(pkg);
  }

  return ordered;
}

function rewriteInternalDeps(deps, internalPackageNames, value) {
  if (!deps) return deps;
  const next = { ...deps };

  for (const name of Object.keys(next)) {
    if (!internalPackageNames.has(name)) continue;
    next[name] = value;
  }

  return next;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function addDefaultExportCondition(exportsObj) {
  if (typeof exportsObj !== "object" || exportsObj === null || Array.isArray(exportsObj)) {
    return;
  }

  for (const key of Object.keys(exportsObj)) {
    const entry = exportsObj[key];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (entry.import && !entry.default) {
        entry.default = entry.import;
      }
      addDefaultExportCondition(entry);
    }
  }
}

function applyPublishConfigFields(pkg) {
  if (!pkg.publishConfig) return pkg;

  const next = { ...pkg };
  if (pkg.publishConfig.exports) {
    next.exports = cloneJson(pkg.publishConfig.exports);
    addDefaultExportCondition(next.exports);
  }
  if (pkg.publishConfig.main) {
    next.main = pkg.publishConfig.main;
  }
  if (pkg.publishConfig.types) {
    next.types = pkg.publishConfig.types;
  }

  return next;
}

function setPackageManifestVersion(packagePath, version) {
  if (!existsSync(packagePath)) return;
  const pkg = readJson(packagePath);
  writeJson(packagePath, {
    ...pkg,
    version,
  });
}

function setVersion(version, { publish = false } = {}) {
  const packages = sortTopologically(discoverPublicPackages());
  const internalPackageNames = new Set(packages.map((pkg) => pkg.name));
  const internalDependencyValue = publish ? version : "workspace:*";

  for (const pkg of packages) {
    const nextPkg = {
      ...pkg.pkg,
      version,
      dependencies: rewriteInternalDeps(pkg.pkg.dependencies, internalPackageNames, internalDependencyValue),
      optionalDependencies: rewriteInternalDeps(pkg.pkg.optionalDependencies, internalPackageNames, internalDependencyValue),
      peerDependencies: rewriteInternalDeps(pkg.pkg.peerDependencies, internalPackageNames, internalDependencyValue),
      devDependencies: rewriteInternalDeps(pkg.pkg.devDependencies, internalPackageNames, internalDependencyValue),
    };

    writeJson(pkg.pkgPath, publish ? applyPublishConfigFields(nextPkg) : nextPkg);
  }

  setPackageManifestVersion(join(repoRoot, "desktop", "package.json"), version);

  const cliEntryPath = join(repoRoot, "cli/src/program.ts");
  if (existsSync(cliEntryPath)) {
    const cliEntry = readFileSync(cliEntryPath, "utf8");
    const nextCliEntry = cliEntry.replace(
      /\.version\("([^"]+)"\)/,
      `.version("${version}")`,
    );

    if (cliEntry !== nextCliEntry) {
      writeFileSync(cliEntryPath, nextCliEntry);
    }
  }
}

function listPackages() {
  const packages = sortTopologically(discoverPublicPackages());
  for (const pkg of packages) {
    process.stdout.write(`${pkg.dir}\t${pkg.name}\t${pkg.version}\n`);
  }
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/release-package-map.mjs list",
      "  node scripts/release-package-map.mjs set-version <version>",
      "  node scripts/release-package-map.mjs set-publish-version <version> --allow-source-mutation",
      "",
      "Notes:",
      "  set-publish-version rewrites source package manifests into their publish shape.",
      "  Use it only from release automation; normal development should use set-version.",
      "",
    ].join("\n"),
  );
}

const [command, arg, ...flags] = process.argv.slice(2);

function hasFlag(name) {
  return flags.includes(name);
}

function requireOnlyFlags(allowedFlags) {
  const unexpected = flags.filter((flag) => !allowedFlags.includes(flag));
  if (unexpected.length > 0) {
    process.stderr.write(`Unexpected argument(s): ${unexpected.join(", ")}\n\n`);
    usage();
    process.exit(1);
  }
}

if (command === "list") {
  requireOnlyFlags([]);
  listPackages();
  process.exit(0);
}

if (command === "set-version") {
  requireOnlyFlags([]);
  if (!arg) {
    usage();
    process.exit(1);
  }
  setVersion(arg);
  process.exit(0);
}

if (command === "set-publish-version") {
  requireOnlyFlags(["--allow-source-mutation"]);
  if (!arg) {
    usage();
    process.exit(1);
  }

  if (!hasFlag("--allow-source-mutation")) {
    process.stderr.write(
      [
        "Refusing to rewrite source package manifests into publish shape.",
        "Use set-version for normal development version updates.",
        "Release automation may pass --allow-source-mutation and must restore the working tree afterwards.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  setVersion(arg, { publish: true });
  process.exit(0);
}

usage();
process.exit(1);
