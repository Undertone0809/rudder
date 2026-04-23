import pc from "picocolors";
import type { Command } from "commander";
import { getStoredBoardCredential, loginBoardCli } from "../../client/board-auth.js";
import { buildCliCommandLabel } from "../../client/command-label.js";
import { readConfig } from "../../config/store.js";
import { readContext, resolveProfile, type ClientContextProfile } from "../../client/context.js";
import { ApiRequestError, RudderApiClient } from "../../client/http.js";

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
}

export interface ResolvedClientContext {
  api: RudderApiClient;
  orgId?: string;
  agentId?: string;
  runId?: string;
  profileName: string;
  profile: ClientContextProfile;
  json: boolean;
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
    .option("--json", "Output raw JSON");

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

  const api = new RudderApiClient({
    apiBase,
    apiKey,
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

export function printOutput(data: unknown, opts: { json?: boolean; label?: string } = {}): void {
  if (opts.json) {
    const output = JSON.stringify(data, null, 2);
    process.stdout.write(output + "\n");
    return;
  }

  if (opts.label) {
    console.log(pc.bold(opts.label));
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(pc.dim("(empty)"));
      return;
    }
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        console.log(formatInlineRecord(item as Record<string, unknown>));
      } else {
        console.log(String(item));
      }
    }
    return;
  }

  if (typeof data === "object" && data !== null) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data === undefined || data === null) {
    console.log(pc.dim("(null)"));
    return;
  }

  console.log(String(data));
}

export function formatInlineRecord(record: Record<string, unknown>): string {
  const keyOrder = ["identifier", "id", "name", "status", "priority", "title", "action"];
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of keyOrder) {
    if (!(key in record)) continue;
    parts.push(`${key}=${renderValue(record[key])}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(record)) {
    if (seen.has(key)) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${renderValue(value)}`);
  }

  return parts.join(" ");
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
