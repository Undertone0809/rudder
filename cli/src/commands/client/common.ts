import { isUuidLike } from "@rudderhq/shared";
import type { Command } from "commander";
import pc from "picocolors";
import { getStoredBoardCredential, loginBoardCli } from "../../client/board-auth.js";
import { buildCliCommandLabel } from "../../client/command-label.js";
import { readContext, resolveProfile, type ClientContextProfile } from "../../client/context.js";
import { ApiRequestError, RudderApiClient } from "../../client/http.js";
import { readConfig } from "../../config/store.js";

let currentCommandFullIds = false;
const CLI_SHORT_UUID_LENGTH = 12;
const UUID_SUBSTRING_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

export interface BaseClientOptions {
  config?: string;
  dataDir?: string;
  context?: string;
  profile?: string;
  apiBase?: string;
  apiKey?: string;
  orgId?: string;
  companyId?: string;
  runId?: string;
  json?: boolean;
  fullIds?: boolean;
}

export interface ResolvedClientContext {
  api: RudderApiClient;
  orgId?: string;
  agentId?: string;
  runId?: string;
  profileName: string;
  profile: ClientContextProfile;
  json: boolean;
  fullIds: boolean;
}

export function addCommonClientOptions(command: Command, opts?: { includeCompany?: boolean }): Command {
  command
    .option("-c, --config <path>", "Path to Rudder config file")
    .option("-d, --data-dir <path>", "Rudder data directory root (isolates state from ~/.rudder)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "Base URL for the Rudder API")
    .option("--api-key <token>", "Bearer token for agent-authenticated calls")
    .option("--run-id <id>", "Run ID to attach on mutating agent requests")
    .option("--json", "Output JSON")
    .option("--full-ids", "Show full UUIDs in output instead of CLI short IDs");

  if (opts?.includeCompany) {
    command.option("-O, --org-id <id>", "Organization ID (overrides context default)");
  }

  return command;
}

export function resolveCommandContext(
  options: BaseClientOptions,
  opts?: { requireCompany?: boolean },
): ResolvedClientContext {
  const context = readContext(options.context);
  const { name: profileName, profile } = resolveProfile(context, options.profile);

  const apiBase =
    options.apiBase?.trim() ||
    process.env.RUDDER_API_URL?.trim() ||
    profile.apiBase ||
    inferApiBaseFromConfig(options.config);

  const explicitApiKey =
    options.apiKey?.trim() ||
    process.env.RUDDER_API_KEY?.trim() ||
    readKeyFromProfileEnv(profile);
  const storedBoardCredential = explicitApiKey ? null : getStoredBoardCredential(apiBase);
  const apiKey = explicitApiKey || storedBoardCredential?.token;

  const orgId =
    options.orgId?.trim() ||
    options.companyId?.trim() ||
    process.env.RUDDER_ORG_ID?.trim() ||
    profile.orgId;
  const agentId = process.env.RUDDER_AGENT_ID?.trim() || undefined;
  const runId = options.runId?.trim() || process.env.RUDDER_RUN_ID?.trim() || undefined;

  if (opts?.requireCompany && !orgId) {
    throw new Error(
      "Organization ID is required. Pass --org-id, set RUDDER_ORG_ID, or set context profile orgId via `rudder context set`.",
    );
  }

  const fullIds = Boolean(options.fullIds);
  currentCommandFullIds = fullIds;

  const api = new RudderApiClient({
    apiBase,
    apiKey,
    agentId,
    runId,
    recoverAuth: explicitApiKey || !canAttemptInteractiveBoardAuth()
      ? undefined
      : async ({ error }) => {
          const requestedAccess = error.message.includes("Instance admin required")
            ? "instance_admin_required"
            : "board";
          if (!shouldRecoverBoardAuth(error)) {
            return null;
          }
          const login = await loginBoardCli({
            apiBase,
            requestedAccess,
            requestedCompanyId: orgId ?? null,
            command: buildCliCommandLabel(),
          });
          return login.token;
        },
  });
  return {
    api,
    orgId,
    agentId,
    runId,
    profileName,
    profile,
    json: Boolean(options.json),
    fullIds,
  };
}

function shouldRecoverBoardAuth(error: ApiRequestError): boolean {
  if (error.status === 401) return true;
  if (error.status !== 403) return false;
  return error.message.includes("Board access required") || error.message.includes("Instance admin required");
}

function canAttemptInteractiveBoardAuth(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function printOutput(
  data: unknown,
  opts: { json?: boolean; label?: string; fullIds?: boolean } = {},
): void {
  const outputData = shouldShowFullIds(opts.fullIds) ? data : toCliShortIdOutput(data);

  if (opts.json) {
    const output = JSON.stringify(outputData, null, 2);
    process.stdout.write(output + "\n");
    return;
  }

  if (opts.label) {
    console.log(pc.bold(opts.label));
  }

  if (Array.isArray(outputData)) {
    if (outputData.length === 0) {
      console.log(pc.dim("(empty)"));
      return;
    }
    for (const item of outputData) {
      if (typeof item === "object" && item !== null) {
        console.log(formatInlineRecord(item as Record<string, unknown>, { fullIds: true }));
      } else {
        console.log(String(item));
      }
    }
    return;
  }

  if (typeof outputData === "object" && outputData !== null) {
    console.log(JSON.stringify(outputData, null, 2));
    return;
  }

  if (outputData === undefined || outputData === null) {
    console.log(pc.dim("(null)"));
    return;
  }

  console.log(String(outputData));
}

export function formatInlineRecord(
  record: Record<string, unknown>,
  opts: { fullIds?: boolean } = {},
): string {
  const displayRecord = shouldShowFullIds(opts.fullIds)
    ? record
    : (toCliShortIdOutput(record) as Record<string, unknown>);
  const keyOrder = ["identifier", "shortRef", "id", "name", "status", "priority", "title", "action"];
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of keyOrder) {
    if (!(key in displayRecord)) continue;
    parts.push(`${key}=${renderValue(displayRecord[key])}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(displayRecord)) {
    if (seen.has(key)) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${renderValue(value)}`);
  }

  return parts.join(" ");
}

export function toCliShortIdOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toCliShortIdOutput(item));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(source)) {
    output[key] = shortenCliValueForKey(key, childValue, source);
  }
  return output;
}

export function formatCliRunId(runId: string): string {
  return isUuidLike(runId) ? shortUuid(runId) : runId;
}

function shortenCliValueForKey(key: string, value: unknown, parent: Record<string, unknown>): unknown {
  if (typeof value === "string" && isCliIdKey(key) && isUuidLike(value)) {
    return displayIdForCli(key, value, parent);
  }

  if (typeof value === "string" && isCliReferenceStringKey(key)) {
    return value.replace(UUID_SUBSTRING_RE, (uuid) => shortUuid(uuid));
  }

  if (Array.isArray(value) && isCliIdListKey(key)) {
    return value.map((item) =>
      typeof item === "string" && isUuidLike(item) ? displayIdForCli(singularizeIdListKey(key), item, parent) : toCliShortIdOutput(item),
    );
  }

  return toCliShortIdOutput(value);
}

function displayIdForCli(key: string, uuid: string, parent: Record<string, unknown>): string {
  if (key === "id") {
    const directShortRef = readString(parent.shortRef);
    if (directShortRef) return directShortRef;

    const issueIdentifier = readDirectIssueIdentifier(parent);
    if (issueIdentifier) return issueIdentifier;
  }

  if (isAgentIdKey(key, parent)) {
    return formatTypedShortRef("agent", uuid);
  }

  if (isIssueCommentIdKey(key)) {
    return formatTypedShortRef("issue_comment", uuid);
  }

  if (key === "entityId" && parent.entityType === "issue") {
    return readIssueIdentifier(parent) ?? shortUuid(uuid);
  }

  return shortUuid(uuid);
}

function shouldShowFullIds(explicit?: boolean): boolean {
  return Boolean((explicit ?? currentCommandFullIds) || process.argv.includes("--full-ids"));
}

function isCliIdKey(key: string): boolean {
  return key === "id" || key.endsWith("Id");
}

function isCliIdListKey(key: string): boolean {
  return key.endsWith("Ids");
}

function isCliReferenceStringKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return lowerKey.endsWith("ref") || lowerKey.endsWith("path");
}

function singularizeIdListKey(key: string): string {
  return `${key.slice(0, -3)}Id`;
}

function isAgentIdKey(key: string, parent: Record<string, unknown>): boolean {
  const lowerKey = key.toLowerCase();
  return lowerKey.includes("agentid") || (key === "actorId" && parent.actorType === "agent");
}

function isIssueCommentIdKey(key: string): boolean {
  return key.toLowerCase().includes("commentid");
}

function formatTypedShortRef(kind: "agent" | "issue_comment", uuid: string): string {
  const prefix = kind === "agent" ? "agt" : "cmt";
  return `${prefix}_${shortUuid(uuid)}`;
}

function shortUuid(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, CLI_SHORT_UUID_LENGTH).toLowerCase();
}

function readIssueIdentifier(parent: Record<string, unknown>): string | null {
  const direct = readDirectIssueIdentifier(parent);
  if (direct) return direct;

  const details = parent.details;
  if (typeof details !== "object" || details === null) return null;
  const detailsRecord = details as Record<string, unknown>;
  return readString(detailsRecord.identifier) ?? readString(detailsRecord.issueIdentifier);
}

function readDirectIssueIdentifier(parent: Record<string, unknown>): string | null {
  return readString(parent.identifier) ?? readString(parent.issueIdentifier);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "[object]";
}

function inferApiBaseFromConfig(configPath?: string): string {
  const envHost = process.env.RUDDER_SERVER_HOST?.trim() || "localhost";
  let port = Number(process.env.RUDDER_SERVER_PORT || "");

  if (!Number.isFinite(port) || port <= 0) {
    try {
      const config = readConfig(configPath);
      port = Number(config?.server?.port ?? 3100);
    } catch {
      port = 3100;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    port = 3100;
  }

  return `http://${envHost}:${port}`;
}

function readKeyFromProfileEnv(profile: ClientContextProfile): string | undefined {
  if (!profile.apiKeyEnvVarName) return undefined;
  return process.env[profile.apiKeyEnvVarName]?.trim() || undefined;
}

export function handleCommandError(error: unknown): never {
  if (process.argv.includes("--json")) {
    const payload = buildCommandErrorPayload(error);
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }

  if (error instanceof ApiRequestError) {
    const detailSuffix = error.details !== undefined ? ` details=${JSON.stringify(error.details)}` : "";
    console.error(pc.red(`API error ${error.status}: ${error.message}${detailSuffix}`));
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}

function buildCommandErrorPayload(error: unknown) {
  if (error instanceof ApiRequestError) {
    return {
      error: error.message,
      status: error.status,
      code: error.code ?? "api_request_error",
      details: error.details ?? null,
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error),
    status: null,
    code: "cli_error",
    details: null,
  };
}
