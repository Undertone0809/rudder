import type { DeploymentMode } from "@rudderhq/shared";
import { lookup as dnsLookup } from "node:dns/promises";
import { realpath as fsRealpath } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";

const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export interface McpDeploymentAllowlists {
  httpOrigins: string[];
  stdioCommands: string[][];
  stdioWorkingDirectories: string[];
  stdioEnvironmentNames: string[];
}

export interface McpStdioDeploymentPolicy {
  deploymentMode: DeploymentMode;
  stdioCommands: string[][];
  stdioWorkingDirectories: string[];
  stdioEnvironmentNames: string[];
}

export interface ValidatedMcpStdioTarget {
  command: string;
  cwd: string | undefined;
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

function parseStdioCommandAllowlist(value: string | undefined): string[][] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("RUDDER_MCP_STDIO_COMMAND_ALLOWLIST must be a JSON array of argv arrays");
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((argv) => (
      !Array.isArray(argv)
      || argv.length === 0
      || argv.some((part) => typeof part !== "string" || part.length === 0)
    ))
  ) {
    throw new Error("RUDDER_MCP_STDIO_COMMAND_ALLOWLIST must be a JSON array of non-empty argv arrays");
  }
  return Array.from(
    new Map((parsed as string[][]).map((argv) => [JSON.stringify(argv), argv])).values(),
  );
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
    stdioCommands: parseStdioCommandAllowlist(env.RUDDER_MCP_STDIO_COMMAND_ALLOWLIST),
    stdioWorkingDirectories: parseCsv(env.RUDDER_MCP_STDIO_CWD_ALLOWLIST),
    stdioEnvironmentNames: parseCsv(env.RUDDER_MCP_STDIO_ENV_ALLOWLIST),
  };
}

export async function validateMcpStdioPolicy(
  input: {
    command: string;
    args?: string[];
    cwd?: string;
    environmentNames: string[];
  },
  policy: McpStdioDeploymentPolicy,
  dependencies: {
    realpath?: (value: string) => Promise<string>;
  } = {},
): Promise<ValidatedMcpStdioTarget> {
  if (policy.deploymentMode === "local_trusted") {
    return { command: input.command, cwd: input.cwd };
  }

  if (!path.isAbsolute(input.command)) {
    throw new Error("Authenticated MCP STDIO executable must use an absolute path");
  }
  if (!input.cwd || !path.isAbsolute(input.cwd)) {
    throw new Error("Authenticated MCP STDIO working directory must use an absolute path");
  }

  const resolveRealpath = dependencies.realpath ?? fsRealpath;
  let executableRealpath: string;
  let cwdRealpath: string;
  try {
    [executableRealpath, cwdRealpath] = await Promise.all([
      resolveRealpath(input.command),
      resolveRealpath(input.cwd),
    ]);
  } catch {
    throw new Error("MCP STDIO executable or working directory could not be resolved");
  }

  const requestedArgs = input.args ?? [];
  let commandAllowed = false;
  for (const allowedArgv of policy.stdioCommands) {
    const [allowedExecutable, ...allowedArgs] = allowedArgv;
    if (!allowedExecutable || !path.isAbsolute(allowedExecutable)) continue;
    let allowedExecutableRealpath: string;
    try {
      allowedExecutableRealpath = await resolveRealpath(allowedExecutable);
    } catch {
      continue;
    }
    if (
      allowedExecutableRealpath === executableRealpath
      && allowedArgs.length === requestedArgs.length
      && allowedArgs.every((value, index) => requestedArgs[index] === value)
    ) {
      commandAllowed = true;
      break;
    }
  }
  if (!commandAllowed) {
    throw new Error("MCP STDIO command argv is not allowed by deployment policy");
  }

  const allowedCwdRealpaths = await Promise.all(policy.stdioWorkingDirectories.map(async (allowed) => {
    if (!path.isAbsolute(allowed)) return null;
    try {
      return await resolveRealpath(allowed);
    } catch {
      return null;
    }
  }));
  if (!allowedCwdRealpaths.includes(cwdRealpath)) {
    throw new Error("MCP STDIO working directory is not allowed by deployment policy");
  }
  const allowedEnvironmentNames = new Set(policy.stdioEnvironmentNames);
  if (input.environmentNames.some((name) => !allowedEnvironmentNames.has(name))) {
    throw new Error("MCP STDIO environment name is not allowed by deployment policy");
  }
  return {
    command: executableRealpath,
    cwd: cwdRealpath,
  };
}

const blockedAddresses = new BlockList();
const globallyRoutableIpv6 = new BlockList();
globallyRoutableIpv6.addSubnet("2000::", 3, "ipv6");
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
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  // Conservative snapshot of the IANA IPv6 Special-Purpose Address Registry
  // (last updated 2025-10-09). Only 2000::/3 is eligible above, and these
  // special-purpose subranges remain denied until a deliberate registry review.
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
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

function parseIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const octets = normalized.slice(lastColon + 1).split(".").map(Number);
    if (
      octets.length !== 4
      || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    normalized = `${normalized.slice(0, lastColon)}:${(
      (octets[0]! << 8) | octets[1]!
    ).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word))
    ? words
    : null;
}

function isIpv4TranslatedAddress(address: string): boolean {
  const words = parseIpv6Words(address);
  // Node's BlockList normalizes this translated prefix as IPv4-mapped,
  // so match its 96-bit IPv6 prefix explicitly without affecting IPv4.
  return Boolean(
    words
    && words.slice(0, 4).every((word) => word === 0)
    && words[4] === 0xffff
    && words[5] === 0,
  );
}

export function isBlockedMcpNetworkAddress(address: string): boolean {
  const mappedIpv4 = unwrapMappedIpv4(address);
  if (mappedIpv4) return blockedAddresses.check(mappedIpv4, "ipv4");
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) {
    return (
      !globallyRoutableIpv6.check(address, "ipv6")
      || isIpv4TranslatedAddress(address)
      || blockedAddresses.check(address, "ipv6")
    );
  }
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
  return results.map((result) => {
    if (result.family !== 4 && result.family !== 6) {
      throw new Error("Managed MCP DNS resolution returned an invalid address family");
    }
    return {
      address: result.address,
      family: result.family,
    };
  });
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
  if (addresses.some((answer) => isIP(answer.address) !== answer.family)) {
    throw new Error("Managed MCP DNS answer is not a valid address for its family");
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
