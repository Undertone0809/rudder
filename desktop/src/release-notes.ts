import fs from "node:fs";
import path from "node:path";

export type DesktopReleaseNotesLocale = "zh-CN";

export type DesktopReleaseNotesContent = {
  version: string;
  title: string;
  sections: Array<{
    title: string;
    items: string[];
  }>;
};

export type DesktopReleaseNotes = DesktopReleaseNotesContent & {
  translations?: Partial<Record<DesktopReleaseNotesLocale, DesktopReleaseNotesContent>>;
};

export function createReleaseNotesReservation(): {
  get(version: string): DesktopReleaseNotes | null;
  reserve(notes: DesktopReleaseNotes): void;
  clear(): void;
} {
  let reservedNotes: DesktopReleaseNotes | null = null;

  return {
    get(version) {
      return reservedNotes?.version === normalizeVersion(version) ? reservedNotes : null;
    },
    reserve(notes) {
      reservedNotes = notes;
    },
    clear() {
      reservedNotes = null;
    },
  };
}

type ReleaseNotesState = {
  lastKnownVersion?: string;
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
  locale?: "en" | DesktopReleaseNotesLocale;
}): string {
  const normalizedVersion = normalizeVersion(input.version);
  const releaseFileName = `v${normalizedVersion}.md`;
  const releaseRoot = input.packaged
    ? path.resolve(input.moduleDir, "..", "releases")
    : path.resolve(input.moduleDir, "..", "..", "releases");
  const localeDirectory = input.locale === "zh-CN" ? "zh" : undefined;
  return path.join(releaseRoot, ...(localeDirectory ? [localeDirectory] : []), releaseFileName);
}

export function parseReleaseNotesMarkdown(
  version: string,
  markdown: string,
  locale: "en" | DesktopReleaseNotesLocale = "en",
): DesktopReleaseNotesContent | null {
  const sections: DesktopReleaseNotesContent["sections"] = [];
  let current: DesktopReleaseNotesContent["sections"][number] | null = null;

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
    title: locale === "zh-CN"
      ? `Rudder ${normalizeVersion(version)} 更新内容`
      : `What's new in Rudder ${normalizeVersion(version)}`,
    sections: nonEmptySections,
  };
}

export function readReleaseNotes(input: {
  releaseNotesPath: string;
  version: string;
  locale?: "en" | DesktopReleaseNotesLocale;
}): DesktopReleaseNotesContent | null {
  try {
    return parseReleaseNotesMarkdown(
      input.version,
      fs.readFileSync(input.releaseNotesPath, "utf8"),
      input.locale,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export function readReleaseNotesBundle(input: {
  releaseNotesPath: string;
  version: string;
  localizedReleaseNotesPaths?: Partial<Record<DesktopReleaseNotesLocale, string>>;
}): DesktopReleaseNotes | null {
  const notes = readReleaseNotes({
    releaseNotesPath: input.releaseNotesPath,
    version: input.version,
  });
  if (!notes) return null;

  const translations = Object.entries(input.localizedReleaseNotesPaths ?? {}).reduce<
    Partial<Record<DesktopReleaseNotesLocale, DesktopReleaseNotesContent>>
  >((resolved, [locale, releaseNotesPath]) => {
    if (!releaseNotesPath) return resolved;
    const localizedNotes = readReleaseNotes({
      releaseNotesPath,
      version: input.version,
      locale: locale as DesktopReleaseNotesLocale,
    });
    if (localizedNotes) {
      resolved[locale as DesktopReleaseNotesLocale] = localizedNotes;
    }
    return resolved;
  }, {});

  return Object.keys(translations).length > 0 ? { ...notes, translations } : notes;
}

export function resolveReleaseNotesStatePath(userDataPath: string): string {
  return path.join(userDataPath, "release-notes-state.json");
}

export function shouldShowReleaseNotes(input: {
  statePath: string;
  updatedAfterInstall?: boolean;
  version: string;
}): boolean {
  const normalizedVersion = normalizeVersion(input.version);
  try {
    const state = JSON.parse(fs.readFileSync(input.statePath, "utf8")) as ReleaseNotesState;
    const knownVersion = state.lastKnownVersion ?? state.lastShownVersion;
    if (!knownVersion) {
      writeReleaseNotesState(input.statePath, { lastKnownVersion: normalizedVersion });
      return false;
    }

    return knownVersion !== normalizedVersion && state.lastShownVersion !== normalizedVersion;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      if (input.updatedAfterInstall) return true;
      writeReleaseNotesState(input.statePath, { lastKnownVersion: normalizedVersion });
      return false;
    }
    throw error;
  }
}

export function markReleaseNotesShown(input: {
  statePath: string;
  version: string;
}): void {
  const normalizedVersion = normalizeVersion(input.version);
  writeReleaseNotesState(input.statePath, {
    lastKnownVersion: normalizedVersion,
    lastShownVersion: normalizedVersion,
  });
}

function writeReleaseNotesState(statePath: string, state: ReleaseNotesState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
