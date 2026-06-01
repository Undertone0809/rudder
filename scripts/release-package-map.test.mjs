import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const tempRoots = [];

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function createPackageMapRepo() {
  const repo = mkdtempSync(join(tmpdir(), "rudder-package-map-test-"));
  tempRoots.push(repo);

  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "packages", "shared"), { recursive: true });
  cpSync(join(scriptsDir, "release-package-map.mjs"), join(repo, "scripts", "release-package-map.mjs"));

  const packagePath = join(repo, "packages", "shared", "package.json");
  writeJson(packagePath, {
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
  });

  return { repo, packagePath };
}

function runPackageMap(repo, args) {
  return spawnSync("node", ["scripts/release-package-map.mjs", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("release package map", () => {
  it("refuses publish manifest rewrites unless release automation opts in", () => {
    const { repo, packagePath } = createPackageMapRepo();
    const before = readFileSync(packagePath, "utf8");

    const result = runPackageMap(repo, ["set-publish-version", "0.2.11"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to rewrite source package manifests");
    expect(readFileSync(packagePath, "utf8")).toBe(before);
  });

  it("rewrites publish manifests when source mutation is explicitly allowed", () => {
    const { repo, packagePath } = createPackageMapRepo();

    const result = runPackageMap(repo, ["set-publish-version", "0.2.11", "--allow-source-mutation"]);
    const manifest = readJson(packagePath);

    expect(result.status).toBe(0);
    expect(manifest.version).toBe("0.2.11");
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
  });
});
