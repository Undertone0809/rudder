import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { macPortableZipArgs } from "./archive.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "darwin")("macOS Desktop ZIP archive", () => {
  it("drops AppleDouble metadata while preserving executable modes and symlinks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rudder-desktop-archive-"));
    tempRoots.push(root);
    const appDir = path.join(root, "Rudder.app");
    const executablePath = path.join(appDir, "Contents", "MacOS", "Rudder");
    const resourcePath = path.join(appDir, "Contents", "Resources", "resource.txt");
    mkdirSync(path.dirname(executablePath), { recursive: true });
    mkdirSync(path.dirname(resourcePath), { recursive: true });
    writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
    chmodSync(executablePath, 0o755);
    writeFileSync(resourcePath, "runtime resource\n");
    symlinkSync("resource.txt", path.join(path.dirname(resourcePath), "resource-link"));

    const xattrResult = spawnSync("xattr", [
      "-w",
      "com.rudder.archive-test",
      "metadata that must not become AppleDouble",
      resourcePath,
    ], { encoding: "utf8" });
    expect(xattrResult.status, xattrResult.stderr).toBe(0);

    const archivePath = path.join(root, "Rudder.zip");
    const archiveResult = spawnSync("ditto", macPortableZipArgs(appDir, archivePath), {
      encoding: "utf8",
    });
    expect(archiveResult.status, archiveResult.stderr).toBe(0);

    const listResult = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
    expect(listResult.status, listResult.stderr).toBe(0);
    const entries = listResult.stdout.split(/\r?\n/).filter(Boolean);
    expect(entries.some((entry) => entry.startsWith("__MACOSX/"))).toBe(false);
    expect(entries.some((entry) => path.basename(entry).startsWith("._"))).toBe(false);

    const extractedRoot = path.join(root, "extracted");
    mkdirSync(extractedRoot, { recursive: true });
    const extractResult = spawnSync("ditto", ["-x", "-k", archivePath, extractedRoot], {
      encoding: "utf8",
    });
    expect(extractResult.status, extractResult.stderr).toBe(0);
    const extractedApp = path.join(extractedRoot, "Rudder.app");
    const extractedExecutable = path.join(extractedApp, "Contents", "MacOS", "Rudder");
    const extractedLink = path.join(extractedApp, "Contents", "Resources", "resource-link");
    expect(lstatSync(extractedExecutable).mode & 0o111).not.toBe(0);
    expect(lstatSync(extractedLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(extractedLink)).toBe("resource.txt");
    expect(readFileSync(extractedLink, "utf8")).toBe("runtime resource\n");
  });
});
