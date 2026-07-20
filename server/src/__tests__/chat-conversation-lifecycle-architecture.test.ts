import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_SRC = fileURLToPath(new URL("../", import.meta.url));
const APPROVED_WRITERS = new Set(["services/chats.ts", "services/side-chats.ts"]);

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productionTypeScriptFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts")
      ? [absolutePath]
      : [];
  });
}

describe("chat conversation lifecycle architecture", () => {
  it("prevents production services from bypassing approved atomic lifecycle writers", () => {
    const violations = productionTypeScriptFiles(SERVER_SRC).flatMap((absolutePath) => {
      const relativePath = path.relative(SERVER_SRC, absolutePath).split(path.sep).join("/");
      if (APPROVED_WRITERS.has(relativePath)) return [];
      const source = fs.readFileSync(absolutePath, "utf8");
      return [...source.matchAll(/\.insert\(\s*chatConversations\s*\)/g)].map((match) => ({
        file: relativePath,
        line: source.slice(0, match.index).split("\n").length,
      }));
    });
    expect(violations, "Route chat creation through createWithInitialMessage").toEqual([]);
  });
});
