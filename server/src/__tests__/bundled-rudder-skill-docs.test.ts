import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled rudder skill docs", () => {
  it("do not teach Library entry display metadata in mention URLs", async () => {
    const docs = [
      "server/resources/bundled-skills/rudder/SKILL.md",
      "server/resources/bundled-skills/rudder/references/api-reference.md",
      "server/resources/bundled-skills/rudder/references/cli-reference.md",
    ];
    const legacyLibraryEntryMetadataPattern = /library-entry:\/\/[^\s)`\]]+\?(?=[^)\]`\s]*(?:t|p)=)/;

    for (const doc of docs) {
      const contents = await fs.readFile(path.join(process.cwd(), doc), "utf8");
      expect(contents, doc).not.toMatch(legacyLibraryEntryMetadataPattern);
    }
  });
});
