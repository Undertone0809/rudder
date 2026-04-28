export type DesktopUpdateCheckStatus = "update-available" | "up-to-date" | "unavailable";

export type DesktopUpdateCheckResult = {
  status: DesktopUpdateCheckStatus;
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

type CheckForStableUpdatesOptions = {
  currentVersion: string;
  appName: string;
  repo: string;
  releasesUrl: string;
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
  return parsedA.prerelease.localeCompare(parsedB.prerelease);
}

export function normalizeReleaseVersion(tagName: string): string | null {
  const normalized = tagName.trim().replace(/^v/, "");
  const parsed = parseVersion(normalized);
  if (!parsed || parsed.prerelease) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function chooseLatestStableRelease(releases: GitHubRelease[]): { version: string; releaseUrl?: string } | null {
  let latest: { version: string; releaseUrl?: string } | null = null;

  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name) continue;

    const version = normalizeReleaseVersion(release.tag_name);
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

export async function checkForStableUpdates(
  options: CheckForStableUpdatesOptions,
): Promise<DesktopUpdateCheckResult> {
  const { currentVersion, appName, repo, releasesUrl, fetchImpl = fetch } = options;

  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${appName}/${currentVersion}`,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub release lookup failed (${response.status})`);
    }

    const payload = await response.json() as GitHubRelease[];
    const latest = chooseLatestStableRelease(Array.isArray(payload) ? payload : []);
    if (!latest) {
      throw new Error("GitHub release lookup returned no stable release");
    }

    return {
      status: compareRudderVersions(latest.version, currentVersion) > 0 ? "update-available" : "up-to-date",
      currentVersion,
      latestVersion: latest.version,
      releaseUrl: latest.releaseUrl ?? releasesUrl,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("[rudder-desktop] update check failed", error);
    return {
      status: "unavailable",
      currentVersion,
      releaseUrl: releasesUrl,
      checkedAt: new Date().toISOString(),
    };
  }
}
