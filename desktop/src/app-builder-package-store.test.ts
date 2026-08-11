import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_BUILDER_INHERITED_ENV_NAMES,
  appBuilderInstallArgsForState,
  appBuilderNodeShimName,
  createAppBuilderInheritedEnvironment,
  createAppBuilderInstallPlan,
  WINDOWS_APP_BUILDER_DEPENDENCY_PATH_BUDGET,
  WINDOWS_APP_BUILDER_EXECUTABLE_PATH_LIMIT,
  WINDOWS_APP_BUILDER_PNPM_SEGMENT_LIMIT,
  WINDOWS_APP_BUILDER_PNPM_VERSION,
  WINDOWS_APP_BUILDER_VIRTUAL_STORE_LIMIT,
} from "./app-builder-package-store.mjs";

const desktopPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { dependencies?: { pnpm?: string } };

describe("App Builder package-store policy", () => {
  it("keeps non-Windows installs inside the app's ordinary pnpm layout", () => {
    expect(createAppBuilderInstallPlan({
      appRoot: "/Users/example/Documents/Rudder/demo/apps/crm",
      environment: {},
      platform: "darwin",
      temporaryDirectory: "/tmp",
    })).toEqual({
      args: ["install", "--frozen-lockfile", "--prefer-offline"],
      cacheRoot: null,
      contentStoreDir: null,
      layoutMarkerPath: null,
      virtualStoreDir: null,
    });
    expect(appBuilderNodeShimName("linux")).toBe("node");
  });

  it("requires an explicit Windows path-budget review when managed pnpm changes", () => {
    expect(desktopPackage.dependencies?.pnpm).toBe(WINDOWS_APP_BUILDER_PNPM_VERSION);
  });

  it("copies only managed App Builder settings and always enables Electron Node mode", () => {
    expect(createAppBuilderInheritedEnvironment({
      ELECTRON_RUN_AS_NODE: "0",
      LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
      RUDDER_APP_BUILDER_CACHE_DIR: "D:\\RudderCache",
      RUDDER_APP_BUILDER_REGISTRY: "https://registry.example.test/",
      RUDDER_UNRELATED_SECRET: "do-not-copy",
    })).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
      RUDDER_APP_BUILDER_CACHE_DIR: "D:\\RudderCache",
      RUDDER_APP_BUILDER_REGISTRY: "https://registry.example.test/",
    });
  });

  it("moves the complete Windows pnpm layout outside a deeply nested app root", () => {
    const appRoot = [
      "D:\\a\\rudder\\rudder\\App Builder verification workspace",
      "rudder-home\\instances\\default\\organizations\\eb5da0ea9e55",
      "workspaces\\apps\\desktop-app-builder-crm",
    ].join("\\");
    const plan = createAppBuilderInstallPlan({
      appRoot,
      environment: { LOCALAPPDATA: "C:\\Users\\runneradmin\\AppData\\Local" },
      platform: "win32",
      temporaryDirectory: "C:\\Users\\runneradmin\\AppData\\Local\\Temp",
    });

    expect(plan.cacheRoot).toBe("C:\\Users\\runneradmin\\AppData\\Local\\Rudder\\ab");
    expect(plan.contentStoreDir).toBe(`${plan.cacheRoot}\\s`);
    expect(plan.layoutMarkerPath).toMatch(
      /^C:\\Users\\runneradmin\\AppData\\Local\\Rudder\\ab\\state\\v1\\[a-f0-9]{16}\.ready$/,
    );
    expect(plan.virtualStoreDir).toMatch(
      /^C:\\Users\\runneradmin\\AppData\\Local\\Rudder\\ab\\v1\\[a-f0-9]{16}$/,
    );
    expect(plan.virtualStoreDir).not.toContain("desktop-app-builder-crm");
    expect(plan.args).toEqual([
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--virtual-store-dir",
      plan.virtualStoreDir,
      "--store-dir",
      plan.contentStoreDir,
    ]);
    expect(
      plan.virtualStoreDir!.length + WINDOWS_APP_BUILDER_DEPENDENCY_PATH_BUDGET,
    ).toBeLessThanOrEqual(WINDOWS_APP_BUILDER_EXECUTABLE_PATH_LIMIT);
    expect(path.win32.isAbsolute(plan.virtualStoreDir!)).toBe(true);
    expect(appBuilderNodeShimName("win32")).toBe("node.cmd");
    expect(APP_BUILDER_INHERITED_ENV_NAMES).toEqual([
      "ELECTRON_RUN_AS_NODE",
      "LOCALAPPDATA",
      "RUDDER_APP_BUILDER_CACHE_DIR",
      "RUDDER_APP_BUILDER_REGISTRY",
    ]);

    const longestCurrentEsbuildExecutable = path.win32.join(
      "x".repeat(WINDOWS_APP_BUILDER_PNPM_SEGMENT_LIMIT),
      "node_modules",
      "@esbuild",
      "win32-arm64",
      "esbuild.exe",
    );
    expect(
      WINDOWS_APP_BUILDER_VIRTUAL_STORE_LIMIT
        + 1
        + longestCurrentEsbuildExecutable.length,
    ).toBeLessThanOrEqual(WINDOWS_APP_BUILDER_EXECUTABLE_PATH_LIMIT);
  });

  it("forces a stale modules relink even when an interrupted v1 store already exists", () => {
    const plan = createAppBuilderInstallPlan({
      appRoot: "C:\\Users\\operator\\Documents\\Rudder\\demo\\apps\\crm",
      environment: { LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" },
      platform: "win32",
      temporaryDirectory: "C:\\Temp",
    });
    expect(appBuilderInstallArgsForState(plan, {
      nodeModulesPresent: true,
      layoutReady: false,
    })).toEqual([...plan.args, "--force"]);
    expect(appBuilderInstallArgsForState(plan, {
      nodeModulesPresent: true,
      layoutReady: true,
    })).toEqual(plan.args);
    expect(appBuilderInstallArgsForState(plan, {
      nodeModulesPresent: false,
      layoutReady: false,
    })).toEqual(plan.args);
  });

  it("uses one stable per-app virtual store identity across Windows path spelling", () => {
    const options = {
      environment: { LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" },
      platform: "win32",
      temporaryDirectory: "C:\\Temp",
    } as const;
    const first = createAppBuilderInstallPlan({
      ...options,
      appRoot: "C:\\Users\\operator\\Documents\\Rudder\\Demo\\apps\\crm",
    });
    const second = createAppBuilderInstallPlan({
      ...options,
      appRoot: "c:/users/operator/documents/rudder/demo/apps/crm",
    });
    expect(first.virtualStoreDir).toBe(second.virtualStoreDir);
    expect(first.contentStoreDir).toBe(second.contentStoreDir);
  });

  it("keeps a UNC App source on a short drive-letter package cache", () => {
    const plan = createAppBuilderInstallPlan({
      appRoot: "\\\\server\\RudderApps\\organization\\apps\\crm",
      environment: { LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local" },
      platform: "win32",
      temporaryDirectory: "C:\\Temp",
    });
    expect(plan.cacheRoot).toBe("C:\\Users\\operator\\AppData\\Local\\Rudder\\ab");
    expect(plan.virtualStoreDir).toMatch(/^[A-Za-z]:\\/);
    expect(plan.virtualStoreDir).not.toContain("server");
  });

  it("falls back to temp, accepts drive letters, and rejects UNC cache overrides", () => {
    const longLocalAppData = `C:\\${"enterprise-profile\\".repeat(9)}AppData\\Local`;
    const fallback = createAppBuilderInstallPlan({
      appRoot: "C:\\Users\\operator\\Documents\\Rudder\\demo\\apps\\crm",
      environment: { LOCALAPPDATA: longLocalAppData },
      platform: "win32",
      temporaryDirectory: "D:\\Temp",
    });
    expect(fallback.cacheRoot).toBe("D:\\Temp\\Rudder\\ab");

    const mappedDrive = createAppBuilderInstallPlan({
      appRoot: "C:\\Users\\operator\\Documents\\Rudder\\demo\\apps\\crm",
      environment: { RUDDER_APP_BUILDER_CACHE_DIR: "Z:\\RudderCache" },
      platform: "win32",
      temporaryDirectory: "D:\\Temp",
    });
    expect(mappedDrive.cacheRoot).toBe("Z:\\RudderCache");

    expect(() => createAppBuilderInstallPlan({
      appRoot: "C:\\Users\\operator\\Documents\\Rudder\\demo\\apps\\crm",
      environment: { RUDDER_APP_BUILDER_CACHE_DIR: "\\\\server\\share\\rudder" },
      platform: "win32",
      temporaryDirectory: "D:\\Temp",
    })).toThrow("drive-letter path");
  });

  it("fails with recovery guidance when no Windows cache root meets the budget", () => {
    const longRoot = `C:\\${"nested-directory\\".repeat(10)}cache`;
    expect(() => createAppBuilderInstallPlan({
      appRoot: "C:\\Users\\operator\\Documents\\Rudder\\demo\\apps\\crm",
      environment: { LOCALAPPDATA: longRoot },
      platform: "win32",
      temporaryDirectory: longRoot,
    })).toThrow("RUDDER_APP_BUILDER_CACHE_DIR");
  });
});
