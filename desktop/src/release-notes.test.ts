import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markReleaseNotesShown,
  parseReleaseNotesMarkdown,
  readReleaseNotes,
  resolveReleaseNotesPath,
  resolveReleaseNotesStatePath,
  shouldShowReleaseNotes,
} from "./release-notes.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("desktop release notes", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("parses categorized release notes from the stable changelog format", () => {
    const notes = parseReleaseNotesMarkdown("v0.4.0", [
      "## New Features",
      "",
      "- Added one thing",
      "  with wrapped detail.",
      "- Added another thing",
      "",
      "## Bug Fixes",
      "",
      "- Fixed startup.",
    ].join("\n"));

    expect(notes).toEqual({
      version: "0.4.0",
      title: "What's new in Rudder 0.4.0",
      sections: [
        {
          title: "New Features",
          items: [
            "Added one thing with wrapped detail.",
            "Added another thing",
          ],
        },
        {
          title: "Bug Fixes",
          items: ["Fixed startup."],
        },
      ],
    });
  });

  it("tracks whether the current version has already been shown", async () => {
    const root = await makeTempDir("rudder-release-notes-state-");
    cleanupDirs.add(root);
    const statePath = resolveReleaseNotesStatePath(root);

    expect(shouldShowReleaseNotes({ statePath, version: "0.4.0" })).toBe(true);
    markReleaseNotesShown({ statePath, version: "v0.4.0" });
    expect(shouldShowReleaseNotes({ statePath, version: "0.4.0" })).toBe(false);
    expect(shouldShowReleaseNotes({ statePath, version: "0.4.1" })).toBe(true);
  });

  it("resolves development and packaged release note paths", () => {
    expect(resolveReleaseNotesPath({
      moduleDir: "/repo/desktop/dist",
      packaged: false,
      version: "0.4.0",
    })).toBe(path.join("/repo", "releases", "v0.4.0.md"));
    expect(resolveReleaseNotesPath({
      moduleDir: "/Applications/Rudder.app/Contents/Resources/app/dist",
      packaged: true,
      version: "v0.4.0",
    })).toBe(path.join("/Applications/Rudder.app/Contents/Resources/app", "releases", "v0.4.0.md"));
  });

  it("returns null when the release note file is missing", async () => {
    const root = await makeTempDir("rudder-release-notes-missing-");
    cleanupDirs.add(root);

    expect(readReleaseNotes({
      version: "0.4.0",
      releaseNotesPath: path.join(root, "missing.md"),
    })).toBeNull();
  });
});
