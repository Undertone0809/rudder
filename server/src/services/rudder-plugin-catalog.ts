import type { Db } from "@rudderhq/db";
import {
  installedPlugins,
  pluginImportReports,
  pluginPackages,
  pluginSources,
} from "@rudderhq/db";
import type {
  RudderPluginCatalog,
  RudderPluginCatalogEntry,
  RudderPluginCatalogSourceKind,
  RudderPluginCompatibilityComponent,
  RudderPluginDetail,
  RudderPluginPackageFileInput,
  RudderPluginSourceResolution,
} from "@rudderhq/shared";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { JSDOM } from "jsdom";
import fs from "node:fs/promises";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import { resolveRudderInstanceRoot } from "../home-paths.js";
import type { ManagedMcpConnectionServiceOptions } from "./mcp/managed-connections.js";
import { rudderPluginService } from "./rudder-plugins.js";

const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/Undertone0809/rudder-plugins/main/catalog.json";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FETCH_CONCURRENCY = 12;
const GITHUB_RAW_FILE_FETCH_THRESHOLD = 500;
const MAX_REDIRECTS = 3;
const CATALOG_DEGRADED_VISIBILITY_MS = 30_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);
const PRIORITY_PREFIXES = [
  "",
  "skills/",
  "skills/.curated/",
  "skills/.experimental/",
  "skills/.system/",
  ".agents/skills/",
  ".claude/skills/",
  ".cline/skills/",
  ".codebuddy/skills/",
  ".codex/skills/",
  ".commandcode/skills/",
  ".continue/skills/",
  ".github/skills/",
  ".goose/skills/",
  ".grok/skills/",
  ".iflow/skills/",
  ".junie/skills/",
  ".kilocode/skills/",
  ".kimchi/skills/",
  ".kiro/skills/",
  ".minimax/skills/",
  ".mux/skills/",
  ".neovate/skills/",
  ".opencode/skills/",
  ".openhands/skills/",
  ".pi/skills/",
  ".qoder/skills/",
  ".roo/skills/",
  ".trae/skills/",
  ".windsurf/skills/",
  ".zcode/skills/",
  ".zencoder/skills/",
];

type FetchLike = typeof fetch;
type CatalogRow = {
  slug: string;
  displayName: string;
  developer: string;
  category: string;
  shortDescription: string;
  sourceKind: RudderPluginCatalogSourceKind;
  sourcePath: string;
  iconPath: string;
  iconDarkPath: string;
};
type CatalogDocument = { schemaVersion: 1; updatedAt: string; plugins: CatalogRow[] };
type SourceDescriptor = {
  schemaVersion: 1;
  slug: string;
  kind: RudderPluginCatalogSourceKind;
  displayName: string;
  developer: string;
  category: string;
  shortDescription: string;
  longDescription: string;
  capabilities: string[];
  websiteUrl: string;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  license: { spdx: string; sourceUrl: string; note: string };
  source: {
    repositoryUrl: string;
    skillsAddSource: string;
    subdirectory: string;
    versionStrategy: "latest_stable_release_or_head";
  };
  assets: { icon: string; iconDark: string; origin: "rudder_generic" | "upstream_redistributable" };
};
type GitTreeEntry = { path: string; type: "blob" | "tree"; sha: string; size?: number };
type CatalogCache = { etag: string | null; fetchedAt: string; document: CatalogDocument };
type CatalogLoad = { cache: CatalogCache; freshness: "fresh" | "stale" };

class PluginSourceUnavailableError extends Error {}

function isPluginSourceUnavailable(error: unknown): error is PluginSourceUnavailableError {
  return error instanceof PluginSourceUnavailableError;
}

export function createCatalogFreshnessLease(
  durationMs = CATALOG_DEGRADED_VISIBILITY_MS,
  now: () => number = Date.now,
) {
  let staleUntil = 0;

  return {
    observe(freshness: CatalogLoad["freshness"]): CatalogLoad["freshness"] {
      const observedAt = now();
      if (freshness === "stale") {
        staleUntil = Math.max(staleUntil, observedAt + durationMs);
        return "stale";
      }
      return observedAt < staleUntil ? "stale" : "fresh";
    },
  };
}

export async function fetchPluginCatalogResource(
  fetcher: FetchLike,
  url: string,
  init: RequestInit = {},
  allowedHosts?: Set<string>,
): Promise<Response> {
  return fetchBounded(fetcher, url, init, allowedHosts);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, label: string, max = 1_200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw unprocessable(`Plugin catalog ${label} is invalid`);
  }
  return value.trim();
}

function safeRelativePath(value: unknown, label: string, allowEmpty = false): string {
  if (allowEmpty && value === "") return "";
  const raw = requiredString(value, label, 1_024).replace(/\\/g, "/").replace(/^\.\//, "");
  if (raw.split("/").some((part) => !part || part === "." || part === "..")) {
    throw unprocessable(`Plugin catalog ${label} contains an unsafe path`);
  }
  const normalized = path.posix.normalize(raw).replace(/\/$/, "");
  if (
    !normalized
    || normalized === "."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || path.posix.isAbsolute(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw unprocessable(`Plugin catalog ${label} contains an unsafe path`);
  }
  return normalized;
}

function httpsUrl(value: unknown, label: string, githubOnly = false): string {
  const raw = requiredString(value, label, 500);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw unprocessable(`Plugin catalog ${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" || (githubOnly && parsed.hostname !== "github.com")) {
    throw unprocessable(`Plugin catalog ${label} must use HTTPS${githubOnly ? " on github.com" : ""}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function validateCatalog(value: unknown): CatalogDocument {
  const record = asRecord(value);
  if (record.schemaVersion !== 1 || !Array.isArray(record.plugins)) {
    throw unprocessable("Plugin catalog has an unsupported schema");
  }
  const seen = new Set<string>();
  const plugins = record.plugins.map((raw, index) => {
    const entry = asRecord(raw);
    const slug = requiredString(entry.slug, `plugins[${index}].slug`, 80);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || seen.has(slug)) {
      throw unprocessable(`Plugin catalog contains an invalid or duplicate slug: ${slug}`);
    }
    seen.add(slug);
    if (entry.sourceKind !== "codex_plugin" && entry.sourceKind !== "skills_add") {
      throw unprocessable(`Plugin catalog ${slug} has an invalid source kind`);
    }
    return {
      slug,
      displayName: requiredString(entry.displayName, `${slug}.displayName`, 80),
      developer: requiredString(entry.developer, `${slug}.developer`, 80),
      category: requiredString(entry.category, `${slug}.category`, 80),
      shortDescription: requiredString(entry.shortDescription, `${slug}.shortDescription`, 180),
      sourceKind: entry.sourceKind,
      sourcePath: safeRelativePath(entry.sourcePath, `${slug}.sourcePath`),
      iconPath: safeRelativePath(entry.iconPath, `${slug}.iconPath`),
      iconDarkPath: safeRelativePath(entry.iconDarkPath, `${slug}.iconDarkPath`),
    } satisfies CatalogRow;
  });
  return { schemaVersion: 1, updatedAt: requiredString(record.updatedAt, "updatedAt", 80), plugins };
}

function validateDescriptor(value: unknown, expected: CatalogRow): SourceDescriptor {
  const record = asRecord(value);
  const source = asRecord(record.source);
  const license = asRecord(record.license);
  const assets = asRecord(record.assets);
  if (record.schemaVersion !== 1 || record.slug !== expected.slug || record.kind !== expected.sourceKind) {
    throw unprocessable(`Plugin source descriptor does not match catalog entry ${expected.slug}`);
  }
  if (source.versionStrategy !== "latest_stable_release_or_head") {
    throw unprocessable(`Plugin source ${expected.slug} has an unsupported version strategy`);
  }
  const sourceValue = requiredString(source.skillsAddSource, `${expected.slug}.source.skillsAddSource`, 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceValue)) {
    throw unprocessable(`Plugin source ${expected.slug} has an invalid skills add source`);
  }
  const origin = assets.origin;
  if (origin !== "rudder_generic" && origin !== "upstream_redistributable") {
    throw unprocessable(`Plugin source ${expected.slug} has invalid asset provenance`);
  }
  return {
    schemaVersion: 1,
    slug: expected.slug,
    kind: expected.sourceKind,
    displayName: requiredString(record.displayName, `${expected.slug}.displayName`, 80),
    developer: requiredString(record.developer, `${expected.slug}.developer`, 80),
    category: requiredString(record.category, `${expected.slug}.category`, 80),
    shortDescription: requiredString(record.shortDescription, `${expected.slug}.shortDescription`, 180),
    longDescription: requiredString(record.longDescription, `${expected.slug}.longDescription`),
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.map((item, index) => requiredString(item, `${expected.slug}.capabilities[${index}]`, 80))
      : [],
    websiteUrl: httpsUrl(record.websiteUrl, `${expected.slug}.websiteUrl`),
    privacyPolicyUrl: httpsUrl(record.privacyPolicyUrl, `${expected.slug}.privacyPolicyUrl`),
    termsOfServiceUrl: httpsUrl(record.termsOfServiceUrl, `${expected.slug}.termsOfServiceUrl`),
    license: {
      spdx: requiredString(license.spdx, `${expected.slug}.license.spdx`, 80),
      sourceUrl: httpsUrl(license.sourceUrl, `${expected.slug}.license.sourceUrl`),
      note: requiredString(license.note, `${expected.slug}.license.note`, 400),
    },
    source: {
      repositoryUrl: httpsUrl(source.repositoryUrl, `${expected.slug}.source.repositoryUrl`, true),
      skillsAddSource: sourceValue,
      subdirectory: source.subdirectory === "" ? "" : safeRelativePath(source.subdirectory, `${expected.slug}.source.subdirectory`),
      versionStrategy: "latest_stable_release_or_head",
    },
    assets: {
      icon: safeRelativePath(assets.icon, `${expected.slug}.assets.icon`),
      iconDark: safeRelativePath(assets.iconDark, `${expected.slug}.assets.iconDark`),
      origin,
    },
  };
}

function parseSemver(value: unknown): [number, number, number] | null {
  if (typeof value !== "string" || value.includes("-")) return null;
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareRelease(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const a = parseSemver(left.tag_name)!;
  const b = parseSemver(right.tag_name)!;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

function parseGitHubRepository(repositoryUrl: string): { owner: string; repo: string } {
  const parsed = new URL(repositoryUrl);
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  if (parsed.hostname !== "github.com" || segments.length !== 2) {
    throw unprocessable("Plugin source must identify one public GitHub repository");
  }
  return { owner: segments[0]!, repo: segments[1]! };
}

export function parseSkillsAddSource(source: string, explicitSubdirectory?: string): {
  repositoryUrl: string;
  source: string;
  owner: string;
  repo: string;
  ref: string | null;
  subdirectory: string;
} {
  const trimmed = source.trim();
  let owner: string;
  let repo: string;
  let ref: string | null = null;
  let sourceSubdirectory = "";
  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([^/]+))?(?:\/(.+))?$/);
  if (shorthand && !trimmed.includes(":")) {
    owner = shorthand[1]!;
    repo = shorthand[2]!;
    if ([owner, repo].some((segment) => segment === "." || segment === "..")) {
      throw unprocessable("Source must be a public GitHub owner/repository or HTTPS repository URL");
    }
    ref = shorthand[3] ? decodeURIComponent(shorthand[3]) : null;
    sourceSubdirectory = shorthand[4] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw unprocessable("Source must be a public GitHub owner/repository or HTTPS repository URL");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      throw unprocessable("Source must use HTTPS on github.com");
    }
    const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
    if (segments.length < 2) throw unprocessable("Source must identify one GitHub owner and repository");
    owner = segments[0]!;
    repo = segments[1]!;
    if (segments[2] === "tree" && segments[3]) {
      ref = decodeURIComponent(segments[3]);
      sourceSubdirectory = segments.slice(4).join("/");
    } else if (segments.length > 2) {
      sourceSubdirectory = segments.slice(2).join("/");
    }
  }
  const subdirectory = explicitSubdirectory !== undefined
    ? explicitSubdirectory.trim()
    : sourceSubdirectory;
  return {
    repositoryUrl: `https://github.com/${owner}/${repo}`,
    source: `${owner}/${repo}`,
    owner,
    repo,
    ref,
    subdirectory: subdirectory ? safeRelativePath(subdirectory, "source.subdirectory") : "",
  };
}

export function catalogSourceMatches(
  left: { repositoryUrl: string; subdirectory: string },
  right: { repositoryUrl: string; subdirectory: string },
): boolean {
  const normalizeRepository = (value: string) => value.replace(/\.git$/, "").replace(/\/$/, "").toLocaleLowerCase("en-US");
  const normalizeSubdirectory = (value: string) => value.replace(/^\.\//, "").replace(/\/$/, "");
  return normalizeRepository(left.repositoryUrl) === normalizeRepository(right.repositoryUrl)
    && normalizeSubdirectory(left.subdirectory) === normalizeSubdirectory(right.subdirectory);
}

export function discoverSkillsAddPaths(tree: GitTreeEntry[], subdirectory = ""): string[] {
  const prefix = subdirectory ? `${subdirectory.replace(/\/$/, "")}/` : "";
  const all = tree
    .filter((entry) => entry.type === "blob" && entry.path.toLocaleLowerCase("en-US").endsWith("skill.md"))
    .map((entry) => entry.path)
    .filter((entryPath) => !prefix || entryPath === `${prefix}SKILL.md` || entryPath.startsWith(prefix));
  if (all.length === 0) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const lower = new Set(all.map((entry) => entry.toLocaleLowerCase("en-US")));
  for (const priority of PRIORITY_PREFIXES) {
    const fullPrefix = `${prefix}${priority}`;
    const isContainer = priority !== "";
    for (const skillPath of all) {
      if (!skillPath.startsWith(fullPrefix)) continue;
      const rest = skillPath.slice(fullPrefix.length);
      const parts = rest.split("/");
      const direct = rest.toLocaleLowerCase("en-US") === "skill.md"
        || (parts.length === 2 && parts[1]!.toLocaleLowerCase("en-US") === "skill.md");
      const skillDirs = parts.slice(0, -1);
      const hasAncestor = skillDirs.slice(0, -1).some((_, index) => {
        const ancestor = skillDirs.slice(0, index + 1).join("/");
        return lower.has(`${fullPrefix}${ancestor}/SKILL.md`.toLocaleLowerCase("en-US"));
      });
      const nested = isContainer
        && parts.length >= 3
        && parts.length <= 4
        && parts.at(-1)!.toLocaleLowerCase("en-US") === "skill.md"
        && skillDirs.every((part) => !SKIP_DIRS.has(part.toLocaleLowerCase("en-US")))
        && !hasAncestor;
      if ((direct || nested) && !seen.has(skillPath)) {
        found.push(skillPath);
        seen.add(skillPath);
      }
    }
  }
  if (found.length > 0) return found.sort();
  return all
    .filter((skillPath) => {
      const relativeParts = skillPath.slice(prefix.length).split("/");
      const directories = relativeParts.slice(0, -1);
      return relativeParts.length <= 6
        && directories.every((part) => !SKIP_DIRS.has(part.toLocaleLowerCase("en-US")));
    })
    .sort();
}

async function fetchBounded(
  fetcher: FetchLike,
  url: string,
  init: RequestInit = {},
  allowedHosts?: Set<string>,
): Promise<Response> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (current.protocol !== "https:" || (allowedHosts && !allowedHosts.has(current.hostname))) {
      throw unprocessable("Plugin source redirected outside the allowed HTTPS hosts");
    }
    const response = await fetcher(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) throw unprocessable("Plugin source exceeded the redirect limit");
    current = new URL(location, current);
  }
  throw unprocessable("Plugin source exceeded the redirect limit");
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw unprocessable(`${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw unprocessable(`${label} did not return valid JSON`);
  }
}

async function githubJson(fetcher: FetchLike, apiPath: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchBounded(fetcher, `https://api.github.com${apiPath}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Rudder-Plugin-Hub",
        "x-github-api-version": "2022-11-28",
      },
    }, new Set(["api.github.com"]));
  } catch (error) {
    throw new PluginSourceUnavailableError(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    throw new PluginSourceUnavailableError(`GitHub API returned HTTP ${response.status}`);
  }
  return responseJson(response, "GitHub API");
}

async function githubCommitFromAtom(
  fetcher: FetchLike,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchBounded(
      fetcher,
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}.atom`,
      { headers: { accept: "application/atom+xml", "user-agent": "Rudder-Plugin-Hub" } },
      new Set(["github.com"]),
    );
  } catch (error) {
    throw new PluginSourceUnavailableError(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    throw new PluginSourceUnavailableError(`GitHub commit feed returned HTTP ${response.status}`);
  }
  if (!response.ok) throw unprocessable(`GitHub repository ref returned HTTP ${response.status}`);
  const atom = await response.text();
  if (Buffer.byteLength(atom, "utf8") > MAX_FILE_BYTES) {
    throw unprocessable("GitHub commit feed exceeds the 2 MiB limit");
  }
  const commitSha = atom.match(/Grit::Commit\/([0-9a-f]{40})/i)?.[1];
  if (!commitSha) throw unprocessable("GitHub did not resolve a full immutable commit SHA");
  return commitSha.toLocaleLowerCase("en-US");
}

async function githubStableReleaseTagFromAtom(fetcher: FetchLike, owner: string, repo: string): Promise<string | null> {
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases.atom`;
  let response: Response;
  try {
    response = await fetchBounded(
      fetcher,
      url,
      { headers: { accept: "application/atom+xml", "user-agent": "Rudder-Plugin-Hub" } },
      new Set(["github.com"]),
    );
  } catch (error) {
    throw new PluginSourceUnavailableError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    throw new PluginSourceUnavailableError(`GitHub release feed returned HTTP ${response.status}`);
  }
  const atom = await response.text();
  if (Buffer.byteLength(atom, "utf8") > MAX_FILE_BYTES) {
    throw unprocessable("GitHub release feed exceeds the 2 MiB limit");
  }
  let document: Document;
  try {
    document = new JSDOM(atom, { contentType: "application/xml" }).window.document;
  } catch (error) {
    throw new PluginSourceUnavailableError(
      `GitHub release feed is invalid XML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document.querySelector("parsererror")) {
    throw new PluginSourceUnavailableError("GitHub release feed is invalid XML");
  }
  const expectedPrefix = `/${owner}/${repo}/releases/tag/`.toLocaleLowerCase("en-US");
  const releases = Array.from(document.querySelectorAll("entry link[rel='alternate']"))
    .map((link) => link.getAttribute("href"))
    .filter((href): href is string => Boolean(href))
    .map((href) => {
      const target = new URL(href, url);
      if (target.protocol !== "https:" || target.hostname !== "github.com"
        || !target.pathname.toLocaleLowerCase("en-US").startsWith(expectedPrefix)) {
        throw new PluginSourceUnavailableError("GitHub release feed linked outside the expected repository");
      }
      return decodeURIComponent(target.pathname.slice(expectedPrefix.length));
    })
    .filter((tag) => parseSemver(tag))
    .map((tag) => ({ tag_name: tag }));
  const stable = releases.sort(compareRelease)[0];
  return stable ? requiredString(stable.tag_name, "GitHub release tag", 100) : null;
}

async function resolveGitHubVersionFromWeb(
  fetcher: FetchLike,
  input: { repositoryUrl: string; source: string; subdirectory: string; ref?: string | null },
): Promise<RudderPluginSourceResolution> {
  const { owner, repo } = parseGitHubRepository(input.repositoryUrl);
  const releaseTag = input.ref ? null : await githubStableReleaseTagFromAtom(fetcher, owner, repo);
  const strategy: RudderPluginSourceResolution["strategy"] = input.ref
    ? "explicit_ref"
    : releaseTag
      ? "stable_release"
      : "default_branch_head";
  const ref = input.ref ?? releaseTag ?? "HEAD";
  const commitSha = await githubCommitFromAtom(fetcher, owner, repo, ref);
  return {
    repositoryUrl: input.repositoryUrl,
    source: input.source,
    subdirectory: input.subdirectory,
    strategy,
    version: strategy === "default_branch_head" ? commitSha.slice(0, 12) : ref.replace(/^v/, ""),
    commitSha,
  };
}

async function resolveGitHubVersionFromApi(
  fetcher: FetchLike,
  input: { repositoryUrl: string; source: string; subdirectory: string; ref?: string | null },
): Promise<RudderPluginSourceResolution> {
  const { owner, repo } = parseGitHubRepository(input.repositoryUrl);
  const repository = asRecord(await githubJson(fetcher, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`));
  if (repository.private === true) throw unprocessable("Curated and URL Plugin sources must be public");
  let strategy: RudderPluginSourceResolution["strategy"];
  let version: string;
  let ref: string;
  if (input.ref) {
    strategy = "explicit_ref";
    version = input.ref;
    ref = input.ref;
  } else {
    const rawReleases = await githubJson(fetcher, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=30`);
    const releases = Array.isArray(rawReleases)
      ? rawReleases.map(asRecord).filter((release) => release.draft !== true && release.prerelease !== true && parseSemver(release.tag_name))
      : [];
    const stable = releases.sort(compareRelease)[0];
    if (stable) {
      strategy = "stable_release";
      version = requiredString(stable.tag_name, "GitHub release tag", 100);
      ref = version;
    } else {
      strategy = "default_branch_head";
      ref = requiredString(repository.default_branch, "GitHub default branch", 200);
      version = ref;
    }
  }
  const commit = asRecord(await githubJson(fetcher, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`));
  const commitSha = requiredString(commit.sha, "GitHub commit SHA", 40);
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw unprocessable("GitHub did not resolve a full immutable commit SHA");
  return {
    repositoryUrl: input.repositoryUrl,
    source: input.source,
    subdirectory: input.subdirectory,
    strategy,
    version: strategy === "default_branch_head" ? commitSha.slice(0, 12) : version.replace(/^v/, ""),
    commitSha: commitSha.toLocaleLowerCase("en-US"),
  };
}

export async function resolveGitHubVersion(
  fetcher: FetchLike,
  input: { repositoryUrl: string; source: string; subdirectory: string; ref?: string | null },
): Promise<RudderPluginSourceResolution> {
  try {
    return await resolveGitHubVersionFromApi(fetcher, input);
  } catch (error) {
    if (!isPluginSourceUnavailable(error)) throw error;
    return resolveGitHubVersionFromWeb(fetcher, input);
  }
}

export function safePackageEntries(tree: GitTreeEntry[], subdirectory: string): Array<GitTreeEntry & { relativePath: string }> {
  const prefix = subdirectory ? `${subdirectory.replace(/\/$/, "")}/` : "";
  const entries = tree
    .filter((entry) => entry.type === "blob" && (!prefix || entry.path.startsWith(prefix)))
    .map((entry) => ({ ...entry, relativePath: prefix ? entry.path.slice(prefix.length) : entry.path }))
    .filter((entry) => entry.relativePath.length > 0);
  if (entries.length === 0) throw unprocessable("Plugin source directory is empty");
  const folded = new Set<string>();
  for (const entry of entries) {
    const relativePath = safeRelativePath(entry.relativePath, "package file");
    const lower = relativePath.toLocaleLowerCase("en-US");
    if (folded.has(lower)) throw unprocessable(`Plugin contains a duplicate or case-colliding path: ${relativePath}`);
    folded.add(lower);
    const size = entry.size ?? 0;
    if (size > MAX_FILE_BYTES) throw unprocessable(`Plugin file exceeds 2 MiB: ${relativePath}`);
  }
  return entries;
}

async function fetchGitHubFiles(
  fetcher: FetchLike,
  resolution: RudderPluginSourceResolution,
): Promise<{ tree: GitTreeEntry[]; files: RudderPluginPackageFileInput[] }> {
  const { owner, repo } = parseGitHubRepository(resolution.repositoryUrl);
  let treeValue: Record<string, unknown>;
  try {
    treeValue = asRecord(await githubJson(fetcher, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${resolution.commitSha}?recursive=1`));
  } catch (error) {
    if (!isPluginSourceUnavailable(error)) throw error;
    return fetchGitHubArchiveFiles(fetcher, resolution);
  }
  if (treeValue.truncated === true || !Array.isArray(treeValue.tree)) throw unprocessable("GitHub package tree is unavailable or truncated");
  const tree = treeValue.tree.map((raw) => {
    const entry = asRecord(raw);
    const type = entry.type === "blob" ? "blob" : entry.type === "tree" ? "tree" : null;
    if (!type) return null;
    return {
      path: requiredString(entry.path, "GitHub tree path", 1_024),
      type,
      sha: requiredString(entry.sha, "GitHub tree SHA", 80),
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
    } satisfies GitTreeEntry;
  }).filter((entry): entry is GitTreeEntry => Boolean(entry));
  const selected = safePackageEntries(tree, resolution.subdirectory);
  if (selected.length > GITHUB_RAW_FILE_FETCH_THRESHOLD) {
    return fetchGitHubArchiveFiles(fetcher, resolution);
  }
  const files = new Array<RudderPluginPackageFileInput>(selected.length);
  let next = 0;
  async function worker() {
    while (next < selected.length) {
      const index = next;
      next += 1;
      const entry = selected[index]!;
      const response = await fetchBounded(
        fetcher,
        `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${resolution.commitSha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: { "user-agent": "Rudder-Plugin-Hub" } },
        new Set(["raw.githubusercontent.com"]),
      );
      if (!response.ok) throw unprocessable(`Plugin file fetch failed with HTTP ${response.status}: ${entry.relativePath}`);
      const content = Buffer.from(await response.arrayBuffer());
      if (content.byteLength > MAX_FILE_BYTES) throw unprocessable(`Plugin file exceeds 2 MiB: ${entry.relativePath}`);
      files[index] = { path: entry.relativePath, content: content.toString("base64"), encoding: "base64" };
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, selected.length) }, () => worker()));
  return { tree, files };
}

export async function fetchGitHubArchiveFiles(
  fetcher: FetchLike,
  resolution: RudderPluginSourceResolution,
): Promise<{ tree: GitTreeEntry[]; files: RudderPluginPackageFileInput[] }> {
  const { owner, repo } = parseGitHubRepository(resolution.repositoryUrl);
  let response: Response;
  try {
    response = await fetchBounded(
      fetcher,
      `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${resolution.commitSha}`,
      { headers: { accept: "application/zip", "user-agent": "Rudder-Plugin-Hub" } },
      new Set(["codeload.github.com"]),
    );
  } catch (error) {
    throw new PluginSourceUnavailableError(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    throw new PluginSourceUnavailableError(`GitHub archive returned HTTP ${response.status}`);
  }
  if (!response.ok) throw unprocessable(`GitHub archive returned HTTP ${response.status}`);
  const tree: GitTreeEntry[] = [];
  const files: RudderPluginPackageFileInput[] = [];
  const folded = new Set<string>();
  const sourcePrefix = resolution.subdirectory ? `${resolution.subdirectory.replace(/\/$/, "")}/` : "";
  let archiveRoot: string | null = null;
  let compressedBytes = 0;
  let totalBytes = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (failure || file.name.endsWith("/")) return;
    const slash = file.name.indexOf("/");
    if (slash <= 0 || slash === file.name.length - 1) {
      failure = new Error("GitHub archive is missing its repository root");
      file.terminate();
      return;
    }
    const root = file.name.slice(0, slash);
    if (archiveRoot && archiveRoot !== root) {
      failure = new Error("GitHub archive contains multiple repository roots");
      file.terminate();
      return;
    }
    archiveRoot = root;
    const repositoryPath = file.name.slice(slash + 1);
    if (sourcePrefix && !repositoryPath.startsWith(sourcePrefix)) return;
    const relativePath = sourcePrefix ? repositoryPath.slice(sourcePrefix.length) : repositoryPath;
    if (!relativePath) return;
    let normalized: string;
    try {
      normalized = safeRelativePath(relativePath, "package file");
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      file.terminate();
      return;
    }
    const lower = normalized.toLocaleLowerCase("en-US");
    if (folded.has(lower)) {
      failure = new Error(`Plugin contains a duplicate or case-colliding path: ${normalized}`);
      file.terminate();
      return;
    }
    if (file.originalSize !== undefined && file.originalSize > MAX_FILE_BYTES) {
      failure = new Error(`Plugin file exceeds 2 MiB: ${normalized}`);
      file.terminate();
      return;
    }
    if (file.size && file.originalSize && file.originalSize / file.size > 100) {
      failure = new Error(`Plugin archive entry exceeds the 100:1 expansion limit: ${normalized}`);
      file.terminate();
      return;
    }
    folded.add(lower);
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    file.ondata = (error, data, final) => {
      if (failure) return;
      if (error) {
        failure = error;
        return;
      }
      entryBytes += data.byteLength;
      totalBytes += data.byteLength;
      if (entryBytes > MAX_FILE_BYTES) {
        failure = new Error(`Plugin file exceeds 2 MiB: ${normalized}`);
        file.terminate();
        return;
      }
      chunks.push(Buffer.from(data));
      if (final) {
        tree.push({ path: repositoryPath, type: "blob", sha: "", size: entryBytes });
        files.push({ path: normalized, content: Buffer.concat(chunks).toString("base64"), encoding: "base64" });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  const reader = response.body?.getReader();
  if (!reader) throw unprocessable("GitHub archive response has no body");
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      compressedBytes += chunk.value.byteLength;
      unzip.push(chunk.value, false);
      if (failure) {
        await reader.cancel();
        break;
      }
    }
    if (!failure) unzip.push(new Uint8Array(), true);
  } catch (error) {
    throw unprocessable(`Invalid GitHub Plugin archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const archiveFailure = failure as Error | null;
  if (archiveFailure) throw unprocessable(archiveFailure.message);
  if (files.length === 0) throw unprocessable("Plugin source directory is empty");
  if (compressedBytes > 0 && totalBytes > compressedBytes * 100) {
    throw unprocessable("Plugin archive exceeds the 100:1 expansion limit");
  }
  return { tree, files };
}

function normalizedSemver(value: string): string {
  return parseSemver(value) ? value.replace(/^v/, "") : `0.0.0-${value.replace(/[^0-9A-Za-z-]+/g, "-").slice(0, 32) || "snapshot"}`;
}

export function synthesizeSkillsPlugin(
  descriptor: SourceDescriptor,
  resolution: RudderPluginSourceResolution,
  tree: GitTreeEntry[],
  files: RudderPluginPackageFileInput[],
): RudderPluginPackageFileInput[] {
  const sourcePrefix = resolution.subdirectory ? `${resolution.subdirectory}/` : "";
  const discovered = discoverSkillsAddPaths(tree, resolution.subdirectory)
    .map((skillPath) => sourcePrefix ? skillPath.slice(sourcePrefix.length) : skillPath);
  if (discovered.length === 0) throw unprocessable("No compatible Skills were discovered in this source");
  const roots = discovered.map((skillPath) => path.posix.dirname(skillPath));
  const discoveredSkillPaths = new Set(discovered);
  const matchesRoot = (filePath: string, root: string) => root === "."
    ? filePath !== ".codex-plugin/plugin.json"
      && !filePath.startsWith(".codex-plugin/")
      && (filePath === "SKILL.md"
        || path.posix.basename(filePath).toLocaleLowerCase("en-US") !== "skill.md"
        || discoveredSkillPaths.has(filePath))
    : filePath === `${root}/SKILL.md`
      || (filePath.startsWith(`${root}/`)
        && (path.posix.basename(filePath).toLocaleLowerCase("en-US") !== "skill.md"
          || discoveredSkillPaths.has(filePath)));
  const selected = files.filter((file) => roots.some((root) => matchesRoot(file.path, root)));
  const rootsByTarget = new Map<string, string>();
  const mapped = selected.map((file) => {
    const root = roots.find((candidate) => matchesRoot(file.path, candidate))!;
    const skillDir = root === "." ? descriptor.slug : path.posix.basename(root);
    let targetRoot = `skills/${skillDir}`;
    const existing = rootsByTarget.get(targetRoot);
    if (existing && existing !== root) targetRoot = `skills/${descriptor.slug}-${skillDir}`;
    rootsByTarget.set(targetRoot, root);
    const relative = root === "." ? file.path : file.path.slice(root.length + 1);
    return { ...file, path: `${targetRoot}/${relative}` };
  });
  const manifest = {
    name: descriptor.slug,
    version: normalizedSemver(resolution.version),
    description: descriptor.shortDescription,
    author: { name: descriptor.developer, url: descriptor.websiteUrl },
    homepage: descriptor.websiteUrl,
    repository: descriptor.source.repositoryUrl,
    license: descriptor.license.spdx,
    skills: "./skills/",
    interface: {
      displayName: descriptor.displayName,
      shortDescription: descriptor.shortDescription,
      longDescription: descriptor.longDescription,
      developerName: descriptor.developer,
      category: descriptor.category,
      capabilities: descriptor.capabilities,
      websiteURL: descriptor.websiteUrl,
      privacyPolicyURL: descriptor.privacyPolicyUrl,
      termsOfServiceURL: descriptor.termsOfServiceUrl,
    },
    rudder: {
      generatedFrom: "skills_add",
      source: descriptor.source.skillsAddSource,
      commitSha: resolution.commitSha,
      discoveredSkills: discovered,
    },
  };
  return [
    { path: ".codex-plugin/plugin.json", content: JSON.stringify(manifest), encoding: "utf8" },
    ...mapped,
  ];
}

function groupComponents(components: RudderPluginCompatibilityComponent[]): RudderPluginDetail["groups"] {
  return {
    skills: components.filter((component) => component.type === "skill"),
    mcps: components.filter((component) => component.type === "mcp"),
    apps: components.filter((component) => component.type === "app"),
    unsupported: components.filter((component) => component.type === "unsupported"),
  };
}

export function rudderPluginCatalogService(
  db: Db,
  mcpOptions: ManagedMcpConnectionServiceOptions,
  options: { fetch?: FetchLike; catalogUrl?: string; cachePath?: string } = {},
) {
  const plugins = rudderPluginService(db, mcpOptions);
  const fetcher = options.fetch ?? fetch;
  const catalogUrl = options.catalogUrl ?? process.env.RUDDER_PLUGIN_CATALOG_URL?.trim() ?? DEFAULT_CATALOG_URL;
  const catalogHost = new URL(catalogUrl).hostname;
  const catalogHosts = new Set([catalogHost]);
  const cachePath = options.cachePath ?? path.resolve(resolveRudderInstanceRoot(), "cache", "plugin-catalog", "catalog.json");
  let memory: CatalogCache | null = null;
  const resolutionCache = new Map<string, { expiresAt: number; value: RudderPluginSourceResolution }>();
  const freshnessLease = createCatalogFreshnessLease();

  async function readCache(): Promise<CatalogCache | null> {
    if (memory) return memory;
    try {
      const value = JSON.parse(await fs.readFile(cachePath, "utf8")) as CatalogCache;
      memory = { ...value, document: validateCatalog(value.document) };
      return memory;
    } catch {
      return null;
    }
  }

  async function writeCache(cache: CatalogCache) {
    memory = cache;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, cachePath);
  }

  async function loadCatalog(): Promise<CatalogLoad> {
    const previous = await readCache();
    try {
      const response = await fetchBounded(fetcher, catalogUrl, {
        headers: {
          accept: "application/json",
          "user-agent": "Rudder-Plugin-Hub",
          ...(previous?.etag ? { "if-none-match": previous.etag } : {}),
        },
      }, catalogHosts);
      if (response.status === 304 && previous) {
        return { cache: previous, freshness: freshnessLease.observe("fresh") };
      }
      const document = validateCatalog(await responseJson(response, "Plugin catalog"));
      const cache = { etag: response.headers.get("etag"), fetchedAt: new Date().toISOString(), document };
      await writeCache(cache);
      return { cache, freshness: freshnessLease.observe("fresh") };
    } catch (error) {
      if (previous) return { cache: previous, freshness: freshnessLease.observe("stale") };
      throw error;
    }
  }

  function catalogAssetUrl(relativePath: string): string {
    return new URL(relativePath, catalogUrl).toString();
  }

  async function loadDescriptor(slug: string): Promise<{ entry: CatalogRow; descriptor: SourceDescriptor; freshness: "fresh" | "stale" }> {
    const loaded = await loadCatalog();
    const entry = loaded.cache.document.plugins.find((candidate) => candidate.slug === slug);
    if (!entry) throw notFound("Plugin catalog entry not found");
    const response = await fetchBounded(fetcher, catalogAssetUrl(entry.sourcePath), {
      headers: { accept: "application/json", "user-agent": "Rudder-Plugin-Hub" },
    }, catalogHosts);
    const descriptor = validateDescriptor(await responseJson(response, "Plugin source descriptor"), entry);
    return { entry, descriptor, freshness: loaded.freshness };
  }

  async function catalogDescriptorForSource(
    source: { repositoryUrl: string; subdirectory: string },
  ): Promise<{ slug: string; descriptor: SourceDescriptor } | null> {
    try {
      const loaded = await loadCatalog();
      for (const entry of loaded.cache.document.plugins) {
        try {
          const response = await fetchBounded(fetcher, catalogAssetUrl(entry.sourcePath), {
            headers: { accept: "application/json", "user-agent": "Rudder-Plugin-Hub" },
          }, catalogHosts);
          const descriptor = validateDescriptor(await responseJson(response, "Plugin source descriptor"), entry);
          if (catalogSourceMatches(source, descriptor.source)) return { slug: entry.slug, descriptor };
        } catch {
          // An unavailable unrelated curated descriptor must not block an
          // otherwise valid explicit URL Import.
        }
      }
    } catch {
      // URL Import remains available when the optional curated catalog is down.
    }
    return null;
  }

  async function resolveDescriptor(descriptor: SourceDescriptor) {
    const key = `${descriptor.source.repositoryUrl}#${descriptor.source.subdirectory}`;
    const cached = resolutionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await resolveGitHubVersion(fetcher, {
      repositoryUrl: descriptor.source.repositoryUrl,
      source: descriptor.source.skillsAddSource,
      subdirectory: descriptor.source.subdirectory,
    });
    resolutionCache.set(key, { expiresAt: Date.now() + 5 * 60_000, value });
    return value;
  }

  async function installationState(orgId: string) {
    const rows = await db.select({
      installation: installedPlugins,
      pkg: pluginPackages,
      source: pluginSources,
    }).from(installedPlugins)
      .innerJoin(pluginPackages, eq(installedPlugins.packageId, pluginPackages.id))
      .leftJoin(pluginSources, eq(installedPlugins.sourceId, pluginSources.id))
      .where(and(eq(installedPlugins.orgId, orgId), ne(installedPlugins.lifecycleState, "uninstalled")));
    return rows;
  }

  async function catalog(orgId: string): Promise<RudderPluginCatalog> {
    const loaded = await loadCatalog();
    const installed = await installationState(orgId);
    const entries: RudderPluginCatalogEntry[] = await Promise.all(loaded.cache.document.plugins.map(async (entry) => {
      const current = installed.find((row) => asRecord(row.source?.metadata).catalogSlug === entry.slug);
      const metadata = asRecord(current?.source?.metadata);
      const installedSourceSha = typeof metadata.commitSha === "string" ? metadata.commitSha : null;
      let latestVersion: string | null = null;
      let latestSourceSha: string | null = null;
      if (current) {
        try {
          const { descriptor } = await loadDescriptor(entry.slug);
          const resolution = await resolveDescriptor(descriptor);
          latestVersion = resolution.version;
          latestSourceSha = resolution.commitSha;
        } catch {
          // Catalog discovery remains usable with installed state when the
          // lightweight upstream version check is temporarily unavailable.
        }
      }
      return {
        slug: entry.slug,
        displayName: entry.displayName,
        developer: entry.developer,
        category: entry.category,
        shortDescription: entry.shortDescription,
        sourceKind: entry.sourceKind,
        iconUrl: `/api/plugins/catalog/${encodeURIComponent(entry.slug)}/icon`,
        installedPluginId: current?.installation.id ?? null,
        installedVersion: current?.pkg.version ?? null,
        installedSourceSha,
        latestVersion,
        latestSourceSha,
        updateAvailable: Boolean(installedSourceSha && latestSourceSha && installedSourceSha !== latestSourceSha),
      };
    }));
    return { entries, freshness: loaded.freshness, updatedAt: loaded.cache.document.updatedAt };
  }

  async function installedDetail(
    orgId: string,
    descriptor: SourceDescriptor,
    resolution: RudderPluginSourceResolution,
    catalogSlug: string,
    iconUrl: string,
  ): Promise<RudderPluginDetail | null> {
    const rows = await installationState(orgId);
    const current = rows.find((row) => {
      const metadata = asRecord(row.source?.metadata);
      return metadata.catalogSlug === catalogSlug && metadata.commitSha === resolution.commitSha;
    });
    if (!current) return null;
    const compatibility = asRecord(current.pkg.compatibility);
    const components = Array.isArray(compatibility.components)
      ? compatibility.components as RudderPluginCompatibilityComponent[]
      : [];
    const warnings = Array.isArray(compatibility.warnings)
      ? compatibility.warnings.filter((value): value is string => typeof value === "string")
      : [];
    return {
      slug: descriptor.slug,
      displayName: descriptor.displayName,
      developer: descriptor.developer,
      category: descriptor.category,
      shortDescription: descriptor.shortDescription,
      longDescription: descriptor.longDescription,
      capabilities: descriptor.capabilities,
      websiteUrl: descriptor.websiteUrl,
      privacyPolicyUrl: descriptor.privacyPolicyUrl,
      termsOfServiceUrl: descriptor.termsOfServiceUrl,
      license: descriptor.license,
      sourceKind: descriptor.kind,
      iconUrl,
      previewId: null,
      packageId: current.pkg.id,
      action: "installed",
      installedPluginId: current.installation.id,
      resolution,
      components,
      groups: groupComponents(components),
      warnings,
      capabilityDiff: null,
      skillConflicts: [],
    };
  }

  async function preparePreview(
    orgId: string,
    descriptor: SourceDescriptor,
    resolution: RudderPluginSourceResolution,
    catalogSlug: string | null,
    iconUrl: string,
  ): Promise<RudderPluginDetail> {
    const downloaded = await fetchGitHubFiles(fetcher, resolution);
    const files = descriptor.kind === "skills_add"
      ? synthesizeSkillsPlugin(descriptor, resolution, downloaded.tree, downloaded.files)
      : downloaded.files;
    const report = await plugins.inspect(orgId, {
      sourceType: "local_upload",
      sourceLabel: `${descriptor.displayName} @ ${resolution.commitSha.slice(0, 12)}`,
      files: files.map((file) => ({ ...file, encoding: file.encoding ?? "utf8" })),
    }, {
      type: "git",
      label: `${descriptor.displayName} @ ${resolution.commitSha.slice(0, 12)}`,
      locator: `${resolution.repositoryUrl}${resolution.subdirectory ? `/tree/${resolution.commitSha}/${resolution.subdirectory}` : `#${resolution.commitSha}`}`,
      metadata: {
        catalogSlug,
        sourceKind: descriptor.kind,
        skillsAddSource: descriptor.source.skillsAddSource,
        repository: resolution.repositoryUrl,
        subdirectory: resolution.subdirectory,
        resolutionStrategy: resolution.strategy,
        resolvedVersion: resolution.version,
        commitSha: resolution.commitSha,
        immutable: true,
        category: descriptor.category,
        descriptor: {
          slug: descriptor.slug,
          displayName: descriptor.displayName,
          developer: descriptor.developer,
          category: descriptor.category,
          shortDescription: descriptor.shortDescription,
          longDescription: descriptor.longDescription,
          capabilities: descriptor.capabilities,
          websiteUrl: descriptor.websiteUrl,
          privacyPolicyUrl: descriptor.privacyPolicyUrl,
          termsOfServiceUrl: descriptor.termsOfServiceUrl,
          license: descriptor.license,
        },
      },
    });
    if (!report.packageId || report.errors.length > 0) {
      throw unprocessable(report.errors.join(" ") || "Plugin Preview could not be created");
    }
    return {
      slug: descriptor.slug,
      displayName: descriptor.displayName,
      developer: descriptor.developer,
      category: descriptor.category,
      shortDescription: descriptor.shortDescription,
      longDescription: descriptor.longDescription,
      capabilities: descriptor.capabilities,
      websiteUrl: descriptor.websiteUrl,
      privacyPolicyUrl: descriptor.privacyPolicyUrl,
      termsOfServiceUrl: descriptor.termsOfServiceUrl,
      license: descriptor.license,
      sourceKind: descriptor.kind,
      iconUrl,
      previewId: report.id,
      packageId: report.packageId,
      action: report.operation,
      installedPluginId: report.installedPluginId,
      resolution,
      components: report.components,
      groups: groupComponents(report.components),
      warnings: report.warnings,
      capabilityDiff: report.capabilityDiff,
      skillConflicts: report.skillConflicts,
    };
  }

  async function previewCatalog(orgId: string, slug: string) {
    const { descriptor } = await loadDescriptor(slug);
    try {
      const resolution = await resolveDescriptor(descriptor);
      const current = await installedDetail(
        orgId,
        descriptor,
        resolution,
        slug,
        `/api/plugins/catalog/${encodeURIComponent(slug)}/icon`,
      );
      if (current) return current;
      return preparePreview(orgId, descriptor, resolution, slug, `/api/plugins/catalog/${encodeURIComponent(slug)}/icon`);
    } catch (error) {
      if (!isPluginSourceUnavailable(error)) throw error;
      const stored = await db.select({ id: pluginImportReports.id })
        .from(pluginImportReports)
        .innerJoin(pluginSources, eq(pluginImportReports.sourceId, pluginSources.id))
        .where(and(
          eq(pluginImportReports.orgId, orgId),
          inArray(pluginImportReports.status, ["review_required", "accepted"]),
          sql`${pluginSources.metadata}->>'catalogSlug' = ${slug}`,
        ))
        .orderBy(desc(pluginImportReports.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!stored) throw error;
      const detail = await previewDetail(orgId, stored.id);
      return {
        ...detail,
        warnings: Array.from(new Set([
          ...detail.warnings,
          "GitHub is temporarily unavailable. Showing the most recent saved immutable Preview.",
        ])),
      };
    }
  }

  async function previewSource(orgId: string, sourceInput: string, explicitSubdirectory?: string) {
    const parsed = parseSkillsAddSource(sourceInput, explicitSubdirectory);
    const resolution = await resolveGitHubVersion(fetcher, parsed);
    const catalogMatch = await catalogDescriptorForSource(parsed);
    const slug = parsed.repo.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
    const descriptor: SourceDescriptor = catalogMatch?.descriptor ?? {
      schemaVersion: 1,
      slug: slug || "imported-skills",
      kind: "skills_add",
      displayName: parsed.repo.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      developer: parsed.owner,
      category: "Community",
      shortDescription: `Skills discovered from ${parsed.source}.`,
      longDescription: `A Skills-only Plugin preview generated deterministically from the public ${parsed.source} repository.`,
      capabilities: ["Read", "Write"],
      websiteUrl: parsed.repositoryUrl,
      privacyPolicyUrl: "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
      termsOfServiceUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
      license: {
        spdx: "NOASSERTION",
        sourceUrl: parsed.repositoryUrl,
        note: "Check the upstream repository license before installing this uncataloged source.",
      },
      source: {
        repositoryUrl: parsed.repositoryUrl,
        skillsAddSource: parsed.source,
        subdirectory: parsed.subdirectory,
        versionStrategy: "latest_stable_release_or_head",
      },
      assets: { icon: "", iconDark: "", origin: "rudder_generic" },
    };
    return preparePreview(
      orgId,
      descriptor,
      resolution,
      catalogMatch?.slug ?? null,
      catalogMatch ? `/api/plugins/catalog/${encodeURIComponent(catalogMatch.slug)}/icon` : "",
    );
  }

  async function previewDetail(orgId: string, previewId: string): Promise<RudderPluginDetail> {
    const stored = await db.select({
      report: pluginImportReports,
      pkg: pluginPackages,
      source: pluginSources,
    }).from(pluginImportReports)
      .innerJoin(pluginPackages, eq(pluginImportReports.packageId, pluginPackages.id))
      .innerJoin(pluginSources, eq(pluginImportReports.sourceId, pluginSources.id))
      .where(and(eq(pluginImportReports.orgId, orgId), eq(pluginImportReports.id, previewId)))
      .then((rows) => rows[0] ?? null);
    if (!stored) throw notFound("Plugin Preview not found");

    const metadata = asRecord(stored.source.metadata);
    const descriptor = asRecord(metadata.descriptor);
    const normalized = asRecord(stored.pkg.normalizedManifest);
    const report = asRecord(stored.report.report);
    const sourceKind = metadata.sourceKind;
    if ((sourceKind !== "codex_plugin" && sourceKind !== "skills_add") || metadata.immutable !== true) {
      throw notFound("Plugin Preview detail not found");
    }
    const strategy = metadata.resolutionStrategy;
    if (strategy !== "stable_release" && strategy !== "default_branch_head" && strategy !== "explicit_ref") {
      throw unprocessable("Stored Plugin Preview has an invalid resolution strategy");
    }
    const commitSha = requiredString(metadata.commitSha, "Preview commit SHA", 40);
    if (!/^[0-9a-f]{40}$/.test(commitSha)) {
      throw unprocessable("Stored Plugin Preview is missing a full immutable commit SHA");
    }
    const components = Array.isArray(report.components)
      ? report.components as RudderPluginCompatibilityComponent[]
      : [];
    const warnings = Array.isArray(report.warnings)
      ? report.warnings.filter((value): value is string => typeof value === "string")
      : [];
    const capabilityDiff = report.capabilityDiff && typeof report.capabilityDiff === "object"
      ? report.capabilityDiff as RudderPluginDetail["capabilityDiff"]
      : null;
    const skillConflicts = Array.isArray(report.skillConflicts)
      ? report.skillConflicts as RudderPluginDetail["skillConflicts"]
      : [];
    const catalogSlug = typeof metadata.catalogSlug === "string" && metadata.catalogSlug
      ? metadata.catalogSlug
      : null;
    const installation = await installationState(orgId).then((rows) => rows.find((row) => (
      row.pkg.id === stored.pkg.id || row.installation.id === report.installedPluginId
    )) ?? null);
    const exactPackageInstalled = installation?.pkg.id === stored.pkg.id;
    const action = exactPackageInstalled
      ? "installed"
      : stored.report.status === "review_required" && installation && report.operation === "update"
        ? "update"
        : "install";

    const license = asRecord(descriptor.license);
    const resolution: RudderPluginSourceResolution = {
      repositoryUrl: httpsUrl(metadata.repository, "Preview repository", true),
      source: requiredString(metadata.skillsAddSource, "Preview source", 200),
      subdirectory: metadata.subdirectory === ""
        ? ""
        : safeRelativePath(metadata.subdirectory, "Preview subdirectory"),
      strategy,
      version: requiredString(metadata.resolvedVersion, "Preview version", 100),
      commitSha,
    };
    return {
      slug: catalogSlug ?? requiredString(descriptor.slug ?? stored.pkg.name, "Preview slug", 64),
      displayName: requiredString(descriptor.displayName ?? normalized.displayName, "Preview display name", 80),
      developer: requiredString(descriptor.developer ?? normalized.publisher, "Preview developer", 80),
      category: requiredString(descriptor.category ?? metadata.category ?? normalized.category, "Preview category", 80),
      shortDescription: requiredString(descriptor.shortDescription ?? normalized.shortDescription, "Preview short description", 180),
      longDescription: requiredString(descriptor.longDescription, "Preview long description"),
      capabilities: Array.isArray(descriptor.capabilities)
        ? descriptor.capabilities.filter((value): value is string => typeof value === "string")
        : [],
      websiteUrl: httpsUrl(descriptor.websiteUrl, "Preview website URL"),
      privacyPolicyUrl: httpsUrl(descriptor.privacyPolicyUrl, "Preview privacy policy URL"),
      termsOfServiceUrl: httpsUrl(descriptor.termsOfServiceUrl, "Preview terms URL"),
      license: {
        spdx: requiredString(license.spdx, "Preview license", 80),
        sourceUrl: httpsUrl(license.sourceUrl, "Preview license URL"),
        note: requiredString(license.note, "Preview license note", 400),
      },
      sourceKind,
      iconUrl: catalogSlug ? `/api/plugins/catalog/${encodeURIComponent(catalogSlug)}/icon` : "",
      previewId: stored.report.id,
      packageId: stored.pkg.id,
      action,
      installedPluginId: action === "installed" || action === "update"
        ? installation?.installation.id ?? null
        : null,
      resolution,
      components,
      groups: groupComponents(components),
      warnings,
      capabilityDiff,
      skillConflicts,
    };
  }

  async function icon(slug: string, dark: boolean) {
    const loaded = await loadCatalog();
    const entry = loaded.cache.document.plugins.find((candidate) => candidate.slug === slug);
    if (!entry) throw notFound("Plugin catalog icon not found");
    const response = await fetchBounded(fetcher, catalogAssetUrl(dark ? entry.iconDarkPath : entry.iconPath), {
      headers: { accept: "image/png", "user-agent": "Rudder-Plugin-Hub" },
    }, catalogHosts);
    if (!response.ok) throw notFound("Plugin catalog icon not found");
    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength === 0 || content.byteLength > 512 * 1024 || !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw unprocessable("Plugin catalog icon is not a bounded PNG");
    }
    return { content, etag: response.headers.get("etag"), freshness: loaded.freshness };
  }

  return { catalog, icon, previewCatalog, previewSource, previewDetail };
}
