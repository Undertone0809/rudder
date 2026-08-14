import { describe, expect, it } from "vitest";
import { extractNpmPackFilename } from "./parse-npm-pack-output.mjs";

describe("npm pack output parser", () => {
  it("extracts the payload after lifecycle logs", () => {
    const output = [
      "> @rudderhq/server@0.7.7 prepack",
      "> pnpm run prepare:ui-dist",
      "Found 3 warnings while optimizing generated CSS:",
      '[{"id":"@rudderhq/server@0.7.7","filename":"rudderhq-server-0.7.7.tgz"}]',
      "> @rudderhq/server@0.7.7 postpack",
    ].join("\n");

    expect(extractNpmPackFilename(output)).toBe("rudderhq-server-0.7.7.tgz");
  });

  it("rejects output without a pack payload", () => {
    expect(() => extractNpmPackFilename("npm ERR! pack failed")).toThrow(
      "npm pack output did not contain a JSON payload with a filename",
    );
  });
});
