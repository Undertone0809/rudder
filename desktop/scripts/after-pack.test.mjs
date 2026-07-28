import {
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

describe("Desktop afterPack server manifest normalization", () => {
  it("does not restore declarations removed from the production server package", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "rudder-after-pack-"));
    tempRoots.push(projectDir);
    const packageDir = path.join(
      projectDir,
      ".packaged",
      "server-package",
      "node_modules",
      "@rudderhq",
      "shared",
    );
    mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({
      name: "@rudderhq/shared",
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
      "@rudderhq",
      "shared",
      "package.json",
    ), "utf8"));
    expect(manifest.types).toBeUndefined();
    expect(manifest.exports["."].types).toBeUndefined();
    expect(manifest.exports["."].import).toBe("./dist/index.js");
    expect(manifest.exports["."].default).toBe("./dist/index.js");
  });
});
