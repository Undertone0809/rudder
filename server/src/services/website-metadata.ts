import { resolveKnownWebsiteIcon } from "@rudderhq/shared";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Agent, type Dispatcher } from "undici";
import { resolveRudderInstanceRoot } from "../home-paths.js";

export interface WebsiteMetadata {
  url: string;
  siteName: string | null;
  pageTitle: string | null;
  iconUrl: string | null;
}

export type WebsiteMetadataPurpose = "preview" | "authoring";

export interface WebsiteMetadataOptions {
  allowPrivateHosts?: boolean;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  purpose?: WebsiteMetadataPurpose;
}

const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_PAGE_TITLE_CHARACTERS = 160;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;
const SUCCESS_CACHE_TTL_MS = 30 * 60_000;
const FAILURE_CACHE_TTL_MS = 5 * 60_000;
const MAX_METADATA_CACHE_ENTRIES = 128;
const ICON_DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ICON_DISK_CACHE_ENTRIES = 128;
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

  const parts = normalized.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return a === 198 && (b === 18 || b === 19);
}

function isPrivateIpAddress(value: string) {
  const normalized = value.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!ipaddr.isValid(normalized)) return false;
  const address = ipaddr.process(normalized);
  if (address.kind() === "ipv4") {
    return address.range() !== "unicast"
      || isBenchmarkNetworkIpAddress(address.toString());
  }

  const bytes = address.toByteArray();
  const isDeprecatedSiteLocal = bytes[0] === 0xfe
    && ((bytes[1] ?? 0) & 0xc0) === 0xc0;
  return address.range() !== "unicast" || isDeprecatedSiteLocal;
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
  if (parsed.username || parsed.password) {
    throw new Error("Credentialed URLs cannot be inspected");
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

interface ResolvedHostAddress {
  address: string;
  family: number;
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  const disposeLateValue = (value: T) => {
    if (!onLateValue) return;
    void Promise.resolve(onLateValue(value)).catch(() => undefined);
  };
  if (signal.aborted) {
    void promise.then(disposeLateValue, () => undefined);
    throw signal.reason;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) {
          disposeLateValue(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolveValidatedHostAddress(
  url: URL,
  options: WebsiteMetadataOptions,
  signal: AbortSignal,
): Promise<ResolvedHostAddress | null> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (options.fetchImpl || isIP(hostname)) return null;
  const addresses = await awaitWithAbort(
    lookup(url.hostname, { all: true, verbatim: true }),
    signal,
  );
  if (addresses.length === 0) throw new Error("Website hostname did not resolve");
  if (
    !options.allowPrivateHosts
    && addresses.some((address) => isPrivateIpAddress(address.address))
  ) {
    throw new Error("Private network URLs cannot be inspected");
  }
  return addresses[0] ?? null;
}

function createPinnedDispatcher(resolvedHost: ResolvedHostAddress | null) {
  if (!resolvedHost) return null;
  return new Agent({
    connect: {
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => {
        callback(null, resolvedHost.address, resolvedHost.family);
      },
    },
  });
}

async function cancelResponseBody(response: Response | null) {
  const body = response?.body;
  if (!body || body.locked) return;
  try {
    await body.cancel();
  } catch {
    // Fetch aborts and peer disconnects can close the body before cancellation settles.
  }
}

async function closeDispatcher(dispatcher: Dispatcher | null, aborted: boolean) {
  if (!dispatcher) return;
  try {
    if (aborted) await dispatcher.destroy();
    else await dispatcher.close();
  } catch {
    // Cleanup must not replace the request result with a connection teardown error.
  }
}

interface FetchResult {
  response: Response;
  url: URL;
  signal: AbortSignal;
  release: () => Promise<void>;
}

async function fetchWithTimeout(url: URL, options: WebsiteMetadataOptions, init?: RequestInit): Promise<FetchResult> {
  let currentUrl = parsePublicHttpUrl(url.href, options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("Website metadata request timed out"));
  }, FETCH_TIMEOUT_MS);
  timeout.unref?.();
  let activeResponse: Response | null = null;
  let activeDispatcher: Dispatcher | null = null;
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    clearTimeout(timeout);
    await cancelResponseBody(activeResponse);
    activeResponse = null;
    await closeDispatcher(activeDispatcher, controller.signal.aborted);
    activeDispatcher = null;
  };

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const resolvedHost = await resolveValidatedHostAddress(currentUrl, options, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      activeDispatcher = createPinnedDispatcher(resolvedHost);
      const requestInit = {
        redirect: "manual",
        ...init,
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8",
          "user-agent": "RudderWebsiteMetadata/1.0",
          ...(init?.headers ?? {}),
        },
        ...(activeDispatcher ? { dispatcher: activeDispatcher } : {}),
      } as RequestInit & { dispatcher?: Dispatcher };
      const response = await awaitWithAbort(
        fetchImpl(currentUrl.href, { ...requestInit }),
        controller.signal,
        cancelResponseBody,
      );
      activeResponse = response;

      if (response.status < 300 || response.status >= 400) {
        return {
          response,
          url: currentUrl,
          signal: controller.signal,
          release,
        };
      }
      const location = response.headers.get("location");
      if (!location) {
        return {
          response,
          url: currentUrl,
          signal: controller.signal,
          release,
        };
      }
      await cancelResponseBody(activeResponse);
      activeResponse = null;
      await closeDispatcher(activeDispatcher, controller.signal.aborted);
      activeDispatcher = null;
      currentUrl = parsePublicHttpUrl(new URL(location, currentUrl).href, options);
    }

    throw new Error("Website metadata redirect limit exceeded");
  } catch (error) {
    await release();
    throw error;
  }
}

function metadataCacheKey(url: URL, purpose: WebsiteMetadataPurpose) {
  return `${purpose}:${url.href}`;
}

const metadataCache = new Map<string, { expiresAt: number; value: WebsiteMetadata }>();
const metadataInflight = new Map<string, Promise<WebsiteMetadata>>();

function pruneMetadataCache(now = Date.now()) {
  for (const [key, entry] of metadataCache) {
    if (entry.expiresAt <= now) metadataCache.delete(key);
  }
}

function makeRoomInMetadataCache() {
  while (metadataCache.size >= MAX_METADATA_CACHE_ENTRIES) {
    const oldestKey = metadataCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    metadataCache.delete(oldestKey);
  }
}

async function readLimitedBuffer(
  response: Response,
  maxBytes: number,
  options: { signal?: AbortSignal; truncate?: boolean } = {},
) {
  const body = response.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (options.signal?.aborted) throw options.signal.reason;
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
        await reader.cancel();
        throw new Error("Response exceeds metadata size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
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
    || error.message === "Credentialed URLs cannot be inspected"
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

function normalizePageTitle(document: Document, value: string | null | undefined) {
  if (!value) return null;
  const template = document.createElement("template");
  template.innerHTML = value;
  template.content.querySelectorAll("script, style, template, noscript").forEach((element) => element.remove());
  const plainText = (template.content.textContent ?? "")
    .replace(/[\s\p{Cc}\p{Cf}]+/gu, " ")
    .trim();
  if (!plainText) return null;
  return Array.from(plainText).slice(0, MAX_PAGE_TITLE_CHARACTERS).join("");
}

function readPageTitle(document: Document) {
  const candidates = [
    document.querySelector('meta[property="og:title"]')?.getAttribute("content"),
    document.querySelector('meta[name="twitter:title"]')?.getAttribute("content"),
    document.querySelector("title")?.textContent,
  ];
  for (const candidate of candidates) {
    const title = normalizePageTitle(document, candidate);
    if (title) return title;
  }
  return null;
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
  let result: FetchResult | null = null;
  try {
    result = await fetchWithTimeout(parsePublicHttpUrl(iconHref, options), options, { method: "GET" });
    const { response, signal, url } = result;
    if (!response.ok) return null;
    const contentType = contentTypeBase(response.headers.get("content-type"));
    if (!IMAGE_CONTENT_TYPES.has(contentType)) return null;
    await readLimitedBuffer(response, MAX_ICON_BYTES, { signal });
    return url.href;
  } catch {
    return null;
  } finally {
    await result?.release();
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
  const emptyMetadata: WebsiteMetadata = {
    url: pageUrl.href,
    siteName: knownIcon?.siteName ?? null,
    pageTitle: null,
    iconUrl: knownIcon?.iconDataUrl ?? null,
  };
  // Preview rendering keeps bundled icons zero-fetch; authoring falls through to resolve a title.
  if (knownIcon && (options.purpose ?? "preview") === "preview") {
    return emptyMetadata;
  }

  let pageResult: FetchResult;
  try {
    pageResult = await fetchWithTimeout(pageUrl, options);
  } catch (error) {
    if (isInspectableUrlFailure(error)) throw error;
    return emptyMetadata;
  }
  const { response, url: finalPageUrl } = pageResult;
  let html: string;
  try {
    if (!response.ok) return emptyMetadata;
    const contentType = contentTypeBase(response.headers.get("content-type"));
    if (contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
      return emptyMetadata;
    }
    html = (await readLimitedBuffer(response, MAX_HTML_BYTES, {
      signal: pageResult.signal,
      truncate: true,
    })).toString("utf8");
  } catch {
    return emptyMetadata;
  } finally {
    await pageResult.release();
  }

  const dom = new JSDOM(html, { url: finalPageUrl.href });
  try {
    const document = dom.window.document;
    if ((options.purpose ?? "preview") === "authoring") {
      return {
        url: pageUrl.href,
        siteName: knownIcon?.siteName ?? readSiteName(document),
        pageTitle: readPageTitle(document),
        iconUrl: knownIcon?.iconDataUrl ?? null,
      };
    }
    const declaredIcon = findDeclaredIcon(document, finalPageUrl, options);
    return {
      url: pageUrl.href,
      siteName: knownIcon?.siteName ?? readSiteName(document),
      pageTitle: readPageTitle(document),
      iconUrl: knownIcon?.iconDataUrl
        ?? (declaredIcon ? await validateIconUrl(declaredIcon, options) : null)
        ?? await findImplicitFavicon(finalPageUrl, options)
        ?? await findProviderFavicon(finalPageUrl, options),
    };
  } finally {
    dom.window.close();
  }
}

export async function resolveWebsiteMetadata(value: string, options: WebsiteMetadataOptions = {}): Promise<WebsiteMetadata> {
  const pageUrl = parsePublicHttpUrl(value, options);
  const key = metadataCacheKey(pageUrl, options.purpose ?? "preview");
  if (!options.allowPrivateHosts && !options.fetchImpl) {
    pruneMetadataCache();
    const cached = metadataCache.get(key);
    if (cached) {
      metadataCache.delete(key);
      metadataCache.set(key, cached);
      return cached.value;
    }
    const inflight = metadataInflight.get(key);
    if (inflight) return inflight;

    const request = resolveWebsiteMetadataUncached(pageUrl.href, options)
      .then((metadata) => {
        pruneMetadataCache();
        makeRoomInMetadataCache();
        metadataCache.set(key, {
          expiresAt: Date.now() + (
            metadata.iconUrl || metadata.pageTitle || metadata.siteName
              ? SUCCESS_CACHE_TTL_MS
              : FAILURE_CACHE_TTL_MS
          ),
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
  const result = await fetchWithTimeout(iconUrl, options);
  try {
    const { response, signal } = result;
    if (!response.ok) return null;
    const contentType = contentTypeBase(response.headers.get("content-type"));
    if (!IMAGE_CONTENT_TYPES.has(contentType)) return null;
    const body = await readLimitedBuffer(response, MAX_ICON_BYTES, { signal });
    if (body.length <= 0) return null;
    const icon = { contentType, body };
    if (!options.allowPrivateHosts && !options.fetchImpl) {
      await writeCachedWebsiteIcon(iconUrl.href, icon).catch(() => undefined);
    }
    return icon;
  } finally {
    await result.release();
  }
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
    if (Date.now() - bodyStats.mtimeMs > ICON_DISK_CACHE_TTL_MS) {
      await Promise.all([
        rm(metadataPath, { force: true }),
        rm(bodyPath, { force: true }),
      ]);
      return null;
    }
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

async function pruneWebsiteIconDiskCache(dir: string, protectedBasename: string) {
  const filenames = await readdir(dir);
  const basenames = filenames
    .filter((filename) => /^[a-f0-9]{64}\.json$/u.test(filename))
    .map((filename) => filename.slice(0, -".json".length));
  const entries = await Promise.all(basenames.map(async (basename) => {
    try {
      const [metadataStats, bodyStats] = await Promise.all([
        stat(path.join(dir, `${basename}.json`)),
        stat(path.join(dir, `${basename}.bin`)),
      ]);
      return {
        basename,
        mtimeMs: Math.min(metadataStats.mtimeMs, bodyStats.mtimeMs),
      };
    } catch {
      return { basename, mtimeMs: 0 };
    }
  }));
  const now = Date.now();
  const retained = entries
    .filter((entry) => now - entry.mtimeMs <= ICON_DISK_CACHE_TTL_MS)
    .sort((left, right) => {
      if (left.basename === protectedBasename) return -1;
      if (right.basename === protectedBasename) return 1;
      return right.mtimeMs - left.mtimeMs;
    })
    .slice(0, MAX_ICON_DISK_CACHE_ENTRIES);
  const retainedBasenames = new Set(retained.map((entry) => entry.basename));
  const discarded = entries.filter((entry) => !retainedBasenames.has(entry.basename));
  await Promise.all(discarded.flatMap((entry) => [
    rm(path.join(dir, `${entry.basename}.json`), { force: true }),
    rm(path.join(dir, `${entry.basename}.bin`), { force: true }),
  ]));
}

async function writeCachedWebsiteIcon(iconUrl: string, icon: CachedWebsiteIcon) {
  const { metadataPath, bodyPath } = cachedWebsiteIconPaths(iconUrl);
  const dir = path.dirname(bodyPath);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(bodyPath, icon.body),
    writeFile(metadataPath, `${JSON.stringify({ url: iconUrl, contentType: icon.contentType })}\n`, "utf8"),
  ]);
  await pruneWebsiteIconDiskCache(dir, path.basename(metadataPath, ".json"));
}

export function __clearWebsiteMetadataCacheForTests() {
  metadataCache.clear();
  metadataInflight.clear();
}
