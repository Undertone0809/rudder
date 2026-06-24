import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const tempRoots = [];

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createStageServerRepo() {
  const repo = mkdtempSync(join(tmpdir(), "rudder-stage-server-test-"));
  tempRoots.push(repo);

  mkdirSync(join(repo, "desktop", "scripts"), { recursive: true });
  mkdirSync(join(repo, "packages", "shared"), { recursive: true });
  mkdirSync(join(repo, "server"), { recursive: true });
  cpSync(join(scriptsDir, "stage-server.mjs"), join(repo, "desktop", "scripts", "stage-server.mjs"));

  const sharedManifestPath = join(repo, "packages", "shared", "package.json");
  const sharedManifest = {
    name: "@rudderhq/shared",
    version: "0.2.10",
    type: "module",
    exports: {
      ".": "./src/index.ts",
    },
    publishConfig: {
      access: "public",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
  };
  writeJson(sharedManifestPath, sharedManifest);

  writeJson(join(repo, "server", "package.json"), {
    name: "@rudderhq/server",
    version: "0.2.10",
    type: "module",
    exports: {
      ".": "./src/index.ts",
    },
    publishConfig: {
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
  });

  const binDir = join(repo, "bin");
  mkdirSync(binDir, { recursive: true });
  const pnpmFixturePath = join(binDir, "pnpm-fixture.cjs");
  writeFileSync(pnpmFixturePath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const repo = process.cwd();",
    "const target = process.argv.at(-1);",
    "const publishedShared = {",
    "  name: '@rudderhq/shared',",
    "  version: '0.2.10',",
    "  type: 'module',",
    "  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' } },",
    "  publishConfig: { main: './dist/index.js', types: './dist/index.d.ts' },",
    "  main: './dist/index.js',",
    "  types: './dist/index.d.ts'",
    "};",
    "fs.writeFileSync(path.join(repo, 'packages/shared/package.json'), JSON.stringify(publishedShared, null, 2) + '\\n');",
    "fs.mkdirSync(path.join(target, 'dist'), { recursive: true });",
    "fs.writeFileSync(path.join(target, 'dist/index.js'), 'export {};\\n');",
    "fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@rudderhq/server', publishConfig: { exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }, main: './dist/index.js', types: './dist/index.d.ts' } }, null, 2) + '\\n');",
    "const sharedStore = path.join(target, 'node_modules/.pnpm/@rudderhq+shared@file+packages+shared/node_modules/@rudderhq/shared');",
    "fs.mkdirSync(sharedStore, { recursive: true });",
    "fs.linkSync(path.join(repo, 'packages/shared/package.json'), path.join(sharedStore, 'package.json'));",
    "const sharedTarget = path.join(target, 'node_modules/@rudderhq');",
    "fs.mkdirSync(sharedTarget, { recursive: true });",
    "fs.cpSync(sharedStore, path.join(sharedTarget, 'shared'), { recursive: true });",
    "",
  ].join("\n"));

  const pnpmPath = join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  if (process.platform === "win32") {
    writeFileSync(pnpmPath, `@echo off\r\nnode "%~dp0\\pnpm-fixture.cjs" %*\r\n`);
  } else {
    writeFileSync(pnpmPath, `#!/bin/sh\nexec node "$(dirname "$0")/pnpm-fixture.cjs" "$@"\n`);
  }
  chmodSync(pnpmPath, 0o755);

  return { repo, binDir, sharedManifestPath };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("desktop stage-server", () => {
  it("fails production staging when no PostgreSQL 18.4 payload is configured", () => {
    const { repo, binDir } = createStageServerRepo();

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: "",
        RUDDER_ALLOW_LEGACY_EMBEDDED_POSTGRES: "",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires RUDDER_POSTGRES_BIN_DIR");
  });

  it("fails production staging when the PostgreSQL payload is incomplete", () => {
    const { repo, binDir } = createStageServerRepo();
    const pgBinDir = join(repo, "fake-pg-bin");
    mkdirSync(pgBinDir, { recursive: true });
    writeFileSync(join(pgBinDir, process.platform === "win32" ? "postgres.exe" : "postgres"), "");

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: pgBinDir,
        RUDDER_ALLOW_LEGACY_EMBEDDED_POSTGRES: "",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must contain PostgreSQL 18.4 initdb, pg_ctl, and postgres binaries");
  });

  it("restores source package manifests after pnpm deploy rewrites them", () => {
    const { repo, binDir, sharedManifestPath } = createStageServerRepo();
    const before = readFileSync(sharedManifestPath, "utf8");

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_ALLOW_LEGACY_EMBEDDED_POSTGRES: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(sharedManifestPath, "utf8")).toBe(before);
    expect(readFileSync(join(repo, "desktop/.packaged/server-package/package.json"), "utf8")).toContain(
      '"default": "./dist/index.js"',
    );
  });
});
