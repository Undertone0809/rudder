import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  ensureLegacyPostgresTimezoneCompatibility,
  isInstalledServerPackage,
} from "../server/resources/postinstall-postgres-compat.mjs";

const roots = [];

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-postinstall-compat-"));
  roots.push(root);
  return root;
}

function writeNestedRuntime(
  rudderHome,
  runtimeParent = path.join("runtime-payloads"),
  options = {},
) {
  const platform = options.platform ?? "darwin";
  const arch = options.arch ?? "arm64";
  const runtimeRoot = path.join(
    rudderHome,
    runtimeParent,
    "postgres-18.4",
    `${platform}-${arch}`,
  );
  const binDir = path.join(runtimeRoot, "bin");
  const templateDir = path.join(runtimeRoot, "share", "postgresql");
  const timezoneDir = path.join(templateDir, "timezone");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(timezoneDir, { recursive: true });
  for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    writeFileSync(
      path.join(binDir, `${binary}${platform === "win32" ? ".exe" : ""}`),
      "PostgreSQL 18.4",
      "utf8",
    );
  }
  writeFileSync(path.join(templateDir, "postgres.bki"), "templates", "utf8");
  writeFileSync(path.join(templateDir, "postgresql.conf.sample"), "config", "utf8");
  writeFileSync(path.join(timezoneDir, "UTC"), "timezone", "utf8");
  return { binDir, runtimeRoot };
}

function assertLegacyStrictUpdaterAccepts(binDir, platform = "darwin") {
  for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    assert.equal(
      statSync(path.join(binDir, `${binary}${platform === "win32" ? ".exe" : ""}`)).isFile(),
      true,
    );
  }
  assert.equal(
    statSync(path.join(binDir, "..", "share", "postgresql", "postgres.bki")).isFile(),
    true,
  );
  assert.equal(
    statSync(path.join(binDir, "..", "share", "timezone")).isDirectory(),
    true,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("server runtime postinstall compatibility", () => {
  it("bridges the official nested timezone layout for strict older Desktop updaters", () => {
    const rudderHome = makeRoot();
    const { binDir, runtimeRoot } = writeNestedRuntime(rudderHome);

    assert.throws(() => assertLegacyStrictUpdaterAccepts(binDir));
    const results = ensureLegacyPostgresTimezoneCompatibility({
      env: { RUDDER_HOME: rudderHome },
      homeDir: makeRoot(),
      platform: "darwin",
      arch: "arm64",
    });

    assert.deepEqual(results, [{ status: "linked", binDir }]);
    assertLegacyStrictUpdaterAccepts(binDir);
    assert.equal(
      readFileSync(path.join(runtimeRoot, "share", "timezone", "UTC"), "utf8"),
      "timezone",
    );
  });

  it("repairs shared and versioned managed payloads and remains idempotent", () => {
    const rudderHome = makeRoot();
    const shared = writeNestedRuntime(rudderHome);
    const versioned = writeNestedRuntime(rudderHome, path.join("runtimes", "0.6.2"));

    const first = ensureLegacyPostgresTimezoneCompatibility({
      env: { RUDDER_HOME: rudderHome },
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(first.filter((result) => result.status === "linked").length, 2);
    assertLegacyStrictUpdaterAccepts(shared.binDir);
    assertLegacyStrictUpdaterAccepts(versioned.binDir);

    const second = ensureLegacyPostgresTimezoneCompatibility({
      env: { RUDDER_HOME: rudderHome },
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(second.every((result) => result.status === "already_compatible"), true);
  });

  it("does not modify operator-provided PostgreSQL paths outside Rudder home", () => {
    const rudderHome = makeRoot();
    const externalHome = makeRoot();
    const external = writeNestedRuntime(externalHome);

    const results = ensureLegacyPostgresTimezoneCompatibility({
      env: {
        RUDDER_HOME: rudderHome,
        RUDDER_POSTGRES_BIN_DIR: external.binDir,
        RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR: external.binDir,
      },
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(results.some((result) => result.binDir === external.binDir), false);
    assert.throws(() => statSync(path.join(external.runtimeRoot, "share", "timezone")));
  });

  it("does not follow a managed runtime symlink outside Rudder home", () => {
    const rudderHome = makeRoot();
    const externalHome = makeRoot();
    const external = writeNestedRuntime(externalHome, path.join("runtimes", "external"));
    const linkedRuntime = path.join(rudderHome, "runtimes", "linked");
    mkdirSync(path.dirname(linkedRuntime), { recursive: true });
    symlinkSync(
      path.join(externalHome, "runtimes", "external"),
      linkedRuntime,
      process.platform === "win32" ? "junction" : "dir",
    );

    const results = ensureLegacyPostgresTimezoneCompatibility({
      env: { RUDDER_HOME: rudderHome },
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(results.some((result) => result.status === "outside_managed_home"), true);
    assert.throws(() => statSync(path.join(external.runtimeRoot, "share", "timezone")));
  });

  it("ships the bridge as the server package postinstall hook", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../server/package.json"), "utf8"),
    );
    assert.equal(
      packageJson.scripts.postinstall,
      "node resources/postinstall-postgres-compat.mjs",
    );
    assert.equal(packageJson.files.includes("resources"), true);
  });

  it("does not mutate a developer home when the workspace lifecycle hook runs", () => {
    const rudderHome = makeRoot();
    const { runtimeRoot } = writeNestedRuntime(rudderHome);
    const script = path.resolve(
      import.meta.dirname,
      "../server/resources/postinstall-postgres-compat.mjs",
    );

    const run = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUDDER_HOME: rudderHome,
      },
    });

    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.throws(() => statSync(path.join(runtimeRoot, "share", "timezone")));
    assert.equal(isInstalledServerPackage(path.dirname(script)), false);
    assert.equal(
      isInstalledServerPackage(path.join(makeRoot(), "node_modules", "@rudderhq", "server", "resources")),
      true,
    );
  });

  it("runs from an installed target server package before a legacy validator", () => {
    const rudderHome = makeRoot();
    const { binDir } = writeNestedRuntime(
      rudderHome,
      path.join("runtime-payloads"),
      { platform: process.platform, arch: process.arch },
    );
    const packageRoot = path.join(
      makeRoot(),
      "node_modules",
      "@rudderhq",
      "server",
    );
    const installedScript = path.join(
      packageRoot,
      "resources",
      "postinstall-postgres-compat.mjs",
    );
    mkdirSync(path.dirname(installedScript), { recursive: true });
    copyFileSync(
      path.resolve(import.meta.dirname, "../server/resources/postinstall-postgres-compat.mjs"),
      installedScript,
    );

    const run = spawnSync(process.execPath, [installedScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUDDER_HOME: rudderHome,
      },
    });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /prepared PostgreSQL runtime compatibility/);
    assertLegacyStrictUpdaterAccepts(binDir, process.platform);
  });
});
