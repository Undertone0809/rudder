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

function writeFakePostgresBinDir(binDir) {
  mkdirSync(binDir, { recursive: true });
  for (const binary of ["initdb", "pg_ctl"]) {
    const binaryPath = join(binDir, process.platform === "win32" ? `${binary}.exe` : binary);
    writeFileSync(binaryPath, "");
    chmodSync(binaryPath, 0o755);
  }
  const postgresPath = join(binDir, process.platform === "win32" ? "postgres.exe" : "postgres");
  if (process.platform === "win32") {
    writeFileSync(postgresPath, "@echo off\r\necho PostgreSQL 18.4\r\n");
  } else {
    writeFileSync(postgresPath, "#!/bin/sh\necho 'PostgreSQL 18.4'\n");
  }
  chmodSync(postgresPath, 0o755);
}

function createStageServerRepo() {
  const repo = mkdtempSync(join(tmpdir(), "rudder-stage-server-test-"));
  tempRoots.push(repo);

  mkdirSync(join(repo, "desktop", "scripts"), { recursive: true });
  mkdirSync(join(repo, "packages", "shared"), { recursive: true });
  mkdirSync(join(repo, "server"), { recursive: true });
  cpSync(join(scriptsDir, "stage-server.mjs"), join(repo, "desktop", "scripts", "stage-server.mjs"));
  writeFileSync(join(repo, "desktop", "scripts", "prepare-postgres-runtime.mjs"), [
    "const configuredBinDir = process.env.RUDDER_FAKE_PREPARED_POSTGRES_BIN_DIR;",
    "if (!configuredBinDir) {",
    "  console.error('missing RUDDER_FAKE_PREPARED_POSTGRES_BIN_DIR');",
    "  process.exit(1);",
    "}",
    "console.log(configuredBinDir);",
    "",
  ].join("\n"));

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
    "if (!process.argv.includes('--legacy')) {",
    "  console.error('expected pnpm deploy --legacy');",
    "  process.exit(42);",
    "}",
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
  it("automatically prepares PostgreSQL 18.4 payload when no bin dir is configured", () => {
    const { repo, binDir } = createStageServerRepo();
    const pgBinDir = join(repo, "prepared-pg-bin");
    writeFakePostgresBinDir(pgBinDir);

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: "",
        RUDDER_ALLOW_LEGACY_EMBEDDED_POSTGRES: "",
        RUDDER_FAKE_PREPARED_POSTGRES_BIN_DIR: pgBinDir,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(repo, "desktop/.packaged/server-package/package.json"), "utf8")).toContain(
      '"default": "./dist/index.js"',
    );
    expect(readFileSync(join(
      repo,
      "desktop/.packaged/postgres-18.4",
      `${process.platform}-${process.arch}`,
      "bin",
      process.platform === "win32" ? "postgres.exe" : "postgres",
    ), "utf8")).toContain("PostgreSQL 18.4");
  });

  it("fails production staging when automatic PostgreSQL preparation is disabled and no payload is configured", () => {
    const { repo, binDir } = createStageServerRepo();

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: "",
        RUDDER_ALLOW_LEGACY_EMBEDDED_POSTGRES: "",
        RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE: "1",
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
        RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE: "1",
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
