import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCliVersion } from "../version.js";

function writePackageJson(dir: string, version: string) {
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "@rudderhq/cli", version }, null, 2)}\n`,
    "utf8",
  );
}

function writeNamedPackageJson(dir: string, fileName: string, name: string, version: string) {
  writeFileSync(
    path.join(dir, fileName),
    `${JSON.stringify({ name, version }, null, 2)}\n`,
    "utf8",
  );
}

describe("resolveCliVersion", () => {
  it("uses npm package environment when npm provides it", () => {
    expect(resolveCliVersion(import.meta.url, {
      npm_package_name: "@rudderhq/cli",
      npm_package_version: "0.1.0-canary.42",
    })).toBe("0.1.0-canary.42");
  });

  it("reads the npm CLI package manifest from a bundled dist file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rudder-cli-version-"));
    mkdirSync(path.join(root, "dist"));
    writePackageJson(root, "0.1.0-canary.7");

    const moduleUrl = pathToFileURL(path.join(root, "dist", "index.js")).href;

    expect(resolveCliVersion(moduleUrl, {})).toBe("0.1.0-canary.7");
  });

  it("reads the staged desktop CLI manifest next to the bundled file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rudder-desktop-cli-version-"));
    writeNamedPackageJson(root, "package.json", "@rudderhq/server", "0.1.0");
    writeNamedPackageJson(root, "rudder-cli-package.json", "@rudderhq/cli", "0.2.0");

    const moduleUrl = pathToFileURL(path.join(root, "desktop-cli.js")).href;

    expect(resolveCliVersion(moduleUrl, {})).toBe("0.2.0");
  });
});
