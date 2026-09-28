import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildServerEnvironment,
  inspectInstalledPrefix,
  isPathInside,
  nativeBinaryName,
  parseArgs,
  SMOKE_NATIVE_TARGETS,
  targetMatchesHost,
} from "./installed-member-directory.mjs";

const roots = [];

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-member-directory-installed-fixture."));
  roots.push(root);
  return root;
}

function makeInstalledPrefix(prefix, targets) {
  const serverRoot = path.join(prefix, "node_modules", "@rudderhq", "server");
  const cliRoot = path.join(prefix, "node_modules", "@rudderhq", "cli");
  mkdirSync(path.join(serverRoot, "dist"), { recursive: true });
  mkdirSync(path.join(cliRoot, "dist"), { recursive: true });
  writeFileSync(path.join(serverRoot, "package.json"), JSON.stringify({ name: "@rudderhq/server" }));
  writeFileSync(path.join(cliRoot, "package.json"), JSON.stringify({ name: "@rudderhq/cli" }));
  writeFileSync(path.join(serverRoot, "dist", "index.js"), "");
  writeFileSync(path.join(cliRoot, "dist", "index.js"), "");
  for (const target of targets) {
    const binaryPath = path.join(serverRoot, "resources", "native", target, nativeBinaryName(target));
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "fixture binary");
    if (targetMatchesHost(target, process.platform, process.arch) && process.platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("installed member-directory smoke harness", () => {
  it("omits bridge mode, signer, and binary overrides from the default server environment", () => {
    const env = buildServerEnvironment({
      PATH: "/usr/bin",
      RUDDER_HOME: "/repo/.rudder",
      RUDDER_RUST_MEMBER_DIRECTORY_MODE: "off",
      RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: "inherited-secret",
      RUDDER_SERVER_FOUNDATION_PATH: "/repo/native/target/debug/rudder-server-foundation",
      RUDDER_NATIVE_MODE: "off",
      RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: "/repo/native/target/debug/migration-preflight",
    }, {
      home: "/tmp/member-directory-home",
      apiPort: 31_001,
      databasePort: 54_001,
      instanceId: "member-directory-smoke-test",
      jwtSecret: "ephemeral-jwt-test-secret",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.RUDDER_HOME, "/tmp/member-directory-home");
    assert.equal(env.RUDDER_RUST_BRIDGE_DEBUG, "true");
    for (const key of [
      "RUDDER_RUST_MEMBER_DIRECTORY_MODE",
      "RUDDER_NATIVE_ACTOR_ENVELOPE_KEY",
      "RUDDER_SERVER_FOUNDATION_PATH",
      "RUDDER_NATIVE_MODE",
      "RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH",
    ]) {
      assert.equal(Object.hasOwn(env, key), false, `${key} leaked into the default run`);
    }
  });

  it("discovers six installed native entries but selects only the current host binary", async () => {
    const prefix = makeRoot();
    makeInstalledPrefix(prefix, SMOKE_NATIVE_TARGETS);

    const installed = await inspectInstalledPrefix(prefix);

    assert.equal(installed.coverageMode, "full-package");
    assert.equal(installed.nativeEntries.length, 6);
    assert.equal(installed.hostNativeEntry.target, SMOKE_NATIVE_TARGETS.find((target) => (
      targetMatchesHost(target, process.platform, process.arch)
    )));
    assert.equal(isPathInside(installed.installRoot, installed.serverPackageRoot), true);
    assert.equal(isPathInside(installed.installRoot, installed.cliPackageRoot), true);
    assert.equal(isPathInside(installed.installRoot, installed.legacyNativeRoot), true);
    assert.equal(isPathInside(installed.legacyNativeRoot, path.resolve(import.meta.dirname, "../..")), false);
  });

  it("allows a host-only development fixture only when explicitly requested", async () => {
    const prefix = makeRoot();
    const hostTarget = SMOKE_NATIVE_TARGETS.find((target) => (
      targetMatchesHost(target, process.platform, process.arch)
    ));
    assert.ok(hostTarget, `unsupported fixture host ${process.platform}/${process.arch}`);
    makeInstalledPrefix(prefix, [hostTarget]);

    assert.equal(parseArgs(["--install-root", prefix]).coverageMode, "full-package");
    assert.equal(parseArgs([
      "--install-root",
      prefix,
      "--host-only-development-fixture",
    ]).coverageMode, "host-only-development-fixture");
    await assert.rejects(
      inspectInstalledPrefix(prefix),
      /full-package acceptance requires all 6 known native target directories/u,
    );

    const installed = await inspectInstalledPrefix(prefix, {
      coverageMode: "host-only-development-fixture",
    });

    assert.equal(installed.coverageMode, "host-only-development-fixture");
    assert.deepEqual(installed.nativeEntries.map(({ target }) => target), [hostTarget]);
    assert.equal(installed.hostNativeEntry.target, hostTarget);
    assert.equal(isPathInside(installed.installRoot, path.resolve(import.meta.dirname, "../..")), false);
  });
});
