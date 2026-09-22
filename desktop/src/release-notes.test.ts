import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReleaseNotesReservation,
  markReleaseNotesShown,
  parseReleaseNotesMarkdown,
  readReleaseNotes,
  readReleaseNotesBundle,
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

  it("retains reserved notes across renderer reloads until acknowledgement", () => {
    const reservation = createReleaseNotesReservation();
    const notes = {
      version: "0.4.0",
      title: "What's new in Rudder 0.4.0",
      sections: [{ title: "Bug Fixes", items: ["Fixed startup."] }],
    };

    expect(reservation.get("0.4.0")).toBeNull();
    reservation.reserve(notes);
    expect(reservation.get("v0.4.0")).toEqual(notes);

    reservation.clear();
    expect(reservation.get("0.4.0")).toBeNull();
  });

  it("does not show release notes on first launch but records the baseline version", async () => {
    const root = await makeTempDir("rudder-release-notes-state-");
    cleanupDirs.add(root);
    const statePath = resolveReleaseNotesStatePath(root);

    expect(shouldShowReleaseNotes({ statePath, version: "0.4.0" })).toBe(false);
    expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toEqual({ lastKnownVersion: "0.4.0" });
  });

  it("shows release notes after an app update even when no prior release-note state exists", async () => {
    const root = await makeTempDir("rudder-release-notes-state-");
    cleanupDirs.add(root);
    const statePath = resolveReleaseNotesStatePath(root);

    expect(shouldShowReleaseNotes({ statePath, version: "0.4.0", updatedAfterInstall: true })).toBe(true);
  });

  it("tracks whether release notes should show after an update", async () => {
    const root = await makeTempDir("rudder-release-notes-state-");
    cleanupDirs.add(root);
    const statePath = resolveReleaseNotesStatePath(root);

    markReleaseNotesShown({ statePath, version: "v0.4.0" });
    expect(shouldShowReleaseNotes({ statePath, version: "0.4.0" })).toBe(false);
    expect(shouldShowReleaseNotes({ statePath, version: "0.4.1" })).toBe(true);
  });

  it("keeps compatibility with release note state written before lastKnownVersion", async () => {
    const root = await makeTempDir("rudder-release-notes-state-");
    cleanupDirs.add(root);
    const statePath = resolveReleaseNotesStatePath(root);
    await fs.writeFile(statePath, `${JSON.stringify({ lastShownVersion: "0.4.0" }, null, 2)}\n`, "utf8");

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
    expect(resolveReleaseNotesPath({
      moduleDir: "/Applications/Rudder.app/Contents/Resources/app/dist",
      packaged: true,
      version: "v0.4.0",
      locale: "zh-CN",
    })).toBe(path.join("/Applications/Rudder.app/Contents/Resources/app", "releases", "zh", "v0.4.0.md"));
  });

  it("bundles the Chinese release notes alongside the English source", async () => {
    const root = await makeTempDir("rudder-release-notes-locales-");
    cleanupDirs.add(root);
    const englishPath = path.join(root, "v0.7.23.md");
    const chinesePath = path.join(root, "zh", "v0.7.23.md");
    await fs.mkdir(path.dirname(chinesePath), { recursive: true });
    await fs.writeFile(englishPath, [
      "A user-facing summary.",
      "",
      "## Improved",
      "",
      "- Improved one thing.",
    ].join("\n"), "utf8");
    await fs.writeFile(chinesePath, [
      "面向用户的版本摘要。",
      "",
      "## 改进",
      "",
      "- 改进了一项功能。",
    ].join("\n"), "utf8");

    expect(readReleaseNotesBundle({
      version: "0.7.23",
      releaseNotesPath: englishPath,
      localizedReleaseNotesPaths: { "zh-CN": chinesePath },
    })).toEqual({
      version: "0.7.23",
      title: "What's new in Rudder 0.7.23",
      sections: [{ title: "Improved", items: ["Improved one thing."] }],
      translations: {
        "zh-CN": {
          version: "0.7.23",
          title: "Rudder 0.7.23 更新内容",
          sections: [{ title: "改进", items: ["改进了一项功能。"] }],
        },
      },
    });
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
