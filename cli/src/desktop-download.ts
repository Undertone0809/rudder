import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { createByteProgress, type ByteProgressReporter } from "./utils/progress.js";

export const DEFAULT_DESKTOP_RELEASE_REPO = "Undertone0809/rudder";
export const DEFAULT_DESKTOP_RELEASE_MIRROR_BASE_URL =
  "https://rudder-releases-cn-1302936001.cos.ap-shanghai.myqcloud.com";

export type DesktopDownloadSource = "auto" | "cn" | "global";
export type DesktopDownloadOrigin = "mirror" | "github";

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  url?: string;
  download_urls?: string[];
}

type ProgressReporterFactory = (label: string) => ByteProgressReporter;

const GITHUB_ASSET_DOWNLOAD_ACCEPT = "application/octet-stream";
const DESKTOP_DOWNLOAD_SOURCE_PROBE_TIMEOUT_MS = 3_000;
const DESKTOP_ASSET_RESPONSE_TIMEOUT_MS = 30_000;
const DESKTOP_ASSET_IDLE_TIMEOUT_MS = 30_000;

export function resolveDesktopDownloadSource(
  optionValue?: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopDownloadSource {
  const value = optionValue?.trim() || env.RUDDER_DOWNLOAD_SOURCE?.trim() || "auto";
  if (value === "auto" || value === "cn" || value === "global") return value;
  throw new Error(`Desktop download source must be auto, cn, or global. Received ${value}.`);
}

function normalizeReleaseMirrorBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Rudder release mirror base URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Rudder release mirror base URL must use HTTP or HTTPS: ${value}`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function resolveDesktopReleaseMirrorBaseUrl(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.RUDDER_RELEASE_MIRROR_BASE_URL?.trim();
  if (override) return normalizeReleaseMirrorBaseUrl(override);
  return repo === DEFAULT_DESKTOP_RELEASE_REPO ? DEFAULT_DESKTOP_RELEASE_MIRROR_BASE_URL : null;
}

function encodeReleaseTagForDownloadUrl(tag: string): string {
  return tag.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function buildReleaseMirrorAssetDownloadUrl(
  baseUrl: string,
  tag: string,
  assetName: string,
): string {
  const encodedTag = encodeReleaseTagForDownloadUrl(tag);
  return `${normalizeReleaseMirrorBaseUrl(baseUrl)}/releases/${encodedTag}/${encodeURIComponent(assetName)}`;
}

function githubAssetDownloadUrls(asset: GithubReleaseAsset): string[] {
  return [asset.browser_download_url, asset.url].filter((url): url is string => Boolean(url));
}

function uniqueAssetDownloadUrls(asset: GithubReleaseAsset): string[] {
  const urls = asset.download_urls ?? githubAssetDownloadUrls(asset);
  return Array.from(new Set(urls));
}

export function withDesktopDownloadOrigins(
  asset: GithubReleaseAsset,
  origins: DesktopDownloadOrigin[],
  options: { mirrorBaseUrl: string | null; tag: string },
): GithubReleaseAsset {
  const githubUrls = githubAssetDownloadUrls(asset);
  const urls = origins.flatMap((origin) => {
    if (origin === "github") return githubUrls;
    if (!options.mirrorBaseUrl) return [];
    return [buildReleaseMirrorAssetDownloadUrl(options.mirrorBaseUrl, options.tag, asset.name)];
  });
  return { ...asset, download_urls: Array.from(new Set(urls)) };
}

function downloadHeadersForAssetUrl(asset: GithubReleaseAsset, url: string): HeadersInit {
  return {
    Accept: url === asset.url ? GITHUB_ASSET_DOWNLOAD_ACCEPT : "*/*",
    "User-Agent": "rudder-cli-installer",
  };
}

export function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const suffix = typeof code === "string" ? ` [${code}]` : "";
    return `${error.message}: ${cause.message}${suffix}`;
  }
  return error.message;
}

function contentLengthFromHeaders(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeDesktopDownloadUrl(
  url: string,
  timeoutMs = DESKTOP_DOWNLOAD_SOURCE_PROBE_TIMEOUT_MS,
): Promise<number | null> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "*/*",
          Range: "bytes=0-0",
          "User-Agent": "rudder-cli-installer",
        },
      },
      timeoutMs,
    );
    if (!response.ok) return null;
    await response.body?.cancel();
    return Date.now() - startedAt;
  } catch {
    return null;
  }
}

export async function resolveDesktopDownloadOrigins(options: {
  source: DesktopDownloadSource;
  checksumAsset: GithubReleaseAsset;
  tag: string;
  mirrorBaseUrl: string | null;
  probeTimeoutMs?: number;
}): Promise<DesktopDownloadOrigin[]> {
  if (!options.mirrorBaseUrl) return ["github"];
  if (options.source === "cn") return ["mirror", "github"];
  if (options.source === "global") return ["github", "mirror"];

  const mirrorUrl = buildReleaseMirrorAssetDownloadUrl(
    options.mirrorBaseUrl,
    options.tag,
    options.checksumAsset.name,
  );
  const githubUrl = options.checksumAsset.browser_download_url;
  const [mirrorElapsed, githubElapsed] = await Promise.all([
    probeDesktopDownloadUrl(mirrorUrl, options.probeTimeoutMs),
    probeDesktopDownloadUrl(githubUrl, options.probeTimeoutMs),
  ]);
  if (mirrorElapsed !== null && (githubElapsed === null || mirrorElapsed <= githubElapsed)) {
    return ["mirror", "github"];
  }
  return mirrorElapsed === null ? ["github"] : ["github", "mirror"];
}

export async function downloadAsset(
  asset: GithubReleaseAsset,
  outputDir: string,
  progressFactory: ProgressReporterFactory = createByteProgress,
  expectedChecksum?: string,
  timeouts: { idleMs?: number; responseMs?: number } = {},
): Promise<string> {
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, path.basename(asset.name));
  const idleTimeoutMs = timeouts.idleMs ?? DESKTOP_ASSET_IDLE_TIMEOUT_MS;
  const responseTimeoutMs = timeouts.responseMs ?? DESKTOP_ASSET_RESPONSE_TIMEOUT_MS;
  const failures: string[] = [];

  for (const url of uniqueAssetDownloadUrls(asset)) {
    let progress: ByteProgressReporter | null = null;
    let idleTimeout: NodeJS.Timeout | null = null;
    try {
      const response = await fetchWithTimeout(
        url,
        { headers: downloadHeadersForAssetUrl(asset, url) },
        responseTimeoutMs,
      );
      if (!response.ok || !response.body) {
        failures.push(`Failed to download ${asset.name} from ${url} (${response.status}).`);
        continue;
      }

      const totalBytes = contentLengthFromHeaders(response.headers);
      progress = progressFactory(`Downloading ${asset.name}`);
      let receivedBytes = 0;
      const hash = createHash("sha256");
      let monitor: Transform;
      const armIdleTimeout = () => {
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          monitor.destroy(new Error(`Download from ${url} made no progress for ${idleTimeoutMs}ms.`));
        }, idleTimeoutMs);
      };
      monitor = new Transform({
        transform(chunk: Buffer | string, encoding, callback) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding as BufferEncoding) : chunk;
          receivedBytes += bytes.length;
          hash.update(bytes);
          progress?.update(receivedBytes, totalBytes);
          armIdleTimeout();
          callback(null, chunk);
        },
      });

      progress.start(totalBytes);
      armIdleTimeout();
      await pipeline(Readable.fromWeb(response.body as never), monitor, createWriteStream(outputPath));
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = null;
      const actualChecksum = hash.digest("hex");
      if (expectedChecksum && actualChecksum !== expectedChecksum.toLowerCase()) {
        progress.fail();
        progress = null;
        await rm(outputPath, { force: true });
        failures.push(`Checksum mismatch for ${asset.name} from ${url}.`);
        continue;
      }
      progress.finish(receivedBytes, totalBytes);
      return outputPath;
    } catch (error) {
      if (idleTimeout) clearTimeout(idleTimeout);
      progress?.fail();
      await rm(outputPath, { force: true });
      failures.push(`Failed to download ${asset.name} from ${url}: ${formatFetchError(error)}.`);
    }
  }

  throw new Error(failures.join("\n"));
}
