import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("@rudderhq/identity-core package manifest", () => {
  it("uses source types during development and compiled JavaScript at runtime", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: {
        "."?: {
          default?: string;
          types?: string;
        };
      };
    };

    expect(manifest.exports?.["."]).toEqual({
      types: "./src/index.ts",
      default: "./dist/index.js",
    });
  });
});
