import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { ApiRequestError } from "./api-request-error.js";

export type RudderToolTransportSurface = "cli" | "mcp";

type IssueTransportPhase =
  | "fallback_available"
  | "fallback_in_flight"
  | "probe_in_flight"
  | "blocked";

interface IssueTransportScope {
  operation: string;
  scopeKey: string;
  issueId?: string;
}

interface IssueTransportFingerprint {
  fingerprint: string;
  status: number;
  code: string;
  normalizedMessage: string;
}

interface IssueTransportState extends IssueTransportScope {
  phase: IssueTransportPhase;
  initialSurface: RudderToolTransportSurface;
  fallbackSurface?: RudderToolTransportSurface;
  fallbackMatchedFingerprint?: boolean;
  failure?: IssueTransportFingerprint;
  observedAt: number;
  expiresAt: number;
}

interface IssueTransportReservation {
  filePath: string;
  scope: IssueTransportScope;
  surface: RudderToolTransportSurface;
  attempt: "initial" | "fallback";
}

export interface IssueTransportBudgetOptions {
  runId?: string;
  surface?: RudderToolTransportSurface;
  stateDir?: string;
  backoffMs?: number;
  now?: () => number;
}

const DEFAULT_BACKOFF_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_POLL_MS = 10;
const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 250;

export class IssueTransportBudget {
  private readonly runId?: string;
  private readonly surface: RudderToolTransportSurface;
  private readonly stateDir: string;
  private readonly backoffMs: number;
  private readonly now: () => number;

  constructor(options: IssueTransportBudgetOptions) {
    this.runId = options.runId?.trim() || undefined;
    this.surface = options.surface ?? transportSurfaceFromEnv();
    this.stateDir = options.stateDir
      ?? process.env.RUDDER_RUNTIME_TMPDIR?.trim()
      ?? path.join(os.tmpdir(), "rudder-issue-transport");
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = options.now ?? Date.now;
  }

  async reserve(method: string | undefined, requestPath: string): Promise<IssueTransportReservation | null> {
    if (!this.runId) return null;
    const scope = issueTransportScope(method, requestPath);
    if (!scope) return null;
    const filePath = this.stateFilePath(scope);

    while (true) {
      try {
        const result = await this.withLock(filePath, async () => {
          const now = this.now();
          let state = await readState(filePath);
          if (state && state.expiresAt <= now) {
            await fs.rm(filePath, { force: true });
            state = null;
          }

          if (!state) {
            const reservation = { filePath, scope, surface: this.surface, attempt: "initial" } as const;
            if (shouldGateConcurrent(scope)) {
              await writeState(filePath, {
                ...scope,
                phase: "probe_in_flight",
                initialSurface: this.surface,
                observedAt: now,
                expiresAt: now + PROBE_TIMEOUT_MS,
              });
            }
            return reservation;
          }

          if (state.phase === "probe_in_flight") {
            return { waitForProbeUntil: state.expiresAt } as const;
          }

          if (state.phase === "fallback_available" && state.initialSurface !== this.surface) {
            await writeState(filePath, {
              ...state,
              phase: "fallback_in_flight",
              fallbackSurface: this.surface,
            });
            return { filePath, scope, surface: this.surface, attempt: "fallback" } as const;
          }

          throw issueTransportUnavailable(state, now);
        });

        if ("waitForProbeUntil" in result && typeof result.waitForProbeUntil === "number") {
          await this.waitForProbe(filePath, result.waitForProbeUntil);
          continue;
        }
        return result;
      } catch (error) {
        if (error instanceof ApiRequestError) throw error;
        return null;
      }
    }
  }

  async succeed(reservation: IssueTransportReservation | null): Promise<void> {
    if (!reservation) return;
    await this.tryWithLock(reservation.filePath, async () => {
      await fs.rm(reservation.filePath, { force: true });
    });
  }

  async fail(reservation: IssueTransportReservation | null, error: ApiRequestError): Promise<void> {
    if (!reservation) return;
    if (error.status < 500 || error.status > 599) {
      await this.succeed(reservation);
      return;
    }

    const failure = buildFingerprint(reservation.scope, error);
    const now = this.now();
    await this.tryWithLock(reservation.filePath, async () => {
      const current = await readState(reservation.filePath);
      const concurrentMatchingFailure = reservation.attempt === "initial"
        && current?.failure !== undefined
        && fingerprintsMatch(reservation.scope, current.failure, failure);
      const budgetExhausted = reservation.attempt === "fallback" || concurrentMatchingFailure;
      const state: IssueTransportState = {
        ...reservation.scope,
        phase: budgetExhausted ? "blocked" : "fallback_available",
        initialSurface: current?.initialSurface ?? reservation.surface,
        fallbackSurface: reservation.attempt === "fallback" ? reservation.surface : undefined,
        fallbackMatchedFingerprint: budgetExhausted
          ? Boolean(current?.failure && fingerprintsMatch(reservation.scope, current.failure, failure))
          : undefined,
        failure,
        observedAt: now,
        expiresAt: now + this.backoffMs,
      };
      await writeState(reservation.filePath, state);
      attachTransportDiagnostic(error, state, now);
      if (budgetExhausted) {
        error.code = "issue_transport_unavailable";
        error.message = "Issue transport unavailable";
      }
    });
  }

  private stateFilePath(scope: IssueTransportScope): string {
    // Issue scopes keep the legacy file key so state written by the previous
    // implementation remains visible after the scope schema expands.
    const legacyIssueKey = isLegacyIssueScope(scope) ? scope.issueId : undefined;
    const key = [this.runId, scope.operation, legacyIssueKey ?? scope.scopeKey].join("\n");
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.stateDir, "issue-transport-budget", `${digest}.json`);
  }

  private async waitForProbe(filePath: string, expiresAt: number): Promise<void> {
    const waitDeadline = Date.now() + Math.max(0, Math.min(PROBE_TIMEOUT_MS, expiresAt - this.now()));
    while (true) {
      const state = await readState(filePath);
      const now = this.now();
      if (!state || state.phase !== "probe_in_flight" || state.expiresAt <= now) return;
      if (Date.now() >= waitDeadline) throw issueTransportUnavailable(state, now);
      await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_MS));
    }
  }

  private async tryWithLock<T>(filePath: string, action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await this.withLock(filePath, action);
    } catch {
      return undefined;
    }
  }

  private async withLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${filePath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let lock: fs.FileHandle | null = null;
    while (!lock) {
      try {
        lock = await fs.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!isAlreadyExists(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      return await action();
    } finally {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}

function issueTransportScope(method: string | undefined, requestPath: string): IssueTransportScope | null {
  const normalizedMethod = String(method ?? "GET").toUpperCase();
  let url: URL;
  try {
    const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
    url = new URL(normalizedPath, "http://rudder.local");
  } catch {
    return null;
  }

  const issueMatch = /^\/api\/issues\/([^/]+)(?:\/(heartbeat-context|comments)(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (issueMatch) {
    const issueId = decodeScopeValue(issueMatch[1] ?? "");
    if (!issueId) return null;
    const resource = issueMatch[2];
    const commentId = issueMatch[3];
    let operation: string | null = null;
    if (normalizedMethod === "GET" && !resource) operation = "issue.get";
    if (normalizedMethod === "GET" && resource === "heartbeat-context") operation = "issue.context";
    if (normalizedMethod === "GET" && resource === "comments" && !commentId) operation = "issue.comments.list";
    if (normalizedMethod === "GET" && resource === "comments" && commentId) operation = "issue.comments.get";
    if (normalizedMethod === "POST" && resource === "comments" && !commentId) operation = "issue.comment";
    return operation ? { operation, scopeKey: `issue:${issueId}`, issueId } : null;
  }

  const issueListMatch = /^\/api\/orgs\/([^/]+)\/issues$/.exec(url.pathname);
  if (normalizedMethod === "GET" && issueListMatch) {
    const orgId = decodeScopeValue(issueListMatch[1] ?? "");
    if (!orgId) return null;
    const projectId = normalizeScopeValue(url.searchParams.get("projectId"));
    const operation = normalizeScopeValue(url.searchParams.get("q")) ? "issue.search" : "issue.list";
    return {
      operation,
      scopeKey: `org:${orgId}|project:${projectId ?? "*"}`,
    };
  }

  const runsListMatch = /^\/api\/run-intelligence\/orgs\/([^/]+)\/runs$/.exec(url.pathname);
  if (normalizedMethod === "GET" && runsListMatch) {
    const orgId = decodeScopeValue(runsListMatch[1] ?? "");
    if (!orgId) return null;
    const issueId = normalizeScopeValue(url.searchParams.get("issueId"));
    return {
      operation: "runs.list",
      scopeKey: issueId ? `org:${orgId}|issue:${issueId}` : `org:${orgId}`,
      ...(issueId ? { issueId } : {}),
    };
  }

  return null;
}

function buildFingerprint(scope: IssueTransportScope, error: ApiRequestError): IssueTransportFingerprint {
  const normalizedMessage = error.message.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 256);
  const code = error.code?.trim() || "api_request_error";
  const value = [scope.operation, scope.scopeKey, error.status, code, normalizedMessage].join("\n");
  return {
    fingerprint: createHash("sha256").update(value).digest("hex"),
    status: error.status,
    code,
    normalizedMessage,
  };
}

function fingerprintsMatch(
  scope: IssueTransportScope,
  current: IssueTransportFingerprint,
  next: IssueTransportFingerprint,
): boolean {
  if (current.fingerprint === next.fingerprint) return true;
  if (!isLegacyIssueScope(scope)) return false;
  if (current.status !== next.status || current.code !== next.code || current.normalizedMessage !== next.normalizedMessage) {
    return false;
  }
  const legacyValue = [scope.operation, scope.issueId, next.status, next.code, next.normalizedMessage].join("\n");
  return current.fingerprint === createHash("sha256").update(legacyValue).digest("hex");
}

function issueTransportUnavailable(state: IssueTransportState, now: number): ApiRequestError {
  const details = { issueTransport: transportDiagnostic(state, now) };
  return new ApiRequestError(
    503,
    state.phase === "fallback_in_flight" || state.phase === "probe_in_flight"
      ? "Issue transport probe already in flight"
      : "Issue transport unavailable",
    details,
    { error: "Issue transport unavailable", code: "issue_transport_unavailable", details },
    "issue_transport_unavailable",
  );
}

function attachTransportDiagnostic(error: ApiRequestError, state: IssueTransportState, now: number): void {
  const upstreamDetails = error.details;
  error.details = {
    ...(isRecord(upstreamDetails) ? upstreamDetails : upstreamDetails === undefined ? {} : { upstreamDetails }),
    issueTransport: transportDiagnostic(state, now),
  };
}

function transportDiagnostic(state: IssueTransportState, now: number) {
  return {
    state: state.phase,
    fingerprint: state.failure?.fingerprint ?? null,
    operation: state.operation,
    scopeKey: state.scopeKey,
    issueId: state.issueId ?? null,
    upstreamStatus: state.failure?.status ?? null,
    upstreamCode: state.failure?.code ?? null,
    normalizedServerMessage: state.failure?.normalizedMessage ?? null,
    initialSurface: state.initialSurface,
    fallbackSurface: state.fallbackSurface ?? null,
    fallbackMatchedFingerprint: state.fallbackMatchedFingerprint ?? null,
    fallbackBudgetRemaining: state.phase === "fallback_available" ? 1 : 0,
    retryAfterMs: Math.max(0, state.expiresAt - now),
    checkpoint: "Issue transport unavailable",
  };
}

async function readState(filePath: string): Promise<IssueTransportState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeIssueTransportState(parsed);
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeState(filePath: string, state: IssueTransportState): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function normalizeIssueTransportState(value: unknown): IssueTransportState | null {
  if (!isRecord(value)) return null;
  const operation = typeof value.operation === "string" ? value.operation.trim() : "";
  const issueId = typeof value.issueId === "string" ? value.issueId.trim() : "";
  const scopeKey = typeof value.scopeKey === "string" && value.scopeKey.trim().length > 0
    ? value.scopeKey.trim()
    : issueId ? `issue:${issueId}` : "";
  const phase = value.phase;
  const initialSurface = value.initialSurface === "cli" || value.initialSurface === "mcp"
    ? value.initialSurface
    : null;
  const observedAt = typeof value.observedAt === "number" ? value.observedAt : null;
  const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : null;
  if (!operation || !scopeKey
    || !["fallback_available", "fallback_in_flight", "probe_in_flight", "blocked"].includes(String(phase))
    || !initialSurface
    || observedAt === null
    || expiresAt === null) {
    return null;
  }
  const failure = normalizeFingerprint(value.failure);
  return {
    operation,
    scopeKey,
    ...(issueId ? { issueId } : {}),
    phase: phase as IssueTransportPhase,
    initialSurface,
    ...(value.fallbackSurface === "cli" || value.fallbackSurface === "mcp"
      ? { fallbackSurface: value.fallbackSurface }
      : {}),
    ...(typeof value.fallbackMatchedFingerprint === "boolean"
      ? { fallbackMatchedFingerprint: value.fallbackMatchedFingerprint }
      : {}),
    ...(failure ? { failure } : {}),
    observedAt,
    expiresAt,
  };
}

function normalizeFingerprint(value: unknown): IssueTransportFingerprint | undefined {
  if (!isRecord(value)
    || typeof value.fingerprint !== "string"
    || typeof value.status !== "number"
    || typeof value.code !== "string"
    || typeof value.normalizedMessage !== "string") {
    return undefined;
  }
  return {
    fingerprint: value.fingerprint,
    status: value.status,
    code: value.code,
    normalizedMessage: value.normalizedMessage,
  };
}

function shouldGateConcurrent(scope: IssueTransportScope): boolean {
  return scope.operation === "issue.list" || scope.operation === "issue.search" || scope.operation === "runs.list";
}

function isLegacyIssueScope(scope: IssueTransportScope): scope is IssueTransportScope & { issueId: string } {
  return scope.operation.startsWith("issue.") && typeof scope.issueId === "string" && scope.issueId.length > 0;
}

function decodeScopeValue(value: string): string | null {
  try {
    return normalizeScopeValue(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function normalizeScopeValue(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function transportSurfaceFromEnv(): RudderToolTransportSurface {
  return process.env.RUDDER_TOOL_TRANSPORT_SURFACE === "mcp" ? "mcp" : "cli";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
