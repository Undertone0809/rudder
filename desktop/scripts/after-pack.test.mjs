import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import afterPack from "./after-pack.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Desktop afterPack internal package manifest normalization", () => {
  it.each(["darwin", "linux", "win32"])(
    "copies staged Computer Use dependencies into the %s application",
    async (electronPlatformName) => {
      const projectDir = mkdtempSync(path.join(tmpdir(), "rudder-after-pack-computer-use-"));
      tempRoots.push(projectDir);
      const appOutDir = path.join(projectDir, "release", "unpacked");
      const resourcesDir = electronPlatformName === "darwin"
        ? path.join(appOutDir, "Rudder.app", "Contents", "Resources")
        : path.join(appOutDir, "resources");
      const stagedPackageDir = path.join(
        projectDir,
        ".packaged",
        "app",
        "node_modules",
        "@trycua",
        "cua-driver",
      );
      mkdirSync(stagedPackageDir, { recursive: true });
      writeFileSync(path.join(stagedPackageDir, "package.json"), `${JSON.stringify({
        name: "@trycua/cua-driver",
        version: "0.19.2",
      })}\n`);
      writeFileSync(path.join(stagedPackageDir, "runtime-marker"), "staged\n");

      await afterPack({
        appDir: projectDir,
        electronPlatformName,
        appOutDir,
        packager: { projectDir },
      });

      expect(readFileSync(path.join(
        resourcesDir,
        "app",
        "node_modules",
        "@trycua",
        "cua-driver",
        "runtime-marker",
      ), "utf8")).toBe("staged\n");
    },
  );

  it.each([
    { electronPlatformName: "darwin", packageScope: "@rudderhq" },
    { electronPlatformName: "darwin", packageScope: "@rudder" },
    { electronPlatformName: "linux", packageScope: "@rudderhq" },
  ])(
    "uses compiled exports for $electronPlatformName app dependencies in the $packageScope scope",
    async ({ electronPlatformName, packageScope }) => {
      const projectDir = mkdtempSync(path.join(tmpdir(), "rudder-after-pack-"));
      tempRoots.push(projectDir);
      const appOutDir = path.join(projectDir, "release", "unpacked");
      const resourcesDir = electronPlatformName === "darwin"
        ? path.join(appOutDir, "Rudder.app", "Contents", "Resources")
        : path.join(appOutDir, "resources");
      const packageDir = path.join(
        resourcesDir,
        "app",
        "node_modules",
        packageScope,
        "identity-core",
      );
      mkdirSync(path.join(packageDir, "dist"), { recursive: true });
      writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n");
      const sourceManifestPath = path.join(projectDir, "workspace-package.json");
      writeFileSync(sourceManifestPath, `${JSON.stringify({
        name: `${packageScope}/identity-core`,
        version: "1.0.0",
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
      }, null, 2)}\n`);
      linkSync(sourceManifestPath, path.join(packageDir, "package.json"));

      await afterPack({
        appDir: projectDir,
        electronPlatformName,
        appOutDir,
        packager: { projectDir },
      });

      const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
      expect(manifest.main).toBe("./dist/index.js");
      expect(manifest.types).toBe("./dist/index.d.ts");
      expect(manifest.exports["."].import).toBe("./dist/index.js");
      expect(manifest.exports["."].default).toBe("./dist/index.js");
      expect(JSON.parse(readFileSync(sourceManifestPath, "utf8")).exports["."])
        .toBe("./src/index.ts");
    },
  );

  it.each(["@rudderhq", "@rudder"])(
    "does not restore declarations removed from the production server package in the %s scope",
    async (packageScope) => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "rudder-after-pack-"));
    tempRoots.push(projectDir);
    const packageDir = path.join(
      projectDir,
      ".packaged",
      "server-package",
      "node_modules",
      packageScope,
      "shared",
    );
    mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({
      name: `${packageScope}/shared`,
      version: "1.0.0",
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
    }, null, 2)}\n`);

    const appOutDir = path.join(projectDir, "release", "mac-arm64");
    mkdirSync(path.join(appOutDir, "Rudder.app", "Contents", "Resources"), { recursive: true });
    await afterPack({
      appDir: projectDir,
      electronPlatformName: "darwin",
      appOutDir,
      packager: { projectDir },
    });

    const manifest = JSON.parse(readFileSync(path.join(
      appOutDir,
      "Rudder.app",
      "Contents",
      "Resources",
      "server-package",
      "node_modules",
      packageScope,
      "shared",
      "package.json",
    ), "utf8"));
    expect(manifest.types).toBeUndefined();
    expect(manifest.exports["."].types).toBeUndefined();
    expect(manifest.exports["."].import).toBe("./dist/index.js");
    expect(manifest.exports["."].default).toBe("./dist/index.js");
    },
  );
});
