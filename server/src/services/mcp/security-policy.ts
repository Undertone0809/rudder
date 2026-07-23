import type { DeploymentMode } from "@rudderhq/shared";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";

const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export interface McpDeploymentAllowlists {
  httpOrigins: string[];
  stdioExecutables: string[];
  stdioWorkingDirectories: string[];
  stdioEnvironmentNames: string[];
}

export interface McpStdioDeploymentPolicy {
  deploymentMode: DeploymentMode;
  stdioExecutables: string[];
  stdioWorkingDirectories: string[];
  stdioEnvironmentNames: string[];
}

export interface McpDnsAnswer {
  address: string;
  family: 4 | 6;
}

export type McpDnsLookup = (hostname: string) => Promise<McpDnsAnswer[]>;

export interface ResolvedMcpHttpTarget {
  url: URL;
  resolvedAddress: string;
  hostHeader: string;
  tlsServername?: string;
  useTls: boolean;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(new Set(
    value.split(",").map((item) => item.trim()).filter(Boolean),
  ));
}

function normalizeAllowlistedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RUDDER_MCP_HTTP_ALLOWLIST entries must be valid origins");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("RUDDER_MCP_HTTP_ALLOWLIST entries must contain only an HTTP(S) origin");
  }
  return url.origin;
}

export function parseMcpDeploymentPolicyEnv(
  env: Record<string, string | undefined>,
): McpDeploymentAllowlists {
  return {
    httpOrigins: parseCsv(env.RUDDER_MCP_HTTP_ALLOWLIST).map(normalizeAllowlistedOrigin),
    stdioExecutables: parseCsv(env.RUDDER_MCP_STDIO_EXECUTABLE_ALLOWLIST),
    stdioWorkingDirectories: parseCsv(env.RUDDER_MCP_STDIO_CWD_ALLOWLIST),
    stdioEnvironmentNames: parseCsv(env.RUDDER_MCP_STDIO_ENV_ALLOWLIST),
  };
}

function exactPathMatch(value: string, allowlist: string[]): boolean {
  const normalized = path.resolve(value);
  return allowlist.some((allowed) => path.resolve(allowed) === normalized);
}

export function validateMcpStdioPolicy(
  input: {
    command: string;
    cwd?: string;
    environmentNames: string[];
  },
  policy: McpStdioDeploymentPolicy,
): void {
  if (policy.deploymentMode === "local_trusted") return;

  if (!policy.stdioExecutables.includes(input.command)) {
    throw new Error("MCP STDIO executable is not allowed by deployment policy");
  }
  if (!input.cwd || !exactPathMatch(input.cwd, policy.stdioWorkingDirectories)) {
    throw new Error("MCP STDIO working directory is not allowed by deployment policy");
  }
  const allowedEnvironmentNames = new Set(policy.stdioEnvironmentNames);
  if (input.environmentNames.some((name) => !allowedEnvironmentNames.has(name))) {
    throw new Error("MCP STDIO environment name is not allowed by deployment policy");
  }
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function unwrapMappedIpv4(address: string): string | null {
  const match = address.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match?.[1] ?? null;
}

export function isBlockedMcpNetworkAddress(address: string): boolean {
  const mappedIpv4 = unwrapMappedIpv4(address);
  if (mappedIpv4) return blockedAddresses.check(mappedIpv4, "ipv4");
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
}

function parseMcpTargetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Managed MCP target URL is invalid");
  }
  if (url.username || url.password) {
    throw new Error("Managed MCP target URL cannot include user information");
  }
  if (url.hash) {
    throw new Error("Managed MCP target URL cannot include a fragment");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Managed MCP supports only Streamable HTTP over HTTP(S), not legacy SSE");
  }
  return url;
}

const defaultLookup: McpDnsLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({
    address: result.address,
    family: result.family,
  }));
};

async function lookupWithTimeout(
  hostname: string,
  lookup: McpDnsLookup,
  timeoutMs: number,
): Promise<McpDnsAnswer[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Managed MCP DNS lookup timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "Managed MCP DNS lookup timed out") {
      throw error;
    }
    throw new Error("Managed MCP DNS resolution failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveMcpHttpTarget(
  value: string,
  options: {
    allowedOrigins: string[];
    curatedOrigin?: string;
    lookup?: McpDnsLookup;
    dnsTimeoutMs?: number;
  },
): Promise<ResolvedMcpHttpTarget> {
  const url = parseMcpTargetUrl(value);
  if (options.curatedOrigin && url.origin !== options.curatedOrigin) {
    throw new Error("Managed MCP curated provider URL does not match its registry origin");
  }

  const allowedOrigins = new Set(options.allowedOrigins.map(normalizeAllowlistedOrigin));
  const explicitlyAllowed = allowedOrigins.has(url.origin);
  if (url.protocol !== "https:" && !explicitlyAllowed) {
    throw new Error("Managed MCP target must use public HTTPS unless its exact origin is allowlisted");
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = await lookupWithTimeout(
    hostname,
    options.lookup ?? defaultLookup,
    options.dnsTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS,
  );
  if (addresses.length === 0) {
    throw new Error("Managed MCP DNS resolution returned no addresses");
  }
  if (!explicitlyAllowed && addresses.some((answer) => isBlockedMcpNetworkAddress(answer.address))) {
    throw new Error("Managed MCP target resolved to a blocked network address");
  }

  const selected = addresses[0]!;
  return {
    url,
    resolvedAddress: selected.address,
    hostHeader: url.host,
    tlsServername: url.protocol === "https:" && isIP(hostname) === 0
      ? hostname
      : undefined,
    useTls: url.protocol === "https:",
  };
}

const forbiddenExactHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

export function assertSafeMcpHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    const normalized = name.trim().toLowerCase();
    if (
      forbiddenExactHeaders.has(normalized)
      || normalized.startsWith("proxy-")
      || normalized === "forwarded"
      || normalized.startsWith("x-forwarded-")
    ) {
      throw new Error(`Managed MCP header "${name}" is controlled by Rudder`);
    }
  }
}

export function assertSafeMcpCredentialHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    const normalized = name.trim().toLowerCase();
    if (
      (forbiddenExactHeaders.has(normalized)
        && normalized !== "authorization"
        && normalized !== "x-api-key")
      || normalized.startsWith("proxy-")
      || normalized === "forwarded"
      || normalized.startsWith("x-forwarded-")
    ) {
      throw new Error(`Managed MCP credential header "${name}" is controlled by Rudder`);
    }
  }
}
