import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("@rudderhq/identity-core package manifest", () => {
  it("keeps workspace source imports separate from compiled Electron imports", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: {
        "."?: string;
        "./electron"?: {
          default?: string;
          types?: string;
        };
      };
      publishConfig?: {
        exports?: Record<string, unknown>;
      };
    };

    expect(manifest.exports?.["."]).toBe("./src/index.ts");
    expect(manifest.exports?.["./electron"]).toEqual({
      types: "./src/index.ts",
      default: "./dist/index.js",
    });
    expect(manifest.publishConfig?.exports?.["./electron"]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
  });
});
