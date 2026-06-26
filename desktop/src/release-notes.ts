import fs from "node:fs";
import path from "node:path";

export type DesktopReleaseNotes = {
  version: string;
  title: string;
  sections: Array<{
    title: string;
    items: string[];
  }>;
};

type ReleaseNotesState = {
  lastShownVersion?: string;
};

function normalizeVersion(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function resolveReleaseNotesPath(input: {
  moduleDir: string;
  packaged: boolean;
  version: string;
}): string {
  const normalizedVersion = normalizeVersion(input.version);
  const releaseFileName = `v${normalizedVersion}.md`;
  const releaseRoot = input.packaged
    ? path.resolve(input.moduleDir, "..", "releases")
    : path.resolve(input.moduleDir, "..", "..", "releases");
  return path.join(releaseRoot, releaseFileName);
}

export function parseReleaseNotesMarkdown(version: string, markdown: string): DesktopReleaseNotes | null {
  const sections: DesktopReleaseNotes["sections"] = [];
  let current: DesktopReleaseNotes["sections"][number] | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], items: [] };
      sections.push(current);
      continue;
    }

    const item = /^-\s+(.+?)\s*$/.exec(line);
    if (item && current) {
      current.items.push(item[1]);
      continue;
    }

    if (current && current.items.length > 0 && line.trim().length > 0) {
      current.items[current.items.length - 1] += ` ${line.trim()}`;
    }
  }

  const nonEmptySections = sections
    .map((section) => ({
      ...section,
      items: section.items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean),
    }))
    .filter((section) => section.items.length > 0);

  if (nonEmptySections.length === 0) return null;

  return {
    version: normalizeVersion(version),
    title: `What's new in Rudder ${normalizeVersion(version)}`,
    sections: nonEmptySections,
  };
}

export function readReleaseNotes(input: {
  releaseNotesPath: string;
  version: string;
}): DesktopReleaseNotes | null {
  try {
    return parseReleaseNotesMarkdown(input.version, fs.readFileSync(input.releaseNotesPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export function resolveReleaseNotesStatePath(userDataPath: string): string {
  return path.join(userDataPath, "release-notes-state.json");
}

export function shouldShowReleaseNotes(input: {
  statePath: string;
  version: string;
}): boolean {
  const normalizedVersion = normalizeVersion(input.version);
  try {
    const state = JSON.parse(fs.readFileSync(input.statePath, "utf8")) as ReleaseNotesState;
    return state.lastShownVersion !== normalizedVersion;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return true;
    return true;
  }
}

export function markReleaseNotesShown(input: {
  statePath: string;
  version: string;
}): void {
  const normalizedVersion = normalizeVersion(input.version);
  fs.mkdirSync(path.dirname(input.statePath), { recursive: true });
  fs.writeFileSync(input.statePath, `${JSON.stringify({ lastShownVersion: normalizedVersion }, null, 2)}\n`, "utf8");
}
