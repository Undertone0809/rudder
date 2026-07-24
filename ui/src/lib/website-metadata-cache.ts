import {
  websiteMetadataApi,
  type WebsiteMetadata,
  type WebsiteMetadataPurpose,
} from "../api/websiteMetadata";

interface CachedWebsiteMetadata {
  expiresAt: number;
  value: WebsiteMetadata;
}

const MAX_METADATA_CACHE_ENTRIES = 256;
const METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const metadataCache = new Map<string, CachedWebsiteMetadata>();
const metadataInflight = new Map<string, Promise<WebsiteMetadata>>();
let cacheGeneration = 0;

function normalizedCacheUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function cacheKey(url: string, purpose: WebsiteMetadataPurpose) {
  return JSON.stringify([normalizedCacheUrl(url), purpose]);
}

function isObviouslyPrivateIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => (
    !Number.isInteger(octet) || octet < 0 || octet > 255
  ))) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (
      b === 0
      || b === 168
      || (b === 0 && c === 2)
    ))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

export function canRequestWebsiteMetadata(
  value: string,
  currentOrigin = typeof window === "undefined" ? null : window.location.origin,
) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (currentOrigin && url.origin === currentOrigin) return false;
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (!hostname || hostname.includes(":")) return false;
    if (
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".lan")
      || hostname.endsWith(".home")
      || hostname.endsWith(".internal")
      || hostname.endsWith(".corp")
      || hostname.endsWith(".intranet")
      || (!hostname.includes(".") && !/^\d+(?:\.\d+){3}$/u.test(hostname))
      || isObviouslyPrivateIpv4(hostname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function cachedMetadata(key: string) {
  const entry = metadataCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    metadataCache.delete(key);
    return null;
  }
  metadataCache.delete(key);
  metadataCache.set(key, entry);
  return entry.value;
}

function cacheMetadata(
  key: string,
  purpose: WebsiteMetadataPurpose,
  metadata: WebsiteMetadata,
) {
  const value = purpose === "authoring"
    ? { ...metadata, iconUrl: null }
    : metadata;
  metadataCache.delete(key);
  metadataCache.set(key, {
    expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
    value,
  });
  while (metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
    const oldest = metadataCache.keys().next().value;
    if (typeof oldest !== "string") break;
    metadataCache.delete(oldest);
  }
  return value;
}

export function getWebsiteMetadata(
  url: string,
  purpose: WebsiteMetadataPurpose,
): Promise<WebsiteMetadata> {
  if (!canRequestWebsiteMetadata(url)) {
    return Promise.resolve({
      url,
      siteName: null,
      pageTitle: null,
      iconUrl: null,
    });
  }
  const key = cacheKey(url, purpose);
  const cached = cachedMetadata(key);
  if (cached) return Promise.resolve(cached);
  const inflight = metadataInflight.get(key);
  if (inflight) return inflight;

  const requestGeneration = cacheGeneration;
  const request = Promise.resolve()
    .then(() => websiteMetadataApi.get(url, purpose))
    .then((metadata) => {
      if (requestGeneration === cacheGeneration) {
        return cacheMetadata(key, purpose, metadata);
      }
      return purpose === "authoring"
        ? { ...metadata, iconUrl: null }
        : metadata;
    })
    .finally(() => {
      if (metadataInflight.get(key) === request) {
        metadataInflight.delete(key);
      }
    });
  metadataInflight.set(key, request);
  return request;
}

export function __clearWebsiteMetadataCacheForTests() {
  cacheGeneration += 1;
  metadataCache.clear();
  metadataInflight.clear();
}
