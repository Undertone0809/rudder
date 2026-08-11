import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import afterPack from "./after-pack.mjs";

const tempRoots = [];

function stageDarwinComputerUseDependencies(projectDir) {
  for (const packageName of ["@rudderhq/shared", "zod"]) {
    const packageDir = path.join(
      projectDir,
      ".packaged",
      "app",
      "node_modules",
      ...packageName.split("/"),
    );
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({
      name: packageName,
      version: "1.0.0",
    }, null, 2)}\n`);
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Desktop afterPack internal package manifest normalization", () => {
  it("skips platform-filtered optional dependency placeholders", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "rudder-after-pack-"));
    tempRoots.push(projectDir);
    const appOutDir = path.join(projectDir, "release", "win-unpacked");
    const packagedNodeModules = path.join(appOutDir, "resources", "app", "node_modules");
    const driverDir = path.join(packagedNodeModules, "@trycua", "cua-driver");
    const installedSourceDir = path.join(
      projectDir,
      "node_modules",
      "@trycua",
      "cua-driver-win32-x64-msvc",
    );
    const filteredSourceDir = path.join(
      projectDir,
      "node_modules",
      "@trycua",
      "cua-driver-darwin-arm64",
    );

    mkdirSync(driverDir, { recursive: true });
    writeFileSync(path.join(driverDir, "package.json"), `${JSON.stringify({
      name: "@trycua/cua-driver",
      optionalDependencies: {
        "@trycua/cua-driver-darwin-arm64": "0.19.2",
        "@trycua/cua-driver-win32-x64-msvc": "0.19.2",
      },
    })}\n`);
    mkdirSync(installedSourceDir, { recursive: true });
    writeFileSync(path.join(installedSourceDir, "package.json"), `${JSON.stringify({
      name: "@trycua/cua-driver-win32-x64-msvc",
      version: "0.19.2",
    })}\n`);
    mkdirSync(filteredSourceDir, { recursive: true });

    await afterPack({
      appDir: projectDir,
      electronPlatformName: "win32",
      appOutDir,
      packager: { projectDir },
    });

    expect(readFileSync(path.join(
      packagedNodeModules,
      "@trycua",
      "cua-driver-win32-x64-msvc",
      "package.json",
    ), "utf8")).toContain("cua-driver-win32-x64-msvc");
    expect(() => readFileSync(path.join(
      packagedNodeModules,
      "@trycua",
      "cua-driver-darwin-arm64",
      "package.json",
    ), "utf8")).toThrow();
  });

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

      if (electronPlatformName === "darwin") {
        stageDarwinComputerUseDependencies(projectDir);
      }

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
    stageDarwinComputerUseDependencies(projectDir);
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

describe("Desktop afterPack optional dependencies", () => {
  it("skips dangling pnpm links for optional packages unavailable on the target platform", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "rudder-after-pack-"));
    tempRoots.push(projectDir);
    const appOutDir = path.join(projectDir, "release", "win-unpacked");
    const packagedNodeModules = path.join(appOutDir, "resources", "app", "node_modules");
    const driverDir = path.join(packagedNodeModules, "@vendor", "driver");
    mkdirSync(driverDir, { recursive: true });
    writeFileSync(path.join(driverDir, "package.json"), `${JSON.stringify({
      name: "@vendor/driver",
      version: "1.0.0",
      optionalDependencies: {
        "@vendor/available-native": "1.0.0",
        "@vendor/missing-native": "1.0.0",
      },
    }, null, 2)}\n`);

    const availableDir = path.join(projectDir, "node_modules", "@vendor", "available-native");
    mkdirSync(availableDir, { recursive: true });
    writeFileSync(path.join(availableDir, "package.json"), `${JSON.stringify({
      name: "@vendor/available-native",
      version: "1.0.0",
    }, null, 2)}\n`);

    const virtualDependencyRoot = path.join(
      projectDir,
      "node_modules",
      ".pnpm",
      "driver@1.0.0",
      "node_modules",
      "@vendor",
    );
    mkdirSync(virtualDependencyRoot, { recursive: true });
    symlinkSync(
      path.join(projectDir, "node_modules", ".pnpm", "missing-native@1.0.0"),
      path.join(virtualDependencyRoot, "missing-native"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await afterPack({
      appDir: projectDir,
      electronPlatformName: "win32",
      appOutDir,
      packager: { projectDir },
    });

    expect(JSON.parse(readFileSync(path.join(
      packagedNodeModules,
      "@vendor",
      "available-native",
      "package.json",
    ), "utf8"))).toMatchObject({ name: "@vendor/available-native" });
    expect(() => readFileSync(path.join(
      packagedNodeModules,
      "@vendor",
      "missing-native",
      "package.json",
    ), "utf8")).toThrow();
  });
});
