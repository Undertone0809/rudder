import { resolveKnownWebsiteIcon } from "@rudderhq/shared";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { resolveRudderInstanceRoot } from "../home-paths.js";

export interface WebsiteMetadata {
  url: string;
  siteName: string | null;
  iconUrl: string | null;
}

export interface WebsiteMetadataOptions {
  allowPrivateHosts?: boolean;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;
const SUCCESS_CACHE_TTL_MS = 30 * 60_000;
const FAILURE_CACHE_TTL_MS = 5 * 60_000;
const ICON_DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const FALLBACK_FAVICON_SIZE = "64";
const IMAGE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

function isBenchmarkNetworkIpAddress(value: string) {
  const normalized = value.replace(/^\[|\]$/gu, "").toLowerCase();
  const ipv4Mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (ipv4Mapped) return isBenchmarkNetworkIpAddress(ipv4Mapped[1]);

  const parts = normalized.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return a === 198 && (b === 18 || b === 19);
}

function isPrivateIpAddress(value: string) {
  const normalized = value.replace(/^\[|\]$/gu, "").toLowerCase();
  const ipv4Mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (ipv4Mapped) return isPrivateIpAddress(ipv4Mapped[1]);
  if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  const parts = normalized.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (isBenchmarkNetworkIpAddress(normalized)) return true;
  return false;
}

function isBlockedResolvedIpAddress(value: string) {
  return isPrivateIpAddress(value) && !isBenchmarkNetworkIpAddress(value);
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIP(normalized)) return isPrivateIpAddress(normalized);
  return false;
}

function isPublicDnsHostname(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return false;
  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".corp") ||
    normalized.endsWith(".intranet")
  ) return false;
  if (!normalized.includes(".")) return false;
  if (isIP(normalized)) return false;
  return true;
}

export function parsePublicHttpUrl(value: string, options: WebsiteMetadataOptions = {}) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs can be inspected");
  }
  if (!options.allowPrivateHosts && isPrivateHostname(parsed.hostname)) {
    throw new Error("Private network URLs cannot be inspected");
  }
  parsed.hash = "";
  return parsed;
}

function resolveWebsiteIconCacheDir() {
  return path.resolve(resolveRudderInstanceRoot(), "data", "website-icons");
}

async function assertPublicResolvedHost(url: URL, options: WebsiteMetadataOptions) {
  if (options.allowPrivateHosts || options.fetchImpl || isIP(url.hostname.replace(/^\[|\]$/gu, ""))) return;
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const allowBenchmarkNetworkResolution = isPublicDnsHostname(url.hostname);
  if (addresses.some((address) => isPrivateIpAddress(address.address) && (!allowBenchmarkNetworkResolution || !isBenchmarkNetworkIpAddress(address.address)))) {
    throw new Error("Private network URLs cannot be inspected");
  }
}

interface FetchResult {
  response: Response;
  url: URL;
}

async function fetchWithTimeout(url: URL, options: WebsiteMetadataOptions, init?: RequestInit): Promise<FetchResult> {
  let currentUrl = parsePublicHttpUrl(url.href, options);
  const fetchImpl = options.fetchImpl ?? fetch;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicResolvedHost(currentUrl, options);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(currentUrl.href, {
        redirect: "manual",
        ...init,
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8",
          "user-agent": "RudderWebsiteMetadata/1.0",
          ...(init?.headers ?? {}),
        },
      });

      if (response.status < 300 || response.status >= 400) return { response, url: currentUrl };
      const location = response.headers.get("location");
      if (!location) return { response, url: currentUrl };
      currentUrl = parsePublicHttpUrl(new URL(location, currentUrl).href, options);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Website metadata redirect limit exceeded");
}

function metadataCacheKey(url: URL) {
  return url.href;
}

const metadataCache = new Map<string, { expiresAt: number; value: WebsiteMetadata }>();
const metadataInflight = new Map<string, Promise<WebsiteMetadata>>();

async function readLimitedBuffer(response: Response, maxBytes: number, options: { truncate?: boolean } = {}) {
  const body = response.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        if (options.truncate) {
          const remainingBytes = maxBytes - (total - value.byteLength);
          if (remainingBytes > 0) chunks.push(Buffer.from(value.slice(0, remainingBytes)));
          await reader.cancel();
          break;
        }
        throw new Error("Response exceeds metadata size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function contentTypeBase(value: string | null) {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isInspectableUrlFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message === "Only http and https URLs can be inspected"
    || error.message === "Private network URLs cannot be inspected"
    || error.message === "Website metadata redirect limit exceeded";
}

function absolutizeHref(href: string | null | undefined, baseUrl: URL, options: WebsiteMetadataOptions) {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePublicHttpUrl(new URL(trimmed, baseUrl).href, options);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function linkRelTokens(element: Element) {
  return (element.getAttribute("rel") ?? "")
    .split(/\s+/u)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function readSiteName(document: Document) {
  const selectors = [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
    'meta[name="apple-mobile-web-app-title"]',
  ];
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute("content")?.trim();
    if (value) return value;
  }
  const title = document.querySelector("title")?.textContent?.trim();
  return title || null;
}

function iconPriority(element: Element) {
  const rel = new Set(linkRelTokens(element));
  if (rel.has("icon") && rel.has("shortcut")) return 0;
  if (rel.has("icon")) return 1;
  if (rel.has("apple-touch-icon")) return 2;
  if (rel.has("apple-touch-icon-precomposed")) return 3;
  if (rel.has("mask-icon")) return 4;
  return 10;
}

function findDeclaredIcon(document: Document, baseUrl: URL, options: WebsiteMetadataOptions) {
  const candidates = Array.from(document.querySelectorAll("link[rel][href]"))
    .filter((element) => {
      const rel = new Set(linkRelTokens(element));
      return rel.has("icon")
        || rel.has("apple-touch-icon")
        || rel.has("apple-touch-icon-precomposed")
        || rel.has("mask-icon");
    })
    .sort((left, right) => iconPriority(left) - iconPriority(right));

  for (const candidate of candidates) {
    const href = absolutizeHref(candidate.getAttribute("href"), baseUrl, options);
    if (href) return href;
  }
  return null;
}

async function validateIconUrl(iconHref: string, options: WebsiteMetadataOptions) {
  try {
    const { response, url } = await fetchWithTimeout(parsePublicHttpUrl(iconHref, options), options, { method: "GET" });
    if (!response.ok) return null;
    const contentType = contentTypeBase(response.headers.get("content-type"));
    if (!IMAGE_CONTENT_TYPES.has(contentType)) return null;
    await readLimitedBuffer(response, MAX_ICON_BYTES);
    return url.href;
  } catch {
    return null;
  }
}

async function findImplicitFavicon(baseUrl: URL, options: WebsiteMetadataOptions) {
  const faviconUrl = new URL("/favicon.ico", baseUrl);
  return validateIconUrl(faviconUrl.href, options);
}

function fallbackFaviconProviderUrl(pageUrl: URL, options: WebsiteMetadataOptions) {
  if (options.allowPrivateHosts) return null;
  if (!isPublicDnsHostname(pageUrl.hostname)) return null;
  const providerUrl = new URL("/s2/favicons", "https://www.google.com");
  providerUrl.searchParams.set("domain_url", pageUrl.origin);
  providerUrl.searchParams.set("sz", FALLBACK_FAVICON_SIZE);
  return providerUrl.href;
}

async function findProviderFavicon(pageUrl: URL, options: WebsiteMetadataOptions) {
  const providerUrl = fallbackFaviconProviderUrl(pageUrl, options);
  return providerUrl ? validateIconUrl(providerUrl, options) : null;
}

async function resolveWebsiteMetadataUncached(value: string, options: WebsiteMetadataOptions): Promise<WebsiteMetadata> {
  const pageUrl = parsePublicHttpUrl(value, options);
  const knownIcon = resolveKnownWebsiteIcon(pageUrl);
  if (knownIcon) {
    return { url: pageUrl.href, siteName: knownIcon.siteName, iconUrl: knownIcon.iconDataUrl };
  }

  let pageResult: FetchResult;
  try {
    pageResult = await fetchWithTimeout(pageUrl, options);
  } catch (error) {
    if (isInspectableUrlFailure(error)) throw error;
    return { url: pageUrl.href, siteName: null, iconUrl: null };
  }
  const { response, url: finalPageUrl } = pageResult;
  if (!response.ok) {
    return { url: finalPageUrl.href, siteName: null, iconUrl: null };
  }

  const contentType = contentTypeBase(response.headers.get("content-type"));
  if (contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    return { url: finalPageUrl.href, siteName: null, iconUrl: null };
  }

  const html = (await readLimitedBuffer(response, MAX_HTML_BYTES, { truncate: true })).toString("utf8");
  const dom = new JSDOM(html, { url: finalPageUrl.href });
  try {
    const document = dom.window.document;
    const declaredIcon = findDeclaredIcon(document, finalPageUrl, options);
    return {
      url: finalPageUrl.href,
      siteName: readSiteName(document),
      iconUrl: (declaredIcon ? await validateIconUrl(declaredIcon, options) : null)
        ?? await findImplicitFavicon(finalPageUrl, options)
        ?? await findProviderFavicon(finalPageUrl, options),
    };
  } finally {
    dom.window.close();
  }
}

export async function resolveWebsiteMetadata(value: string, options: WebsiteMetadataOptions = {}): Promise<WebsiteMetadata> {
  const pageUrl = parsePublicHttpUrl(value, options);
  const key = metadataCacheKey(pageUrl);
  if (!options.allowPrivateHosts && !options.fetchImpl) {
    const cached = metadataCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inflight = metadataInflight.get(key);
    if (inflight) return inflight;

    const request = resolveWebsiteMetadataUncached(pageUrl.href, options)
      .then((metadata) => {
        metadataCache.set(key, {
          expiresAt: Date.now() + (metadata.iconUrl ? SUCCESS_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
          value: metadata,
        });
        return metadata;
      })
      .finally(() => {
        metadataInflight.delete(key);
      });
    metadataInflight.set(key, request);
    return request;
  }

  return resolveWebsiteMetadataUncached(pageUrl.href, options);
}

export async function fetchWebsiteIcon(value: string, options: WebsiteMetadataOptions = {}) {
  const iconUrl = parsePublicHttpUrl(value, options);
  if (!options.allowPrivateHosts && !options.fetchImpl) {
    const cached = await readCachedWebsiteIcon(iconUrl.href);
    if (cached) return cached;
  }
  const { response } = await fetchWithTimeout(iconUrl, options);
  if (!response.ok) return null;
  const contentType = contentTypeBase(response.headers.get("content-type"));
  if (!IMAGE_CONTENT_TYPES.has(contentType)) return null;
  const body = await readLimitedBuffer(response, MAX_ICON_BYTES);
  if (body.length <= 0) return null;
  const icon = { contentType, body };
  if (!options.allowPrivateHosts && !options.fetchImpl) {
    await writeCachedWebsiteIcon(iconUrl.href, icon).catch(() => undefined);
  }
  return icon;
}

interface CachedWebsiteIcon {
  contentType: string;
  body: Buffer;
}

function cachedWebsiteIconBasename(iconUrl: string) {
  return createHash("sha256").update(iconUrl).digest("hex");
}

function cachedWebsiteIconPaths(iconUrl: string) {
  const basename = cachedWebsiteIconBasename(iconUrl);
  const dir = resolveWebsiteIconCacheDir();
  return {
    metadataPath: path.join(dir, `${basename}.json`),
    bodyPath: path.join(dir, `${basename}.bin`),
  };
}

async function readCachedWebsiteIcon(iconUrl: string): Promise<CachedWebsiteIcon | null> {
  const { metadataPath, bodyPath } = cachedWebsiteIconPaths(iconUrl);
  try {
    const [rawMetadata, bodyStats] = await Promise.all([
      readFile(metadataPath, "utf8"),
      stat(bodyPath),
    ]);
    if (Date.now() - bodyStats.mtimeMs > ICON_DISK_CACHE_TTL_MS) return null;
    const metadata = JSON.parse(rawMetadata) as { contentType?: unknown; url?: unknown };
    if (metadata.url !== iconUrl || typeof metadata.contentType !== "string") return null;
    if (!IMAGE_CONTENT_TYPES.has(metadata.contentType)) return null;
    const body = await readFile(bodyPath);
    if (body.length <= 0 || body.length > MAX_ICON_BYTES) return null;
    return { contentType: metadata.contentType, body };
  } catch {
    return null;
  }
}

async function writeCachedWebsiteIcon(iconUrl: string, icon: CachedWebsiteIcon) {
  const { metadataPath, bodyPath } = cachedWebsiteIconPaths(iconUrl);
  await mkdir(path.dirname(bodyPath), { recursive: true });
  await Promise.all([
    writeFile(bodyPath, icon.body),
    writeFile(metadataPath, `${JSON.stringify({ url: iconUrl, contentType: icon.contentType })}\n`, "utf8"),
  ]);
}

export function __clearWebsiteMetadataCacheForTests() {
  metadataCache.clear();
  metadataInflight.clear();
}
