import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const tempRoots = [];

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFakePostgresBinDir(binDir, timezoneLayout = "nested") {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(binDir, "..", "lib"), { recursive: true });
  mkdirSync(join(binDir, "..", "share", "postgresql"), { recursive: true });
  const timezoneDir = timezoneLayout === "nested"
    ? join(binDir, "..", "share", "postgresql", "timezone")
    : join(binDir, "..", "share", "timezone");
  mkdirSync(timezoneDir, { recursive: true });
  writeFileSync(join(binDir, "..", "lib", "libzstd.1.dylib"), "runtime library\n");
  writeFileSync(join(binDir, "..", "share", "postgresql", "postgres.bki"), "postgres template\n");
  writeFileSync(join(binDir, "..", "share", "postgresql", "postgresql.conf.sample"), "postgres config template\n");
  writeFileSync(join(timezoneDir, "UTC"), "timezone data\n");
  for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    const binaryPath = join(binDir, process.platform === "win32" ? `${binary}.exe` : binary);
    if (process.platform === "win32") {
      writeFileSync(binaryPath, "@echo off\r\necho PostgreSQL 18.4\r\n");
    } else {
      writeFileSync(binaryPath, "#!/bin/sh\necho 'PostgreSQL 18.4'\n");
    }
    chmodSync(binaryPath, 0o755);
  }
}

function createStageServerRepo() {
  const repo = mkdtempSync(join(tmpdir(), "rudder-stage-server-test-"));
  tempRoots.push(repo);

  mkdirSync(join(repo, "desktop", "scripts"), { recursive: true });
  mkdirSync(join(repo, "packages", "shared"), { recursive: true });
  mkdirSync(join(repo, "server"), { recursive: true });
  const rootManifestPath = join(repo, "package.json");
  writeJson(rootManifestPath, {
    name: "rudder-stage-server-fixture",
    private: true,
    pnpm: {
      patchedDependencies: {
        "ui-only-package@1.0.0": "patches/ui-only-package.patch",
      },
    },
  });
  cpSync(join(scriptsDir, "stage-server.mjs"), join(repo, "desktop", "scripts", "stage-server.mjs"));
  cpSync(
    join(scriptsDir, "optimize-server-package.mjs"),
    join(repo, "desktop", "scripts", "optimize-server-package.mjs"),
  );
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
    "if (process.argv.includes('install')) {",
    "  const required = ['--offline', '--frozen-lockfile', '--force'];",
    "  if (process.argv.includes('--ignore-scripts')) process.exit(46);",
    "  if (!required.every((arg) => process.argv.includes(arg))) process.exit(45);",
    "  fs.writeFileSync(path.join(repo, '.workspace-install-restored'), 'ok\\n');",
    "  process.exit(0);",
    "}",
    "if (process.argv.includes('--legacy')) {",
    "  console.error('pnpm deploy --legacy is no longer supported');",
    "  process.exit(42);",
    "}",
    "if (process.env.PNPM_CONFIG_FORCE_LEGACY_DEPLOY !== 'true') {",
    "  console.error('pnpm deploy requires force-legacy-deploy config for non-injected workspace packages');",
    "  process.exit(43);",
    "}",
    "const rootManifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));",
    "if (rootManifest.pnpm?.allowNonAppliedPatches !== true) {",
    "  console.error('pnpm deploy requires temporary non-applied patch allowance');",
    "  process.exit(44);",
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

  return { repo, binDir, rootManifestPath, sharedManifestPath };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("desktop stage-server", () => {
  it.skipIf(process.platform === "win32")("caches prepared PostgreSQL runtime from a sibling work directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "rudder-prepare-postgres-test-"));
    tempRoots.push(root);

    const sourceRoot = join(root, "source");
    const pgBinDir = join(sourceRoot, "pgsql", "bin");
    writeFakePostgresBinDir(pgBinDir);
    const versionedLibPath = join(sourceRoot, "pgsql", "lib", "libzstd.1.5.7.dylib");
    writeFileSync(versionedLibPath, "runtime library via symlink\n");
    rmSync(join(sourceRoot, "pgsql", "lib", "libzstd.1.dylib"), { force: true });
    symlinkSync(versionedLibPath, join(sourceRoot, "pgsql", "lib", "libzstd.1.dylib"));
    mkdirSync(join(sourceRoot, "pgsql", "pgAdmin 4.app", "Contents", "Frameworks"), { recursive: true });
    symlinkSync(
      join(sourceRoot, "pgsql", "missing-private-headers"),
      join(sourceRoot, "pgsql", "pgAdmin 4.app", "Contents", "Frameworks", "PrivateHeaders"),
    );
    const archivePath = join(root, "postgres-runtime.tar");
    const tarResult = spawnSync("tar", ["-cf", archivePath, "-C", sourceRoot, "pgsql"], {
      encoding: "utf8",
    });
    expect(tarResult.status, `${tarResult.stdout}\n${tarResult.stderr}`).toBe(0);

    const cacheDir = join(root, "cache");
    const result = spawnSync("node", [join(scriptsDir, "prepare-postgres-runtime.mjs")], {
      env: {
        ...process.env,
        RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: pathToFileURL(archivePath).href,
        RUDDER_POSTGRES_RUNTIME_CACHE_DIR: cacheDir,
      },
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const preparedBinDir = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    expect(readFileSync(join(preparedBinDir, process.platform === "win32" ? "postgres.exe" : "postgres"), "utf8")).toContain("PostgreSQL 18.4");
    expect(readFileSync(join(preparedBinDir, "..", "lib", "libzstd.1.dylib"), "utf8")).toBe("runtime library via symlink\n");
    expect(readFileSync(join(preparedBinDir, "..", "share", "postgresql", "postgres.bki"), "utf8")).toBe("postgres template\n");
    expect(readFileSync(join(preparedBinDir, "..", "share", "postgresql", "postgresql.conf.sample"), "utf8")).toBe("postgres config template\n");
    expect(readFileSync(join(preparedBinDir, "..", "share", "postgresql", "timezone", "UTC"), "utf8")).toBe("timezone data\n");
    expect(() => readFileSync(join(preparedBinDir, "..", "pgAdmin 4.app"))).toThrow();

    const preparedRuntimeRoot = dirname(preparedBinDir);
    const interruptedPreviousRoot = `${preparedRuntimeRoot}.previous-crash`;
    const interruptedWorkRoot = join(
      dirname(preparedRuntimeRoot),
      `.${basename(preparedRuntimeRoot)}.download-crash`,
    );
    cpSync(preparedRuntimeRoot, interruptedPreviousRoot, { recursive: true });
    writeFileSync(join(interruptedPreviousRoot, "restored-marker"), "restored\n");
    rmSync(join(preparedRuntimeRoot, "share", "postgresql", "postgresql.conf.sample"));
    mkdirSync(interruptedWorkRoot, { recursive: true });
    writeFileSync(join(interruptedWorkRoot, "stale-marker"), "stale\n");

    const recovered = spawnSync("node", [join(scriptsDir, "prepare-postgres-runtime.mjs")], {
      env: {
        ...process.env,
        RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: pathToFileURL(join(root, "missing.tar")).href,
        RUDDER_POSTGRES_RUNTIME_CACHE_DIR: cacheDir,
      },
      encoding: "utf8",
    });

    expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(readFileSync(join(preparedRuntimeRoot, "restored-marker"), "utf8")).toBe("restored\n");
    expect(() => readFileSync(join(interruptedWorkRoot, "stale-marker"), "utf8")).toThrow();
    expect(() => readFileSync(join(cacheDir, ".postgres-runtime.lifecycle.lock", "owner.json"), "utf8")).toThrow();
  });

  it.skipIf(process.platform === "win32")("accepts the legacy flat PostgreSQL timezone layout", () => {
    const root = mkdtempSync(join(tmpdir(), "rudder-prepare-postgres-flat-test-"));
    tempRoots.push(root);

    const sourceRoot = join(root, "source");
    writeFakePostgresBinDir(join(sourceRoot, "pgsql", "bin"), "flat");
    const archivePath = join(root, "postgres-runtime.tar");
    const tarResult = spawnSync("tar", ["-cf", archivePath, "-C", sourceRoot, "pgsql"], {
      encoding: "utf8",
    });
    expect(tarResult.status, `${tarResult.stdout}\n${tarResult.stderr}`).toBe(0);

    const result = spawnSync("node", [join(scriptsDir, "prepare-postgres-runtime.mjs")], {
      env: {
        ...process.env,
        RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL: pathToFileURL(archivePath).href,
        RUDDER_POSTGRES_RUNTIME_CACHE_DIR: join(root, "cache"),
      },
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const preparedBinDir = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    expect(readFileSync(join(preparedBinDir, "..", "share", "timezone", "UTC"), "utf8")).toBe("timezone data\n");
  });

  it("does not bundle PostgreSQL runtime by default", () => {
    const { repo, binDir } = createStageServerRepo();
    const pgBinDir = join(repo, "prepared-pg", "bin");
    writeFakePostgresBinDir(pgBinDir);

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: "",
        RUDDER_FAKE_PREPARED_POSTGRES_BIN_DIR: pgBinDir,
      },
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(join(repo, "desktop/.packaged/server-package/package.json"), "utf8")).toContain(
      '"default": "./dist/index.js"',
    );
    expect(() => readFileSync(join(repo, "desktop/.packaged/postgres-18.4"))).toThrow();
  });

  it.skipIf(process.platform === "win32")("optionally prepares PostgreSQL 18.4 payload when bundling is explicitly enabled", () => {
    const { repo, binDir } = createStageServerRepo();
    const pgBinDir = join(repo, "prepared-pg", "bin");
    writeFakePostgresBinDir(pgBinDir);

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: "",
        RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME: "1",
        RUDDER_FAKE_PREPARED_POSTGRES_BIN_DIR: pgBinDir,
      },
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(join(
      repo,
      "desktop/.packaged/postgres-18.4",
      `${process.platform}-${process.arch}`,
      "bin",
      process.platform === "win32" ? "postgres.exe" : "postgres",
    ), "utf8")).toContain("PostgreSQL 18.4");
    expect(readFileSync(join(
      repo,
      "desktop/.packaged/postgres-18.4",
      `${process.platform}-${process.arch}`,
      "lib",
      "libzstd.1.dylib",
    ), "utf8")).toBe("runtime library\n");
    expect(readFileSync(join(
      repo,
      "desktop/.packaged/postgres-18.4",
      `${process.platform}-${process.arch}`,
      "share",
      "postgresql",
      "postgres.bki",
    ), "utf8")).toBe("postgres template\n");
    expect(readFileSync(join(
      repo,
      "desktop/.packaged/postgres-18.4",
      `${process.platform}-${process.arch}`,
      "share",
      "postgresql",
      "postgresql.conf.sample",
    ), "utf8")).toBe("postgres config template\n");
    expect(readFileSync(join(
      repo,
      "desktop/.packaged/postgres-18.4",
      `${process.platform}-${process.arch}`,
      "share",
      "postgresql",
      "timezone",
      "UTC",
    ), "utf8")).toBe("timezone data\n");
  });

  it("fails PostgreSQL bundling when automatic preparation is disabled and no payload is configured", () => {
    const { repo, binDir } = createStageServerRepo();

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: "",
        RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME: "1",
        RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME=1 requires RUDDER_POSTGRES_BIN_DIR");
  });

  it("fails production staging when the PostgreSQL payload is incomplete", () => {
    const { repo, binDir } = createStageServerRepo();
    const pgBinDir = join(repo, "fake-pg", "bin");
    mkdirSync(pgBinDir, { recursive: true });
    writeFileSync(join(pgBinDir, process.platform === "win32" ? "postgres.exe" : "postgres"), "");

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: pgBinDir,
        RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must include PostgreSQL 18.4");
    expect(result.stderr).toContain("initdb");
    expect(result.stderr).toContain("pg_ctl");
    expect(result.stderr).toContain("postgres.bki");
  });

  it.skipIf(process.platform === "win32")("rejects a mixed-version PostgreSQL payload", () => {
    const { repo, binDir } = createStageServerRepo();
    const pgBinDir = join(repo, "fake-pg", "bin");
    writeFakePostgresBinDir(pgBinDir);
    writeFileSync(
      join(pgBinDir, "pg_ctl"),
      "#!/bin/sh\necho 'pg_ctl (PostgreSQL) 17.9'\n",
    );
    chmodSync(join(pgBinDir, "pg_ctl"), 0o755);

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: pgBinDir,
        RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME: "1",
        RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must contain PostgreSQL 18.4 pg_ctl");
    expect(result.stderr).toContain("17.9");
  });

  it("fails production staging when the PostgreSQL initdb template is missing", () => {
    const { repo, binDir } = createStageServerRepo();
    const pgBinDir = join(repo, "fake-pg", "bin");
    writeFakePostgresBinDir(pgBinDir);
    rmSync(join(pgBinDir, "..", "share"), { recursive: true, force: true });

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_POSTGRES_BIN_DIR: pgBinDir,
        RUDDER_ALLOW_LEGACY_EMBEDDED_POSTGRES: "",
        RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must include PostgreSQL 18.4");
    expect(result.stderr).toContain("initdb template files");
    expect(result.stderr).toContain("postgres.bki");
  }, 15_000);

  it("restores source package manifests after pnpm deploy rewrites them", () => {
    const { repo, binDir, rootManifestPath, sharedManifestPath } = createStageServerRepo();
    const rootBefore = readFileSync(rootManifestPath, "utf8");
    const before = readFileSync(sharedManifestPath, "utf8");

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(repo, ".workspace-install-restored"), "utf8")).toBe("ok\n");
    expect(readFileSync(rootManifestPath, "utf8")).toBe(rootBefore);
    expect(readFileSync(sharedManifestPath, "utf8")).toBe(before);
    expect(readFileSync(join(repo, "desktop/.packaged/server-package/package.json"), "utf8")).toContain(
      '"default": "./dist/index.js"',
    );
  });
});
