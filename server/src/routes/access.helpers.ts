import {
  joinRequests
} from "@rudderhq/db";
import type { Request } from "express";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export const INVITE_TOKEN_PREFIX = "pcp_invite_";
export const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const INVITE_TOKEN_SUFFIX_LENGTH = 8;
export const INVITE_TOKEN_MAX_RETRIES = 5;
export const COMPANY_INVITE_TTL_MS = 10 * 60 * 1000;

export function createInviteToken() {
  const bytes = randomBytes(INVITE_TOKEN_SUFFIX_LENGTH);
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += INVITE_TOKEN_ALPHABET[bytes[idx]! % INVITE_TOKEN_ALPHABET.length];
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

export function createClaimSecret() {
  return `pcp_claim_${randomBytes(24).toString("hex")}`;
}

export function companyInviteExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + COMPANY_INVITE_TTL_MS);
}

export function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function requestBaseUrl(req: Request) {
  const forwardedProto = req.header("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  const host =
    req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (!host) return "";
  return `${proto}://${host}`;
}

export function buildCliAuthApprovalPath(challengeId: string, token: string) {
  return `/cli-auth/${challengeId}?token=${encodeURIComponent(token)}`;
}

export function readSkillMarkdown(skillName: string): string | null {
  const normalized = skillName.trim().toLowerCase();
  if (
    normalized !== "rudder" &&
    normalized !== "rudder-create-agent" &&
    // TODO 2026-04-12 15:42:09: disabled: not used yet; will be re-enabled when plugin scaffold is ready
    // normalized !== "rudder-create-plugin" &&
    normalized !== "para-memory-files"
  )
    return null;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../resources/bundled-skills", normalized, "SKILL.md"), // published: dist/routes/ -> server/resources/bundled-skills/
    path.resolve(process.cwd(), "server/resources/bundled-skills", normalized, "SKILL.md"), // cwd (e.g. monorepo root)
    path.resolve(moduleDir, "../../../server/resources/bundled-skills", normalized, "SKILL.md"), // dev: src/routes/ -> repo root/server/resources/bundled-skills/
    path.resolve(moduleDir, "../../.agents/skills", normalized, "SKILL.md"), // legacy published fallback
    path.resolve(process.cwd(), ".agents/skills", normalized, "SKILL.md"), // legacy cwd fallback
    path.resolve(moduleDir, "../../../.agents/skills", normalized, "SKILL.md"), // legacy dev fallback
    path.resolve(moduleDir, "../../skills", normalized, "SKILL.md"), // legacy fallback
    path.resolve(process.cwd(), "skills", normalized, "SKILL.md"), // legacy fallback
    path.resolve(moduleDir, "../../../skills", normalized, "SKILL.md"), // legacy fallback
  ];
  for (const skillPath of candidates) {
    try {
      return fs.readFileSync(skillPath, "utf8");
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

/** Resolve the Rudder repo skill directory (built-in / managed skills). */
export function resolveRudderSkillsDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../resources/bundled-skills"), // published
    path.resolve(process.cwd(), "server/resources/bundled-skills"), // cwd (monorepo root)
    path.resolve(moduleDir, "../../../server/resources/bundled-skills"), // dev
    path.resolve(moduleDir, "../../.agents/skills"), // legacy published fallback
    path.resolve(process.cwd(), ".agents/skills"),   // legacy cwd fallback
    path.resolve(moduleDir, "../../../.agents/skills"), // legacy dev fallback
    path.resolve(moduleDir, "../../skills"),         // legacy fallback
    path.resolve(process.cwd(), "skills"),          // legacy fallback
    path.resolve(moduleDir, "../../../skills"),     // legacy fallback
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* skip */ }
  }
  return null;
}

/** Parse YAML frontmatter from a SKILL.md file to extract the description. */
export function parseSkillFrontmatter(markdown: string): { description: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { description: "" };
  const yaml = match[1];
  // Extract description — handles both single-line and multi-line YAML values
  const descMatch = yaml.match(
    /^description:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|[|]\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?(.*?)["']?\s*$)/m
  );
  if (!descMatch) return { description: "" };
  const raw = descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "";
  return {
    description: raw
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean)
      .join(" ")
      .trim(),
  };
}

export interface AvailableSkill {
  name: string;
  description: string;
  isRudderManaged: boolean;
}

/** Discover user-installed Claude Code skills from ~/.claude/skills/. */
export function listAvailableSkills(): AvailableSkill[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const claudeSkillsDir = path.join(homeDir, ".claude", "skills");
  const rudderSkillsDir = resolveRudderSkillsDir();

  // Build set of Rudder-managed skill names
  const rudderSkillNames = new Set<string>();
  if (rudderSkillsDir) {
    try {
      for (const entry of fs.readdirSync(rudderSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) rudderSkillNames.add(entry.name);
      }
    } catch { /* skip */ }
  }

  const skills: AvailableSkill[] = [];

  try {
    const entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(claudeSkillsDir, entry.name, "SKILL.md");
      let description = "";
      try {
        const md = fs.readFileSync(skillMdPath, "utf8");
        description = parseSkillFrontmatter(md).description;
      } catch { /* no SKILL.md or unreadable */ }
      skills.push({
        name: entry.name,
        description,
        isRudderManaged: rudderSkillNames.has(entry.name),
      });
    }
  } catch { /* ~/.claude/skills/ doesn't exist */ }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export function toJoinRequestResponse(row: typeof joinRequests.$inferSelect) {
  const { claimSecretHash: _claimSecretHash, ...safe } = row;
  return safe;
}

export type JoinDiagnostic = {
  code: string;
  level: "info" | "warn";
  message: string;
  hint?: string;
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

export function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1
      ? trimmed.slice(1, end).toLowerCase()
      : trimmed.toLowerCase();
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon > -1) return trimmed.slice(0, firstColon).toLowerCase();
  return trimmed.toLowerCase();
}

export function normalizeHeaderValue(
  value: unknown,
  depth: number = 0
): string | null {
  const direct = nonEmptyTrimmedString(value);
  if (direct) return direct;
  if (!isPlainObject(value) || depth >= 3) return null;

  const candidateKeys = [
    "value",
    "token",
    "secret",
    "apiKey",
    "api_key",
    "auth",
    "authToken",
    "auth_token",
    "accessToken",
    "access_token",
    "authorization",
    "bearer",
    "header",
    "raw",
    "text",
    "string"
  ];
  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const normalized = normalizeHeaderValue(
      (value as Record<string, unknown>)[key],
      depth + 1
    );
    if (normalized) return normalized;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [singleKey, singleValue] = entries[0];
    const normalizedKey = singleKey.trim().toLowerCase();
    if (
      normalizedKey !== "type" &&
      normalizedKey !== "version" &&
      normalizedKey !== "secretid" &&
      normalizedKey !== "secret_id"
    ) {
      const normalized = normalizeHeaderValue(singleValue, depth + 1);
      if (normalized) return normalized;
    }
  }

  return null;
}

export function extractHeaderEntries(input: unknown): Array<[string, unknown]> {
  if (isPlainObject(input)) {
    return Object.entries(input);
  }
  if (!Array.isArray(input)) {
    return [];
  }

  const entries: Array<[string, unknown]> = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      const key = nonEmptyTrimmedString(item[0]);
      if (!key) continue;
      entries.push([key, item[1]]);
      continue;
    }
    if (!isPlainObject(item)) continue;

    const mapped = item as Record<string, unknown>;
    const explicitKey =
      nonEmptyTrimmedString(mapped.key) ??
      nonEmptyTrimmedString(mapped.name) ??
      nonEmptyTrimmedString(mapped.header);
    if (explicitKey) {
      const explicitValue = Object.prototype.hasOwnProperty.call(
        mapped,
        "value"
      )
        ? mapped.value
        : Object.prototype.hasOwnProperty.call(mapped, "token")
        ? mapped.token
        : Object.prototype.hasOwnProperty.call(mapped, "secret")
        ? mapped.secret
        : mapped;
      entries.push([explicitKey, explicitValue]);
      continue;
    }

    const singleEntry = Object.entries(mapped);
    if (singleEntry.length === 1) {
      entries.push(singleEntry[0] as [string, unknown]);
    }
  }

  return entries;
}

export function normalizeHeaderMap(
  input: unknown
): Record<string, string> | undefined {
  const entries = extractHeaderEntries(input);
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalizedValue = normalizeHeaderValue(value);
    if (!normalizedValue) continue;
    const trimmedKey = key.trim();
    const trimmedValue = normalizedValue.trim();
    if (!trimmedKey || !trimmedValue) continue;
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function headerMapHasKeyIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): boolean {
  const normalizedTarget = targetKey.trim().toLowerCase();
  return Object.keys(headers).some(
    (key) => key.trim().toLowerCase() === normalizedTarget
  );
}

export function headerMapGetIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): string | null {
  const normalizedTarget = targetKey.trim().toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.trim().toLowerCase() === normalizedTarget
  );
  if (!key) return null;
  const value = headers[key];
  return typeof value === "string" ? value : null;
}

export function tokenFromAuthorizationHeader(rawHeader: string | null): string | null {
  const trimmed = nonEmptyTrimmedString(rawHeader);
  if (!trimmed) return null;
  const bearerMatch = trimmed.match(/^bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return nonEmptyTrimmedString(bearerMatch[1]);
  }
  return trimmed;
}

export function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

export function generateEd25519PrivateKeyPem(): string {
  const generated = generateKeyPairSync("ed25519");
  return generated.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}

export function buildJoinDefaultsPayloadForAccept(input: {
  agentRuntimeType: string | null;
  defaultsPayload: unknown;
  rudderApiUrl?: unknown;
  paperclipApiUrl?: unknown;
  inboundOpenClawAuthHeader?: string | null;
  inboundOpenClawTokenHeader?: string | null;
}): unknown {
  if (input.agentRuntimeType !== "openclaw_gateway") {
    return input.defaultsPayload;
  }

  const merged = isPlainObject(input.defaultsPayload)
    ? { ...(input.defaultsPayload as Record<string, unknown>) }
    : ({} as Record<string, unknown>);

  if (!nonEmptyTrimmedString(merged.rudderApiUrl)) {
    const legacyPaperclipApiUrl = nonEmptyTrimmedString(input.paperclipApiUrl);
    if (legacyPaperclipApiUrl) merged.rudderApiUrl = legacyPaperclipApiUrl;
  }
  const mergedHeaders = normalizeHeaderMap(merged.headers) ?? {};

  const inboundOpenClawAuthHeader = nonEmptyTrimmedString(
    input.inboundOpenClawAuthHeader
  );
  const inboundOpenClawTokenHeader = nonEmptyTrimmedString(
    input.inboundOpenClawTokenHeader
  );
  if (
    inboundOpenClawTokenHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-token")
  ) {
    mergedHeaders["x-openclaw-token"] = inboundOpenClawTokenHeader;
  }
  if (
    inboundOpenClawAuthHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-auth")
  ) {
    mergedHeaders["x-openclaw-auth"] = inboundOpenClawAuthHeader;
  }

  if (Object.keys(mergedHeaders).length > 0) {
    merged.headers = mergedHeaders;
  } else {
    delete merged.headers;
  }

  const discoveredToken =
    headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-token") ??
    headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-auth") ??
    tokenFromAuthorizationHeader(
      headerMapGetIgnoreCase(mergedHeaders, "authorization")
    );
  if (
    discoveredToken &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-token")
  ) {
    mergedHeaders["x-openclaw-token"] = discoveredToken;
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

export function mergeJoinDefaultsPayloadForReplay(
  existingDefaultsPayload: unknown,
  nextDefaultsPayload: unknown
): unknown {
  if (
    !isPlainObject(existingDefaultsPayload) &&
    !isPlainObject(nextDefaultsPayload)
  ) {
    return nextDefaultsPayload ?? existingDefaultsPayload;
  }
  if (!isPlainObject(existingDefaultsPayload)) {
    return nextDefaultsPayload;
  }
  if (!isPlainObject(nextDefaultsPayload)) {
    return existingDefaultsPayload;
  }

  const merged: Record<string, unknown> = {
    ...(existingDefaultsPayload as Record<string, unknown>),
    ...(nextDefaultsPayload as Record<string, unknown>)
  };

  const existingHeaders = normalizeHeaderMap(
    (existingDefaultsPayload as Record<string, unknown>).headers
  );
  const nextHeaders = normalizeHeaderMap(
    (nextDefaultsPayload as Record<string, unknown>).headers
  );
  if (existingHeaders || nextHeaders) {
    merged.headers = {
      ...(existingHeaders ?? {}),
      ...(nextHeaders ?? {})
    };
  } else if (Object.prototype.hasOwnProperty.call(merged, "headers")) {
    delete merged.headers;
  }

  return merged;
}

export function canReplayOpenClawGatewayInviteAccept(input: {
  requestType: "human" | "agent";
  agentRuntimeType: string | null;
  existingJoinRequest: Pick<
    typeof joinRequests.$inferSelect,
    "requestType" | "agentRuntimeType" | "status"
  > | null;
}): boolean {
  if (
    input.requestType !== "agent" ||
    input.agentRuntimeType !== "openclaw_gateway"
  ) {
    return false;
  }
  if (!input.existingJoinRequest) {
    return false;
  }
  if (
    input.existingJoinRequest.requestType !== "agent" ||
    input.existingJoinRequest.agentRuntimeType !== "openclaw_gateway"
  ) {
    return false;
  }
  return (
    input.existingJoinRequest.status === "pending_approval" ||
    input.existingJoinRequest.status === "approved"
  );
}

export function summarizeSecretForLog(
  value: unknown
): { present: true; length: number; sha256Prefix: string } | null {
  const trimmed = nonEmptyTrimmedString(value);
  if (!trimmed) return null;
  return {
    present: true,
    length: trimmed.length,
    sha256Prefix: hashToken(trimmed).slice(0, 12)
  };
}

export function summarizeOpenClawGatewayDefaultsForLog(defaultsPayload: unknown) {
  const defaults = isPlainObject(defaultsPayload)
    ? (defaultsPayload as Record<string, unknown>)
    : null;
  const headers = defaults ? normalizeHeaderMap(defaults.headers) : undefined;
  const gatewayTokenValue = headers
    ? headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
      headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
      tokenFromAuthorizationHeader(
        headerMapGetIgnoreCase(headers, "authorization")
      )
    : null;
  return {
    present: Boolean(defaults),
    keys: defaults ? Object.keys(defaults).sort() : [],
    url: defaults ? nonEmptyTrimmedString(defaults.url) : null,
    rudderApiUrl: defaults
      ? nonEmptyTrimmedString(defaults.rudderApiUrl)
      : null,
    headerKeys: headers ? Object.keys(headers).sort() : [],
    sessionKeyStrategy: defaults
      ? nonEmptyTrimmedString(defaults.sessionKeyStrategy)
      : null,
    disableDeviceAuth: defaults
      ? parseBooleanLike(defaults.disableDeviceAuth)
      : null,
    waitTimeoutMs:
      defaults && typeof defaults.waitTimeoutMs === "number"
        ? defaults.waitTimeoutMs
        : null,
    devicePrivateKeyPem: defaults
      ? summarizeSecretForLog(defaults.devicePrivateKeyPem)
      : null,
    gatewayToken: summarizeSecretForLog(gatewayTokenValue)
  };
}

