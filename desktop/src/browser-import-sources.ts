import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type BrowserImportSource = {
  id: string;
  displayName: string;
  browserName: string;
  profileName: string;
  supported: {
    cookies: boolean;
    passwords: boolean;
  };
};

export type TrustedBrowserImportSource = BrowserImportSource & {
  cookieDatabasePath: string;
  keychain: {
    service: string;
    account: string;
  };
};

type BrowserDescriptor = {
  browserName: string;
  relativeRoot: string;
  keychain: TrustedBrowserImportSource["keychain"];
};

const MAC_BROWSER_DESCRIPTORS: BrowserDescriptor[] = [
  {
    browserName: "Google Chrome",
    relativeRoot: "Library/Application Support/Google/Chrome",
    keychain: { service: "Chrome Safe Storage", account: "Chrome" },
  },
  {
    browserName: "Microsoft Edge",
    relativeRoot: "Library/Application Support/Microsoft Edge",
    keychain: { service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
  },
  {
    browserName: "Brave",
    relativeRoot: "Library/Application Support/BraveSoftware/Brave-Browser",
    keychain: { service: "Brave Safe Storage", account: "Brave" },
  },
];

const MAX_LOCAL_STATE_BYTES = 16 * 1024 * 1024;

function isSafeProfileSegment(value: string): boolean {
  return value.length > 0
    && value !== "."
    && value !== ".."
    && path.basename(value) === value
    && !value.includes("\0")
    && !value.includes("/")
    && !value.includes("\\");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sanitizeProfileName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return normalized || fallback;
}

async function isRegularFileWithoutSymlink(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(filePath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readLocalState(localStatePath: string): Promise<string> {
  const handle = await fs.open(localStatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_LOCAL_STATE_BYTES) {
      throw new Error("Browser Local State is not a supported regular file.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function discoverBrowserSources(
  homeDir: string,
  descriptor: BrowserDescriptor,
  createId: () => string,
  realpath: (candidate: string) => Promise<string>,
): Promise<TrustedBrowserImportSource[]> {
  const browserRoot = path.join(homeDir, descriptor.relativeRoot);
  const localStatePath = path.join(browserRoot, "Local State");
  try {
    const rootStats = await fs.lstat(browserRoot);
    const stateStats = await fs.lstat(localStatePath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()
      || !stateStats.isFile() || stateStats.isSymbolicLink()
      || stateStats.size > MAX_LOCAL_STATE_BYTES) {
      return [];
    }
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readLocalState(localStatePath));
  } catch {
    return [];
  }
  const infoCache = (parsed as { profile?: { info_cache?: unknown } })?.profile?.info_cache;
  if (!infoCache || typeof infoCache !== "object" || Array.isArray(infoCache)) return [];

  let canonicalBrowserRoot: string;
  try {
    canonicalBrowserRoot = await realpath(browserRoot);
  } catch {
    return [];
  }
  const discovered: TrustedBrowserImportSource[] = [];
  for (const [profileSegment, metadata] of Object.entries(infoCache as Record<string, unknown>)) {
    if (!isSafeProfileSegment(profileSegment)) continue;
    const profileRoot = path.join(browserRoot, profileSegment);
    let canonicalProfileRoot: string;
    try {
      const profileStats = await fs.lstat(profileRoot);
      if (!profileStats.isDirectory() || profileStats.isSymbolicLink()) continue;
      canonicalProfileRoot = await fs.realpath(profileRoot);
      if (!isInsideRoot(canonicalBrowserRoot, canonicalProfileRoot)) continue;
    } catch {
      continue;
    }

    const candidates = [path.join(profileRoot, "Network", "Cookies"), path.join(profileRoot, "Cookies")];
    let cookieDatabasePath: string | null = null;
    for (const candidate of candidates) {
      if (!await isRegularFileWithoutSymlink(candidate)) continue;
      try {
        const canonicalCandidate = await realpath(candidate);
        if (isInsideRoot(canonicalProfileRoot, canonicalCandidate)) {
          cookieDatabasePath = canonicalCandidate;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!cookieDatabasePath) continue;

    const profileName = sanitizeProfileName(
      metadata && typeof metadata === "object" ? (metadata as { name?: unknown }).name : undefined,
      profileSegment,
    );
    const source: TrustedBrowserImportSource = {
      id: createId(),
      displayName: `${descriptor.browserName} - ${profileName}`,
      browserName: descriptor.browserName,
      profileName,
      supported: { cookies: true, passwords: false },
      cookieDatabasePath,
      keychain: { ...descriptor.keychain },
    };
    discovered.push(source);
  }
  return discovered;
}

export function createBrowserImportSourceRegistry(options: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  createId?: () => string;
  realpath?: (candidate: string) => Promise<string>;
} = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const createId = options.createId ?? randomUUID;
  const realpath = options.realpath ?? ((candidate: string) => fs.realpath(candidate));
  const trustedSources = new Map<string, TrustedBrowserImportSource>();

  return {
    listSources: async (): Promise<BrowserImportSource[]> => {
      trustedSources.clear();
      if (platform !== "darwin") return [];
      const discovered: TrustedBrowserImportSource[] = [];
      for (const descriptor of MAC_BROWSER_DESCRIPTORS) {
        discovered.push(...await discoverBrowserSources(homeDir, descriptor, createId, realpath));
      }
      for (const source of discovered) {
        if (trustedSources.has(source.id)) throw new Error("Browser import source IDs must be unique.");
        trustedSources.set(source.id, source);
      }
      return discovered.map(({ cookieDatabasePath: _path, keychain: _keychain, ...publicSource }) => publicSource);
    },
    resolveSource: (sourceId: string): TrustedBrowserImportSource => {
      const source = trustedSources.get(sourceId);
      if (!source) throw new Error("Unknown browser import source.");
      return source;
    },
  };
}
