import { resolveKnownWebsiteIcon } from "@rudderhq/shared";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveRudderInstanceRoot } from "../home-paths.js";
import {
  isNonPublicIpAddress,
  isPrivateHostname,
  isPublicDnsHostname,
} from "../network/public-address.js";

export interface WebsiteMetadata {
  url: string;
  siteName: string | null;
  iconUrl: string | null;
}

export interface WebsiteMetadataOptions {
  allowPrivateHosts?: boolean;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Test-only transport hook that still exercises production DNS validation. */
  pinnedFetchImpl?: (
    url: URL,
    init: RequestInit,
    addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>,
  ) => Promise<Response>;
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
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

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

export type PublicHttpResolvedAddress = { address: string; family: 4 | 6 };

async function resolvePublicConnectionAddresses(
  url: URL,
  options: WebsiteMetadataOptions,
): Promise<PublicHttpResolvedAddress[] | null> {
  if (options.allowPrivateHosts || options.fetchImpl) return null;

  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0
    || addresses.some((address) => isNonPublicIpAddress(address.address))
  ) {
    throw new Error("Private network URLs cannot be inspected");
  }
  return addresses.map((address) => ({
    address: address.address,
    family: address.family as 4 | 6,
  }));
}

function pinnedRequestBody(init: RequestInit) {
  if (init.body === undefined || init.body === null) return undefined;
  return typeof init.body === "string" ? init.body : String(init.body);
}

function requestHeaders(init: RequestInit, url: URL, body: string | undefined) {
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  headers.set("accept-encoding", "identity");
  headers.set("connection", "close");
  if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }
  return Object.fromEntries(headers.entries());
}

function requestPinnedAddress(
  url: URL,
  init: RequestInit,
  address: PublicHttpResolvedAddress,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const body = pinnedRequestBody(init);
    const commonOptions: RequestOptions = {
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers: requestHeaders(init, url, body),
      signal: init.signal ?? undefined,
      agent: false,
    };
    const handleResponse = (incoming: IncomingMessage) => {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const status = incoming.statusCode ?? 500;
      const responseHasBody = init.method !== "HEAD" && ![101, 204, 205, 304].includes(status);
      const body = responseHasBody
        ? Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>
        : null;
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers,
      }));
    };
    const request = url.protocol === "https:"
      ? httpsRequest({
          ...commonOptions,
          servername: isIP(url.hostname.replace(/^\[|\]$/gu, "")) ? undefined : url.hostname,
        } satisfies HttpsRequestOptions, handleResponse)
      : httpRequest(commonOptions, handleResponse);
    request.once("error", reject);
    request.end(body);
  });
}

async function fetchPinnedPublicUrl(
  url: URL,
  init: RequestInit,
  addresses: PublicHttpResolvedAddress[],
): Promise<Response> {
  let lastError: unknown = null;
  for (const address of addresses) {
    try {
      return await requestPinnedAddress(url, init, address);
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Website metadata connection failed");
}

export interface PublicHttpFetchResult {
  response: Response;
  url: URL;
}

/**
 * Fetch one HTTP(S) URL after rejecting every non-public DNS answer and pinning
 * the connection to the validated address set. Redirects are deliberately
 * returned to the caller so each hop can be authorized independently.
 */
export async function fetchPublicHttpUrlOnce(
  url: URL,
  options: WebsiteMetadataOptions = {},
  init: RequestInit = {},
): Promise<PublicHttpFetchResult> {
  const currentUrl = parsePublicHttpUrl(url.href, options);
  const addresses = await resolvePublicConnectionAddresses(currentUrl, options);
  const requestInit: RequestInit = {
    ...init,
    redirect: "manual",
  };
  const response = options.fetchImpl
    ? await options.fetchImpl(currentUrl.href, requestInit)
    : addresses && options.pinnedFetchImpl
      ? await options.pinnedFetchImpl(currentUrl, requestInit, addresses)
      : addresses
        ? await fetchPinnedPublicUrl(currentUrl, requestInit, addresses)
        : await fetch(currentUrl.href, requestInit);
  return { response, url: currentUrl };
}

async function fetchWithTimeout(
  url: URL,
  options: WebsiteMetadataOptions,
  init?: RequestInit,
): Promise<PublicHttpFetchResult> {
  let currentUrl = parsePublicHttpUrl(url.href, options);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const requestInit: RequestInit = {
      redirect: "manual",
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/*,*/*;q=0.8",
        "user-agent": "RudderWebsiteMetadata/1.0",
        ...(init?.headers ?? {}),
      },
    };
    const fetched = await fetchPublicHttpUrlOnce(currentUrl, options, requestInit);
    const { response } = fetched;

    if (response.status < 300 || response.status >= 400) return fetched;
    const location = response.headers.get("location");
    if (!location) return fetched;
    await response.body?.cancel().catch(() => undefined);
    currentUrl = parsePublicHttpUrl(new URL(location, currentUrl).href, options);
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
        await reader.cancel();
        throw new Error("Response exceeds metadata size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export interface PublicHttpTextOptions extends WebsiteMetadataOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  headers?: HeadersInit;
  userAgent?: string;
}

export interface PublicHttpTextResult {
  ok: boolean;
  status: number;
  text: string;
  url: URL;
}

/**
 * Fetch bounded public text while validating and pinning every redirect hop.
 * This is shared by features that accept administrator- or tenant-supplied
 * URLs and must never reach loopback, metadata, or private network services.
 */
export async function fetchPublicHttpText(
  value: string | URL,
  options: PublicHttpTextOptions = {},
): Promise<PublicHttpTextResult> {
  const timeoutMs = Math.max(1, Math.min(30_000, Math.floor(options.timeoutMs ?? 10_000)));
  const maxRedirects = Math.max(0, Math.min(10, Math.floor(options.maxRedirects ?? 5)));
  const maxBytes = Math.max(1, Math.min(16 * 1024 * 1024, Math.floor(options.maxBytes ?? 1024 * 1024)));
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "text/markdown,text/plain,application/json;q=0.9,*/*;q=0.1");
  }
  headers.set("user-agent", options.userAgent ?? "RudderPublicTextFetcher/1.0");

  const performFetch = async () => {
    let currentUrl = parsePublicHttpUrl(value instanceof URL ? value.href : value, options);
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const fetched = await fetchPublicHttpUrlOnce(
        currentUrl,
        options,
        {
          method: "GET",
          redirect: "manual",
          signal,
          headers,
        },
      );
      const { response } = fetched;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: response.status, text: "", url: fetched.url };
        }
        await response.body?.cancel().catch(() => undefined);
        if (redirectCount === maxRedirects) {
          throw new Error("Public HTTP redirect limit exceeded");
        }
        currentUrl = parsePublicHttpUrl(new URL(location, fetched.url).href, options);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, status: response.status, text: "", url: fetched.url };
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Response exceeds public text size limit");
      }
      let body: Buffer;
      try {
        body = await readLimitedBuffer(response, maxBytes);
      } catch (error) {
        if (error instanceof Error && error.message === "Response exceeds metadata size limit") {
          throw new Error("Response exceeds public text size limit");
        }
        throw error;
      }
      return {
        ok: true,
        status: response.status,
        text: body.toString("utf8"),
        url: fetched.url,
      };
    }
    throw new Error("Public HTTP redirect limit exceeded");
  };

  let rejectOnTimeout: ((reason?: unknown) => void) | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectOnTimeout = reject;
  });
  const onTimeout = () => rejectOnTimeout?.(signal.reason ?? new Error("Public HTTP request timed out"));
  if (signal.aborted) onTimeout();
  else signal.addEventListener("abort", onTimeout, { once: true });
  try {
    return await Promise.race([performFetch(), timeoutPromise]);
  } finally {
    signal.removeEventListener("abort", onTimeout);
  }
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

  let pageResult: PublicHttpFetchResult;
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
