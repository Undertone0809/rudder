// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiSourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFilePattern = /\.(ts|tsx)$/;
const testFilePattern = /\.(test|spec)\.(ts|tsx)$/;
const nativeDialogPattern = /\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(|\b(?:alert|prompt)\s*\(/;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    if (!sourceFilePattern.test(entry.name) || testFilePattern.test(entry.name)) return [];
    return [path];
  });
}

describe("native browser dialogs", () => {
  it("are not used in production UI source", () => {
    const matches = listSourceFiles(uiSourceRoot)
      .map((filePath) => {
        const source = readFileSync(filePath, "utf8");
        return {
          filePath,
          lines: source
            .split("\n")
            .map((line, index) => ({ index: index + 1, line }))
            .filter(({ line }) => nativeDialogPattern.test(line)),
        };
      })
      .filter(({ lines }) => lines.length > 0)
      .flatMap(({ filePath, lines }) =>
        lines.map(({ index, line }) => `${relative(uiSourceRoot, filePath)}:${index}: ${line.trim()}`),
      );

    expect(matches).toEqual([]);
  });
});
