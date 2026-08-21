import {
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
import { rewriteInternalPackageManifest } from "./normalize-internal-package-manifest.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rewriteInternalPackageManifest", () => {
  it("switches staged workspace packages to compiled exports without mutating the source", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "rudder-package-manifest-"));
    tempRoots.push(projectDir);
    const sourceManifestPath = path.join(projectDir, "workspace-package.json");
    const stagedPackageDir = path.join(projectDir, "staged", "@rudderhq", "shared");
    mkdirSync(path.join(stagedPackageDir, "dist"), { recursive: true });
    writeFileSync(path.join(stagedPackageDir, "dist", "index.js"), "export {};\n");
    writeFileSync(sourceManifestPath, `${JSON.stringify({
      name: "@rudderhq/shared",
      version: "0.7.12",
      exports: { ".": "./src/index.ts" },
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
    symlinkSync(sourceManifestPath, path.join(stagedPackageDir, "package.json"));

    await rewriteInternalPackageManifest(stagedPackageDir);

    const stagedManifest = JSON.parse(readFileSync(path.join(stagedPackageDir, "package.json"), "utf8"));
    expect(stagedManifest.main).toBe("./dist/index.js");
    expect(stagedManifest.types).toBe("./dist/index.d.ts");
    expect(stagedManifest.exports["."].import).toBe("./dist/index.js");
    expect(stagedManifest.exports["."].default).toBe("./dist/index.js");
    expect(JSON.parse(readFileSync(sourceManifestPath, "utf8")).exports["."]).toBe("./src/index.ts");
  });
});
