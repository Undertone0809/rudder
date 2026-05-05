export type DesktopUpdateCheckStatus = "update-available" | "up-to-date" | "unavailable";
export type DesktopUpdateChannel = "stable" | "canary";

export type DesktopUpdateCheckResult = {
  status: DesktopUpdateCheckStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt: string;
};

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

type CheckForRudderDesktopUpdatesOptions = {
  currentVersion: string;
  appName: string;
  repo: string;
  releasesUrl: string;
  channel?: DesktopUpdateChannel;
  fetchImpl?: typeof fetch;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const aPart = aParts[index];
    const bPart = bParts[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;

    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return Number(aPart) - Number(bPart);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return aPart.localeCompare(bPart);
  }

  return 0;
}

export function compareRudderVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);

  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch - parsedB.patch;

  if (parsedA.prerelease === parsedB.prerelease) return 0;
  if (!parsedA.prerelease) return 1;
  if (!parsedB.prerelease) return -1;
  return comparePrereleaseIdentifiers(parsedA.prerelease, parsedB.prerelease);
}

export function resolveUpdateChannel(currentVersion: string): DesktopUpdateChannel {
  const parsed = parseVersion(currentVersion);
  return parsed?.prerelease?.startsWith("canary.") ? "canary" : "stable";
}

export function normalizeReleaseVersion(tagName: string, channel: DesktopUpdateChannel = "stable"): string | null {
  const decodedTagName = decodeURIComponent(tagName.trim());
  const normalized = channel === "canary"
    ? decodedTagName.replace(/^canary\/v?/, "")
    : decodedTagName.replace(/^v/, "");
  const parsed = parseVersion(normalized);
  if (!parsed) return null;
  if (channel === "stable" && parsed.prerelease) return null;
  if (channel === "canary" && !parsed.prerelease?.startsWith("canary.")) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function normalizeReleaseDisplayVersion(tagName: string, channel: DesktopUpdateChannel): string | null {
  const decodedTagName = decodeURIComponent(tagName.trim());
  const normalized = channel === "canary"
    ? decodedTagName.replace(/^canary\/v?/, "")
    : decodedTagName.replace(/^v/, "");
  const parsed = parseVersion(normalized);
  if (!parsed) return null;
  if (channel === "stable" && parsed.prerelease) return null;
  if (channel === "canary" && !parsed.prerelease?.startsWith("canary.")) return null;
  return parsed.prerelease
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}-${parsed.prerelease}`
    : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function chooseLatestRelease(
  releases: GitHubRelease[],
  channel: DesktopUpdateChannel = "stable",
): { version: string; releaseUrl?: string } | null {
  let latest: { version: string; releaseUrl?: string } | null = null;

  for (const release of releases) {
    if (release.draft || !release.tag_name) continue;
    if (channel === "stable" && release.prerelease) continue;

    const version = normalizeReleaseDisplayVersion(release.tag_name, channel);
    if (!version) continue;

    if (!latest || compareRudderVersions(version, latest.version) > 0) {
      latest = {
        version,
        releaseUrl: release.html_url,
      };
    }
  }

  return latest;
}

export const chooseLatestStableRelease = (releases: GitHubRelease[]) => chooseLatestRelease(releases, "stable");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function releasesPageToReleaseList(html: string, repo: string): GitHubRelease[] {
  const releasePathPattern = new RegExp(
    `href=["']/${escapeRegExp(repo)}/releases/tag/([^"'?#]+)["']`,
    "g",
  );
  const releases: GitHubRelease[] = [];
  const seenTags = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = releasePathPattern.exec(html)) !== null) {
    const tagName = decodeURIComponent(match[1] ?? "");
    if (!tagName || seenTags.has(tagName)) continue;
    seenTags.add(tagName);
    releases.push({
      tag_name: tagName,
      html_url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tagName)}`,
      prerelease: tagName.includes("-"),
    });
  }
  return releases;
}

async function fetchLatestReleaseWithFallback(options: {
  appName: string;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  fetchImpl: typeof fetch;
  repo: string;
  releasesUrl: string;
}): Promise<{ version: string; releaseUrl?: string } | null> {
  const { appName, channel, currentVersion, fetchImpl, repo, releasesUrl } = options;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${appName}/${currentVersion}`,
  };

  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
    if (!response.ok) {
      throw new Error(`GitHub release lookup failed (${response.status})`);
    }

    const payload = await response.json() as GitHubRelease[];
    const latest = chooseLatestRelease(Array.isArray(payload) ? payload : [], channel);
    if (latest) return latest;
  } catch (error) {
    console.warn("[rudder-desktop] GitHub releases API update check failed", error);
  }

  const response = await fetchImpl(releasesUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent": `${appName}/${currentVersion}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases page lookup failed (${response.status})`);
  }

  return chooseLatestRelease(releasesPageToReleaseList(await response.text(), repo), channel);
}

export async function checkForRudderDesktopUpdates(
  options: CheckForRudderDesktopUpdatesOptions,
): Promise<DesktopUpdateCheckResult> {
  const { currentVersion, appName, repo, releasesUrl, channel = "stable", fetchImpl = fetch } = options;

  try {
    const latest = await fetchLatestReleaseWithFallback({
      appName,
      channel,
      currentVersion,
      fetchImpl,
      repo,
      releasesUrl,
    });
    if (!latest) {
      throw new Error(`GitHub release lookup returned no ${channel} release`);
    }

    return {
      status: compareRudderVersions(latest.version, currentVersion) > 0 ? "update-available" : "up-to-date",
      channel,
      currentVersion,
      latestVersion: latest.version,
      releaseUrl: latest.releaseUrl ?? releasesUrl,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("[rudder-desktop] update check failed", error);
    return {
      status: "unavailable",
      channel,
      currentVersion,
      releaseUrl: releasesUrl,
      checkedAt: new Date().toISOString(),
    };
  }
}
