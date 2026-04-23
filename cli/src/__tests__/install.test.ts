import { describe, expect, it, vi } from "vitest";
import {
  CLI_NPM_PACKAGE_NAME,
  detectPersistentCliState,
  hasGlobalInstalledPackage,
  hasPersistentBinaryOnPath,
  installPersistentCli,
  isLikelyNpxExecutionContext,
  isTransientBinaryPath,
  resolvePersistentCliInstallSpec,
} from "../install.js";

describe("persistent CLI install helpers", () => {
  it("detects npx execution from transient _npx entry paths", () => {
    expect(
      isLikelyNpxExecutionContext("/tmp/npm-cache/_npx/abc/node_modules/@rudder/cli/dist/index.js", {}),
    ).toBe(true);
  });

  it("does not treat normal local development execution as npx", () => {
    expect(
      isLikelyNpxExecutionContext("/Users/test/projects/rudder/cli/src/index.ts", {
        npm_command: "run-script",
      }),
    ).toBe(false);
  });

  it("resolves the install spec to the current package version when available", () => {
    expect(
      resolvePersistentCliInstallSpec({
        npm_package_name: CLI_NPM_PACKAGE_NAME,
        npm_package_version: "2026.327.0-canary.2",
      }),
    ).toBe("@rudder/cli@2026.327.0-canary.2");
  });

  it("falls back to the package name when version metadata is missing", () => {
    expect(resolvePersistentCliInstallSpec({})).toBe(CLI_NPM_PACKAGE_NAME);
  });

  it("reads the global install state from npm list output", () => {
    const execFileSyncImpl = vi.fn(() =>
      JSON.stringify({
        dependencies: {
          "@rudder/cli": { version: "0.1.0" },
        },
      }),
    );

    expect(hasGlobalInstalledPackage(CLI_NPM_PACKAGE_NAME, execFileSyncImpl as never)).toBe(true);
  });

  it("detects a persistent rudder binary on PATH", () => {
    const execFileSyncImpl = vi.fn(() => "/usr/local/bin/rudder\n");
    expect(hasPersistentBinaryOnPath(execFileSyncImpl as never)).toBe(true);
  });

  it("ignores transient npx binaries on PATH", () => {
    const execFileSyncImpl = vi.fn(() => "/tmp/npm-cache/_npx/abc/bin/rudder\n");
    expect(hasPersistentBinaryOnPath(execFileSyncImpl as never)).toBe(false);
    expect(isTransientBinaryPath("/tmp/npm-cache/_npx/abc/bin/rudder")).toBe(true);
  });

  it("marks npx execution as already installed when the package is present globally", () => {
    const execFileSyncImpl = vi
      .fn()
      .mockReturnValueOnce(
        JSON.stringify({
          dependencies: {
            "@rudder/cli": { version: "0.1.0" },
          },
        }),
      );

    expect(
      detectPersistentCliState({
        entryPath: "/tmp/npm-cache/_npx/abc/node_modules/@rudder/cli/dist/index.js",
        env: {},
        execFileSyncImpl: execFileSyncImpl as never,
      }),
    ).toEqual({
      usingNpx: true,
      alreadyInstalled: true,
      installSpec: "@rudder/cli",
      installCommand: "npm install --global @rudder/cli",
    });
  });

  it("requires installation when launched from npx without a global package or persistent binary", () => {
    const execFileSyncImpl = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("missing");
      })
      .mockImplementationOnce(() => "/tmp/npm-cache/_npx/abc/bin/rudder\n");

    expect(
      detectPersistentCliState({
        entryPath: "/tmp/npm-cache/_npx/abc/node_modules/@rudder/cli/dist/index.js",
        env: {
          npm_package_name: "@rudder/cli",
          npm_package_version: "0.1.0",
        },
        execFileSyncImpl: execFileSyncImpl as never,
      }),
    ).toEqual({
      usingNpx: true,
      alreadyInstalled: false,
      installSpec: "@rudder/cli@0.1.0",
      installCommand: "npm install --global @rudder/cli@0.1.0",
    });
  });

  it("runs npm install --global for the resolved package spec", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: "added 1 package",
      stderr: "",
    }));

    expect(
      installPersistentCli({
        installSpec: "@rudder/cli@0.1.0",
        spawnSyncImpl: spawnSyncImpl as never,
      }),
    ).toEqual({
      ok: true,
      command: "npm install --global @rudder/cli@0.1.0",
      output: "added 1 package",
    });

    expect(spawnSyncImpl).toHaveBeenCalledWith(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--global", "@rudder/cli@0.1.0"],
      {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
  });
});
