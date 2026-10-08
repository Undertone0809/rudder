import { dump, load } from "js-yaml";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareServerPackagingWorkspace, serverPackagingLockfile } from "./server-packaging-workspace.mjs";

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
  mkdirSync(join(repo, "packages", "shared", "dist"), { recursive: true });
  mkdirSync(join(repo, "server", "resources"), { recursive: true });
  mkdirSync(join(repo, "server", "dist"), { recursive: true });
  mkdirSync(join(repo, "patches"), { recursive: true });
  writeFileSync(join(repo, "server", "dist", "index.js"), "export {};\n");
  writeFileSync(join(repo, "packages", "shared", "dist", "index.js"), "export {};\n");
  writeFileSync(join(repo, "patches", "ui-only-package.patch"), "fixture patch\n");
  cpSync(join(scriptsDir, "../../server/resources/postinstall-embedded-postgres.mjs"), join(repo, "server/resources/postinstall-embedded-postgres.mjs"));
  cpSync(join(scriptsDir, "../../scripts/fixtures/embedded-postgres-18.1.0-beta.16/index.js.txt"), join(repo, "embedded-postgres-original.txt"));
  const rootManifestPath = join(repo, "package.json");
  writeJson(rootManifestPath, {
    name: "rudder-stage-server-fixture",
    private: true,
    packageManager: "pnpm@9.15.4",
    pnpm: {
      allowNonAppliedPatches: true,
      patchedDependencies: { "ui-only-package@1.0.0": "patches/ui-only-package.patch" },
    },
  });
  for (const file of ["stage-server.mjs", "server-packaging-workspace.mjs", "optimize-server-package.mjs"]) {
    cpSync(join(scriptsDir, file), join(repo, "desktop", "scripts", file));
  }
  const require = createRequire(import.meta.url);
  cpSync(dirname(require.resolve("js-yaml/package.json")), join(repo, "desktop/node_modules/js-yaml"), { recursive: true });
  writeFileSync(join(repo, "desktop", "scripts", "prepare-postgres-runtime.mjs"), [
    "const configuredBinDir = process.env.RUDDER_FAKE_PREPARED_POSTGRES_BIN_DIR;",
    "if (!configuredBinDir) process.exit(1);",
    "console.log(configuredBinDir);",
    "",
  ].join("\n"));
  const sharedManifestPath = join(repo, "packages", "shared", "package.json");
  const publishConfig = {
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
  };
  writeJson(sharedManifestPath, {
    name: "@rudderhq/shared", version: "0.2.10", type: "module", files: ["dist"],
    exports: { ".": "./src/index.ts" }, publishConfig,
  });
  writeJson(join(repo, "server", "package.json"), {
    name: "@rudderhq/server", version: "0.2.10", type: "module", files: ["dist", "resources"],
    exports: { ".": "./src/index.ts" }, publishConfig,
    dependencies: { "@rudderhq/shared": "workspace:*" },
  });
  writeFileSync(join(repo, "pnpm-lock.yaml"), dump({
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    patchedDependencies: { "ui-only-package@1.0.0": { hash: "fixture", path: "patches/ui-only-package.patch" } },
    importers: {
      ".": {},
      server: { dependencies: { "@rudderhq/shared": { specifier: "workspace:*", version: "link:../packages/shared" } } },
      "packages/shared": {},
    },
    packages: {}, snapshots: {},
  }));
  const binDir = join(repo, "bin");
  mkdirSync(binDir, { recursive: true });
  const pnpmFixturePath = join(repo, "desktop/node_modules/pnpm/bin/pnpm.cjs");
  mkdirSync(dirname(pnpmFixturePath), { recursive: true });
  writeJson(join(repo, "desktop/node_modules/pnpm/package.json"), { name: "pnpm", exports: { ".": "./package.json" } });
  writeFileSync(pnpmFixturePath, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (process.argv.includes('store')) {",
    "  console.log(path.join(process.cwd(), '.pnpm-store/v3'));",
    "  process.exit(0);",
    "}",
    "const target = process.cwd();",
    "const repo = path.resolve(target, '../../..');",
    "const required = ['install', '--prod', '--frozen-lockfile', '--offline', '--config.node-linker=hoisted'];",
    "if (!required.every((arg) => process.argv.includes(arg)) || process.argv.includes('deploy') || process.argv.includes('--ignore-scripts')) process.exit(45);",
    "if (!process.argv.includes('--store-dir=' + path.join(repo, '.pnpm-store/v3'))) process.exit(46);",
    "const rootManifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));",
    "if (rootManifest.pnpm?.allowNonAppliedPatches !== true) process.exit(44);",
    "if (process.env.RUDDER_FAKE_INSTALL_FAILURE === '1') {",
    "  console.error('fixture: locked package is unavailable in the offline store');",
    "  process.exit(50);",
    "}",
    "fs.writeFileSync(path.join(repo, '.packaging-install-complete'), 'ok\\n');",
    "const postgresRoot = path.join(target, 'node_modules/embedded-postgres');",
    "fs.mkdirSync(path.join(postgresRoot, 'dist'), { recursive: true });",
    "fs.writeFileSync(path.join(postgresRoot, 'package.json'), JSON.stringify({ name: 'embedded-postgres', version: '18.1.0-beta.16', exports: './dist/index.js' }));",
    "fs.copyFileSync(path.join(repo, 'embedded-postgres-original.txt'), path.join(postgresRoot, 'dist/index.js'));",
    "const dbRoot = path.join(target, 'node_modules/@rudderhq/db');",
    "fs.mkdirSync(dbRoot, { recursive: true });",
    "fs.writeFileSync(path.join(dbRoot, 'package.json'), JSON.stringify({ name: '@rudderhq/db' }));",
    "fs.cpSync(path.join(target, 'packages/shared'), path.join(target, 'node_modules/@rudderhq/shared'), { recursive: true });",
    "",
  ].join("\n"));
  return { repo, binDir, rootManifestPath, sharedManifestPath };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("desktop stage-server", () => {
  it("relocates only workspace importers while preserving the locked registry graph", () => {
    const source = load(readFileSync(join(scriptsDir, "../../pnpm-lock.yaml"), "utf8"));
    const original = structuredClone(source);
    const { lockfile, workspaceIds } = serverPackagingLockfile(source);

    expect(source).toEqual(original);
    const { importers: _originalImporters, ...originalRegistry } = original;
    const { importers: _stagedImporters, ...stagedRegistry } = lockfile;
    expect(stagedRegistry).toEqual(originalRegistry);
    expect(lockfile.importers["."].dependencies["@rudderhq/shared"]).toEqual({
      specifier: "workspace:*", version: "link:packages/shared",
    });
    expect(lockfile.importers["packages/agent-runtimes/claude-local"].dependencies["@rudderhq/agent-runtime-utils"])
      .toEqual({ specifier: "workspace:*", version: "link:../../agent-runtime-utils" });
    expect(workspaceIds).toContain("packages/db");
    expect(workspaceIds).not.toContain("ui");
    expect(workspaceIds).not.toContain("desktop");
    expect(lockfile.importers.server).toBeUndefined();
  });

  it("rewrites workspace links back to the server and rejects missing or escaped importers", () => {
    const source = {
      lockfileVersion: "9.0",
      importers: {
        server: { dependencies: { shared: { specifier: "workspace:*", version: "link:../packages/shared" } } },
        "packages/shared": { devDependencies: { server: { specifier: "workspace:*", version: "link:../../server" } } },
      },
      packages: {}, snapshots: {},
    };
    expect(serverPackagingLockfile(source).lockfile.importers["packages/shared"].devDependencies.server.version)
      .toBe("link:../..");
    delete source.importers["packages/shared"];
    expect(() => serverPackagingLockfile(source)).toThrow("Invalid server workspace dependency");
    source.importers.server.dependencies.shared.version = "link:../../outside";
    expect(() => serverPackagingLockfile(source)).toThrow("Invalid server workspace dependency");
  });

  it("installs the locked hoisted graph offline and resolves it after symlink materialization", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rudder-frozen-packaging-test-"));
    tempRoots.push(repo);
    const sourceLock = load(readFileSync(join(scriptsDir, "../../pnpm-lock.yaml"), "utf8"));
    const lockedVersion = "1.1.1";
    const packageId = `picocolors@${lockedVersion}`;
    const dependency = { specifier: "^1.1.0", version: lockedVersion };
    writeJson(join(repo, "package.json"), { private: true, packageManager: "pnpm@9.15.4" });
    for (const [id, name] of [["server", "@rudderhq/server"], ["packages/shared", "@rudderhq/shared"]]) {
      mkdirSync(join(repo, id, "dist"), { recursive: true });
      writeFileSync(join(repo, id, "dist/index.js"), "module.exports = require('picocolors');\n");
      writeJson(join(repo, id, "package.json"), {
        name, version: "1.0.0", files: ["dist"], main: "dist/index.js",
        dependencies: { picocolors: dependency.specifier, ...(id === "server" ? { "@rudderhq/shared": "workspace:*" } : {}) },
      });
    }
    const lock = {
      lockfileVersion: "9.0", settings: sourceLock.settings,
      importers: {
        server: { dependencies: { picocolors: dependency, "@rudderhq/shared": { specifier: "workspace:*", version: "link:../packages/shared" } } },
        "packages/shared": { dependencies: { picocolors: dependency } },
      },
      packages: { [packageId]: sourceLock.packages[packageId] },
      snapshots: { [packageId]: sourceLock.snapshots[packageId] },
    };
    const originalLock = dump(lock);
    writeFileSync(join(repo, "pnpm-lock.yaml"), originalLock);
    const target = join(repo, "staged");
    await prepareServerPackagingWorkspace(repo, target);
    const pnpmCli = join(dirname(createRequire(import.meta.url).resolve("pnpm")), "bin", "pnpm.cjs");
    const store = spawnSync(process.execPath, [pnpmCli, "store", "path", "--silent"], {
      cwd: join(scriptsDir, "../.."), encoding: "utf8",
    });
    expect(store.status, store.stderr).toBe(0);
    const install = spawnSync(process.execPath, [
      pnpmCli, "install", "--prod", "--offline", "--frozen-lockfile",
      "--config.node-linker=hoisted", `--store-dir=${store.stdout.trim()}`,
    ], { cwd: target, encoding: "utf8" });
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
    expect(install.stdout).toContain("resolution step is skipped");
    expect(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")).toBe(originalLock);
    expect(JSON.parse(readFileSync(join(target, "node_modules/picocolors/package.json"), "utf8")).version).toBe(lockedVersion);
    const relocated = join(repo, "relocated");
    // Mirrors Windows after-pack's materialized workspace junctions. Transitive
    // packages must remain reachable from the copied package's new location.
    cpSync(target, relocated, { recursive: true, dereference: true });
    const probe = spawnSync(process.execPath, ["-e", "require('@rudderhq/shared'); console.log(require('picocolors/package.json').version)"], {
      cwd: relocated, encoding: "utf8",
    });
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
    expect(probe.stdout.trim()).toBe(lockedVersion);
  });

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
    const wrapper = readFileSync(join(repo, "desktop/.packaged/server-package/node_modules/embedded-postgres/dist/index.js"));
    expect(createHash("sha256").update(wrapper).digest("hex")).toBe(
      "2ea226713effef5d494fab8a7509d68784fbd86ce333fe463971f45320745941",
    );
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

  it("fails closed without mutating the source when offline staging fails", () => {
    const { repo, binDir, rootManifestPath, sharedManifestPath } = createStageServerRepo();
    const rootBefore = readFileSync(rootManifestPath, "utf8");
    const sharedBefore = readFileSync(sharedManifestPath, "utf8");

    const result = spawnSync("node", ["desktop/scripts/stage-server.mjs"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RUDDER_FAKE_INSTALL_FAILURE: "1",
        RUDDER_SKIP_POSTGRES_RUNTIME_AUTO_PREPARE: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("locked package is unavailable in the offline store");
    expect(() => readFileSync(join(repo, ".packaging-install-complete"))).toThrow();
    expect(readFileSync(rootManifestPath, "utf8")).toBe(rootBefore);
    expect(readFileSync(sharedManifestPath, "utf8")).toBe(sharedBefore);
  });

  it("leaves source manifests and lockfile unchanged after staging", () => {
    const { repo, binDir, rootManifestPath, sharedManifestPath } = createStageServerRepo();
    const rootBefore = readFileSync(rootManifestPath, "utf8");
    const before = readFileSync(sharedManifestPath, "utf8");
    const lockBefore = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");

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
    expect(readFileSync(join(repo, ".packaging-install-complete"), "utf8")).toBe("ok\n");
    expect(readFileSync(rootManifestPath, "utf8")).toBe(rootBefore);
    expect(readFileSync(sharedManifestPath, "utf8")).toBe(before);
    expect(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")).toBe(lockBefore);
    expect(readFileSync(join(repo, "desktop/.packaged/server-package/package.json"), "utf8")).toContain(
      '"default": "./dist/index.js"',
    );
  });
});
