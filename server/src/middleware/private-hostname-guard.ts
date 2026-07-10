import type { Request, RequestHandler } from "express";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

export function extractHostnameFromHostHeader(rawHost: string | undefined): string | null {
  const raw = rawHost?.trim();
  if (!raw) return null;

  try {
    return normalizeHostname(new URL(`http://${raw}`).hostname);
  } catch {
    return normalizeHostname(raw);
  }
}

function extractHostname(req: Request): string | null {
  // Do not trust X-Forwarded-Host here. This server does not configure a
  // trusted proxy boundary, so a direct client could otherwise spoof it and
  // bypass the DNS-rebinding guard.
  return extractHostnameFromHostHeader(req.header("host"));
}

function normalizeAllowedHostnames(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = normalizeHostname(value);
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

export function resolvePrivateHostnameAllowSet(opts: { allowedHostnames: string[]; bindHost: string }): Set<string> {
  const configuredAllow = normalizeAllowedHostnames(opts.allowedHostnames);
  const bindHost = normalizeHostname(opts.bindHost);
  const allowSet = new Set<string>(configuredAllow);

  if (bindHost && bindHost !== "0.0.0.0") {
    allowSet.add(bindHost);
  }
  allowSet.add("localhost");
  allowSet.add("127.0.0.1");
  allowSet.add("::1");
  return allowSet;
}

export function isPrivateHostnameAllowed(rawHost: string | undefined, allowSet: ReadonlySet<string>): boolean {
  const hostname = extractHostnameFromHostHeader(rawHost);
  return hostname !== null && (isLoopbackHostname(hostname) || allowSet.has(hostname));
}

export function isSameOriginHost(origin: string | undefined, rawHost: string | undefined): boolean {
  if (!origin || !rawHost) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (
      (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:")
      || parsedOrigin.username
      || parsedOrigin.password
      || parsedOrigin.pathname !== "/"
      || parsedOrigin.search
      || parsedOrigin.hash
    ) {
      return false;
    }
    const parsedHost = new URL(`${parsedOrigin.protocol}//${rawHost}`);
    return parsedOrigin.host.toLowerCase() === parsedHost.host.toLowerCase();
  } catch {
    return false;
  }
}

function blockedHostnameMessage(hostname: string): string {
  return (
    `Hostname '${hostname}' is not allowed for this Rudder instance. ` +
    `If you want to allow this hostname, please run pnpm rudder allowed-hostname ${hostname}`
  );
}

export function privateHostnameGuard(opts: {
  enabled: boolean;
  allowedHostnames: string[];
  bindHost: string;
}): RequestHandler {
  if (!opts.enabled) {
    return (_req, _res, next) => next();
  }

  const allowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  return (req, res, next) => {
    const hostname = extractHostname(req);
    const wantsJson = req.path.startsWith("/api") || req.accepts(["json", "html", "text"]) === "json";

    if (!hostname) {
      const error = "Missing Host header. If you want to allow a hostname, run pnpm rudder allowed-hostname <host>.";
      if (wantsJson) {
        res.status(403).json({ error });
      } else {
        res.status(403).type("text/plain").send(error);
      }
      return;
    }

    if (isPrivateHostnameAllowed(req.header("host"), allowSet)) {
      next();
      return;
    }

    const error = blockedHostnameMessage(hostname);
    if (wantsJson) {
      res.status(403).json({ error });
    } else {
      res.status(403).type("text/plain").send(error);
    }
  };
}
