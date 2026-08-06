import { asNumber, asString, parseObject } from "@rudderhq/agent-runtime-utils/server-utils";
import dns from "node:dns/promises";

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const HERMES_SUPPORTED_VERSIONS = ["0.18.2", "0.19.1"] as const;

function normalizedHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function baseUrl(value: unknown): URL | null {
  const raw = asString(value, "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (!isLoopbackHostname(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Resolve the configured loopback name before every trust-domain request. */
export async function preflightBaseUrl(base: URL): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isLoopbackHostname(base.hostname)) {
    return { ok: false, reason: "Hermes endpoint must be loopback-only." };
  }
  if (base.username || base.password || base.search || base.hash) {
    return { ok: false, reason: "Hermes endpoint must not contain userinfo, query, or fragment data." };
  }
  if (normalizedHostname(base.hostname) === "localhost") {
    try {
      const addresses = await dns.lookup(base.hostname, { all: true, verbatim: true });
      if (addresses.length === 0 || addresses.some((entry) => !isLoopbackHostname(entry.address))) {
        return { ok: false, reason: "Hermes localhost endpoint did not resolve exclusively to loopback addresses." };
      }
    } catch {
      return { ok: false, reason: "Hermes localhost endpoint could not be resolved." };
    }
  }
  return { ok: true };
}

export function endpoint(base: URL, path: string): URL {
  const root = new URL(base.toString());
  root.pathname = `${root.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  root.search = "";
  return root;
}

function secret(config: Record<string, unknown>): string | null {
  for (const key of ["apiKey", "authToken", "token"]) {
    const value = asString(config[key], "").trim();
    if (value) return value;
  }
  return null;
}

export function hasBearerAuth(config: Record<string, unknown>): boolean {
  const value = asString(requestHeaders(config).authorization, "").trim();
  return /^bearer\s+\S+$/i.test(value);
}

export function requestHeaders(config: Record<string, unknown>, extra?: Record<string, string>): Record<string, string> {
  const configured = parseObject(config.headers) ?? {};
  const headers: Record<string, string> = { accept: "application/json", ...extra };
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value === "string" && value.trim()) headers[key] = value;
  }
  const token = secret(config);
  if (token && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    headers.authorization = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  }
  return headers;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error(`Hermes response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`Hermes response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return { text: text.slice(0, MAX_RESPONSE_BYTES) };
  }
}

export async function requestJson(
  url: URL,
  config: Record<string, unknown>,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      headers: { ...requestHeaders(config), ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    const body = await readJson(response);
    return { response, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function textFrom(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["output", "content", "text", "message", "summary", "delta"]) {
    const candidate = textFrom(record[key]);
    if (candidate) return candidate;
  }
  if (Array.isArray(record.content)) {
    const text = record.content.map((entry) => textFrom(entry)).filter(Boolean).join("\n");
    return text || null;
  }
  return null;
}

export function positiveMs(value: unknown, fallback: number): number {
  const parsed = asNumber(value, fallback);
  return parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
}
