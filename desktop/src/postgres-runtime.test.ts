import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_POSTGRES_RUNTIME_DIR,
  RUDDER_POSTGRES_BIN_DIR_ENV,
  desktopPostgresPlatformSegment,
  resolveDesktopPostgresBinDir,
  resolvePreferredDesktopPostgresBinDir,
} from "./postgres-runtime.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-desktop-pg-runtime-"));
  tempRoots.push(root);
  return root;
}

async function makePostgresBinDir(root: string, segment = desktopPostgresPlatformSegment()): Promise<string> {
  const binDir = path.join(root, DESKTOP_POSTGRES_RUNTIME_DIR, segment, "bin");
  await mkdir(binDir, { recursive: true });
  const platform = segment.split("-")[0] as NodeJS.Platform;
  for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    await writeFile(path.join(binDir, platform === "win32" ? `${binary}.exe` : binary), "");
  }
  return binDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop PostgreSQL runtime payload", () => {
  it("uses platform and architecture in the payload path", () => {
    expect(desktopPostgresPlatformSegment("win32", "x64")).toBe("win32-x64");
    expect(desktopPostgresPlatformSegment("darwin", "arm64")).toBe("darwin-arm64");
  });

  it("resolves a bundled PostgreSQL 18.4 bin directory", async () => {
    const root = await makeTempRoot();
    const binDir = await makePostgresBinDir(root, "win32-x64");

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBe(binDir);
  });

  it("ignores incomplete PostgreSQL payload directories", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, DESKTOP_POSTGRES_RUNTIME_DIR, "win32-x64", "bin");
    await mkdir(binDir, { recursive: true });

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBeNull();
  });

  it("prefers external runtime cache payloads over bundled resources", async () => {
    const resourcesRoot = await makeTempRoot();
    const cacheRoot = await makeTempRoot();
    await makePostgresBinDir(resourcesRoot, "win32-x64");
    const cachedBinDir = await makePostgresBinDir(cacheRoot, "win32-x64");

    expect(
      resolvePreferredDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        externalRuntimeCacheDir: cacheRoot,
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBe(cachedBinDir);
  });

  it("does not override an explicit operator PostgreSQL bin directory", async () => {
    const resourcesRoot = await makeTempRoot();
    await makePostgresBinDir(resourcesRoot, "win32-x64");

    expect(
      resolvePreferredDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        env: { [RUDDER_POSTGRES_BIN_DIR_ENV]: "C:\\PostgreSQL\\18\\bin" },
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBeNull();
  });

  it("does not select a payload for the development shell", async () => {
    const resourcesRoot = await makeTempRoot();
    await makePostgresBinDir(resourcesRoot, "win32-x64");

    expect(
      resolvePreferredDesktopPostgresBinDir({
        isPackaged: false,
        resourcesPath: resourcesRoot,
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBeNull();
  });
});
