import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiRequestError } from "./api-request-error.js";

export type RudderToolTransportSurface = "cli" | "mcp";

type IssueTransportPhase =
  | "fallback_available"
  | "fallback_in_flight"
  | "blocked";

interface IssueTransportScope {
  operation: string;
  issueId: string;
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

    try {
      return await this.withLock(filePath, async () => {
        const now = this.now();
        let state = await readState(filePath);
        if (state && state.expiresAt <= now) {
          await fs.rm(filePath, { force: true });
          state = null;
        }

        if (!state) {
          return { filePath, scope, surface: this.surface, attempt: "initial" };
        }

        if (state.phase === "fallback_available" && state.initialSurface !== this.surface) {
          await writeState(filePath, {
            ...state,
            phase: "fallback_in_flight",
            fallbackSurface: this.surface,
          });
          return { filePath, scope, surface: this.surface, attempt: "fallback" };
        }

        throw issueTransportUnavailable(state, now);
      });
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      return null;
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
        && current?.failure?.fingerprint === failure.fingerprint;
      const budgetExhausted = reservation.attempt === "fallback" || concurrentMatchingFailure;
      const state: IssueTransportState = {
        ...reservation.scope,
        phase: budgetExhausted ? "blocked" : "fallback_available",
        initialSurface: current?.initialSurface ?? reservation.surface,
        fallbackSurface: reservation.attempt === "fallback" ? reservation.surface : undefined,
        fallbackMatchedFingerprint: budgetExhausted
          ? current?.failure?.fingerprint === failure.fingerprint
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
    const key = [this.runId, scope.operation, scope.issueId].join("\n");
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.stateDir, "issue-transport-budget", `${digest}.json`);
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
  const pathname = requestPath.split("?", 1)[0] ?? "";
  const match = /^\/api\/issues\/([^/]+)(?:\/(heartbeat-context|comments)(?:\/([^/]+))?)?$/.exec(pathname);
  if (!match) return null;
  const issueId = decodeURIComponent(match[1] ?? "");
  const resource = match[2];
  const commentId = match[3];
  let operation: string | null = null;
  if (normalizedMethod === "GET" && !resource) operation = "issue.get";
  if (normalizedMethod === "GET" && resource === "heartbeat-context") operation = "issue.context";
  if (normalizedMethod === "GET" && resource === "comments" && !commentId) operation = "issue.comments.list";
  if (normalizedMethod === "GET" && resource === "comments" && commentId) operation = "issue.comments.get";
  if (normalizedMethod === "POST" && resource === "comments" && !commentId) operation = "issue.comment";
  return operation ? { operation, issueId } : null;
}

function buildFingerprint(scope: IssueTransportScope, error: ApiRequestError): IssueTransportFingerprint {
  const normalizedMessage = error.message.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 256);
  const code = error.code?.trim() || "api_request_error";
  const value = [scope.operation, scope.issueId, error.status, code, normalizedMessage].join("\n");
  return {
    fingerprint: createHash("sha256").update(value).digest("hex"),
    status: error.status,
    code,
    normalizedMessage,
  };
}

function issueTransportUnavailable(state: IssueTransportState, now: number): ApiRequestError {
  const details = { issueTransport: transportDiagnostic(state, now) };
  return new ApiRequestError(
    503,
    state.phase === "fallback_in_flight"
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
    issueId: state.issueId,
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
    return isIssueTransportState(parsed) ? parsed : null;
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

function isIssueTransportState(value: unknown): value is IssueTransportState {
  if (!isRecord(value)) return false;
  return typeof value.operation === "string"
    && typeof value.issueId === "string"
    && ["fallback_available", "fallback_in_flight", "blocked"].includes(String(value.phase))
    && (value.initialSurface === "cli" || value.initialSurface === "mcp")
    && typeof value.observedAt === "number"
    && typeof value.expiresAt === "number";
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
