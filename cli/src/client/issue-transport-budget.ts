import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { ApiRequestError } from "./api-request-error.js";

export type RudderToolTransportSurface = "cli" | "mcp";

type IssueTransportPhase =
  | "request_in_flight"
  | "fallback_available"
  | "fallback_in_flight"
  | "probe_in_flight"
  | "blocked"
  | "healthy";

interface IssueTransportScope {
  operation: string;
  scopeKey: string;
  issueId?: string;
  fallbackCommand?: string;
  fallbackBodyFile?: string;
}

interface IssueTransportFingerprint {
  fingerprint: string;
  status: number;
  code: string;
  normalizedMessage: string;
}

interface IssueTransportState extends IssueTransportScope {
  generation: number;
  activeReservations: string[];
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
  reservationId: string;
  generation: number;
}

interface IssueTransportFallbackAction {
  surface: RudderToolTransportSurface;
  command?: string;
  tool?: string;
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
const HEALTHY_EXPIRY = Number.MAX_SAFE_INTEGER;
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

  async reserve(
    method: string | undefined,
    requestPath: string,
    requestBody?: unknown,
  ): Promise<IssueTransportReservation | null> {
    if (!this.runId) return null;
    const scope = issueTransportScope(method, requestPath);
    if (!scope) return null;
    const filePath = this.stateFilePath(scope);

    while (true) {
      try {
        const result = await this.withLock(filePath, async () => {
          const now = this.now();
          let state = await readState(filePath);
          if (state && state.phase !== "healthy" && state.expiresAt <= now) {
            state = await retireExpiredState(filePath, state, now);
          }

          if (!state || state.phase === "healthy") {
            const reservationId = randomUUID();
            const generation = state ? state.generation + 1 : 1;
            let requestScope = scope;
            try {
              requestScope = await prepareInitialScope(
                scope,
                this.surface,
                filePath,
                reservationId,
                requestBody,
              );
              const phase = shouldGateConcurrent(scope) ? "probe_in_flight" : "request_in_flight";
              await writeState(filePath, {
                ...requestScope,
                generation,
                activeReservations: [reservationId],
                phase,
                initialSurface: this.surface,
                observedAt: now,
                expiresAt: now + PROBE_TIMEOUT_MS,
              });
            } catch (error) {
              await cleanupOwnedCommentBodyFile(filePath, requestScope.fallbackBodyFile);
              throw error;
            }
            return {
              filePath,
              scope: requestScope,
              surface: this.surface,
              attempt: "initial",
              reservationId,
              generation,
            } as const;
          }

          if (state.phase === "request_in_flight") {
            const reservationId = randomUUID();
            let requestScope = scope;
            try {
              requestScope = await prepareInitialScope(
                scope,
                this.surface,
                filePath,
                reservationId,
                requestBody,
              );
              await writeState(filePath, {
                ...state,
                activeReservations: [...state.activeReservations, reservationId],
                observedAt: now,
                expiresAt: now + PROBE_TIMEOUT_MS,
              });
            } catch (error) {
              await cleanupOwnedCommentBodyFile(filePath, requestScope.fallbackBodyFile);
              throw error;
            }
            return {
              filePath,
              scope: requestScope,
              surface: this.surface,
              attempt: "initial",
              reservationId,
              generation: state.generation,
            } as const;
          }

          if (state.phase === "probe_in_flight") {
            return { waitForProbeUntil: state.expiresAt } as const;
          }

          if (state.phase === "fallback_available" && state.initialSurface !== this.surface) {
            const reservationId = randomUUID();
            await writeState(filePath, {
              ...state,
              activeReservations: [...state.activeReservations, reservationId],
              phase: "fallback_in_flight",
              fallbackSurface: this.surface,
              observedAt: now,
            });
            return {
              filePath,
              scope: {
                ...scope,
                ...(state.fallbackCommand ? { fallbackCommand: state.fallbackCommand } : {}),
                ...(state.fallbackBodyFile ? { fallbackBodyFile: state.fallbackBodyFile } : {}),
              },
              surface: this.surface,
              attempt: "fallback",
              reservationId,
              generation: state.generation,
            } as const;
          }

          throw issueTransportUnavailable(state, now, scope);
        });

        if ("waitForProbeUntil" in result && typeof result.waitForProbeUntil === "number") {
          await this.waitForProbe(filePath, result.waitForProbeUntil);
          continue;
        }
        return result;
      } catch (error) {
        if (error instanceof ApiRequestError) throw error;
        throw issueTransportStorageUnavailable(scope, this.surface);
      }
    }
  }

  async succeed(reservation: IssueTransportReservation | null): Promise<void> {
    if (!reservation) return;
    try {
      await this.withLock(reservation.filePath, async () => {
        const state = await readState(reservation.filePath);
        if (!state) {
          await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
          throw new Error("Missing Issue transport budget state");
        }
        if (state.generation !== reservation.generation
          || !state.activeReservations.includes(reservation.reservationId)) {
          await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
          return;
        }

        const activeReservations = state.activeReservations.filter(
          (id) => id !== reservation.reservationId,
        );
        const recoveredOnAlternateSurface = reservation.attempt === "initial"
          && state.initialSurface !== reservation.surface
          && ["fallback_available", "fallback_in_flight", "blocked"].includes(state.phase);
        if (reservation.attempt === "fallback" || recoveredOnAlternateSurface) {
          await cleanupOwnedCommentBodyFile(reservation.filePath, state.fallbackBodyFile);
          await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
          await writeState(reservation.filePath, healthyState(state, this.now(), state.generation + 1));
          return;
        }

        await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
        if (activeReservations.length === 0
          && (state.phase === "request_in_flight" || state.phase === "probe_in_flight")) {
          await writeState(reservation.filePath, healthyState(state, this.now(), state.generation + 1));
          return;
        }

        await writeState(reservation.filePath, {
          ...state,
          activeReservations,
          observedAt: this.now(),
        });
      });
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      throw issueTransportStorageUnavailable(reservation.scope, this.surface);
    }
  }

  async fail(reservation: IssueTransportReservation | null, error: ApiRequestError): Promise<void> {
    if (!reservation) return;
    if (error.status < 500 || error.status > 599) {
      await this.succeed(reservation);
      return;
    }

    const failure = buildFingerprint(reservation.scope, error);
    const now = this.now();
    try {
      await this.withLock(reservation.filePath, async () => {
        const current = await readState(reservation.filePath);
        if (!current) {
          await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
          throw new Error("Missing Issue transport budget state");
        }
        if (current.generation !== reservation.generation
          || !current.activeReservations.includes(reservation.reservationId)) {
          await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
          return;
        }

        const activeReservations = current.activeReservations.filter(
          (id) => id !== reservation.reservationId,
        );
        const matchesCurrentFailure = current.failure !== undefined
          && fingerprintsMatch(reservation.scope, current.failure, failure);
        let state: IssueTransportState;

        if (reservation.attempt === "fallback") {
          state = {
            ...current,
            phase: "blocked",
            fallbackSurface: reservation.surface,
            fallbackMatchedFingerprint: current.failure
              ? matchesCurrentFailure
              : undefined,
            failure,
            activeReservations,
            observedAt: now,
            expiresAt: now + this.backoffMs,
          };
        } else if (current.phase === "healthy") {
          await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
          return;
        } else if (!current.failure
          || current.phase === "request_in_flight"
          || current.phase === "probe_in_flight") {
          state = {
            ...reservation.scope,
            generation: current.generation,
            activeReservations,
            phase: "fallback_available",
            initialSurface: current.initialSurface,
            failure,
            observedAt: now,
            expiresAt: now + this.backoffMs,
          };
        } else if (matchesCurrentFailure) {
          state = {
            ...current,
            phase: "blocked",
            activeReservations,
            fallbackMatchedFingerprint: true,
            observedAt: now,
            expiresAt: now + this.backoffMs,
          };
        } else {
          state = {
            ...current,
            activeReservations,
            observedAt: now,
          };
        }

        if (state.fallbackBodyFile !== reservation.scope.fallbackBodyFile) {
          await cleanupOwnedCommentBodyFile(reservation.filePath, reservation.scope.fallbackBodyFile);
        }
        await writeState(reservation.filePath, state);
        attachTransportDiagnostic(error, state, now, reservation.scope);
        appendFallbackGuidance(error, state, reservation.scope);
        if (state.phase === "blocked") {
          error.code = "issue_transport_unavailable";
          error.message = "Issue transport unavailable";
        }
      });
    } catch (storageError) {
      if (storageError instanceof ApiRequestError) throw storageError;
      throw issueTransportStorageUnavailable(reservation.scope, this.surface);
    }
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
    if (!operation) return null;
    const scope = { operation, scopeKey: `issue:${issueId}`, issueId };
    return operation === "issue.comment"
      ? scope
      : {
        ...scope,
        fallbackCommand: buildCliFallbackCommand(operation, issueId, commentId, url.searchParams),
      };
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

function issueTransportUnavailable(
  state: IssueTransportState,
  now: number,
  requestScope: IssueTransportScope = state,
): ApiRequestError {
  const details = { issueTransport: transportDiagnostic(state, now, requestScope) };
  return new ApiRequestError(
    503,
    issueTransportErrorMessage(state, requestScope),
    details,
    { error: "Issue transport unavailable", code: "issue_transport_unavailable", details },
    "issue_transport_unavailable",
  );
}

function attachTransportDiagnostic(
  error: ApiRequestError,
  state: IssueTransportState,
  now: number,
  requestScope: IssueTransportScope = state,
): void {
  const upstreamDetails = error.details;
  error.details = {
    ...(isRecord(upstreamDetails) ? upstreamDetails : upstreamDetails === undefined ? {} : { upstreamDetails }),
    issueTransport: transportDiagnostic(state, now, requestScope),
  };
}

function appendFallbackGuidance(
  error: ApiRequestError,
  state: IssueTransportState,
  requestScope: IssueTransportScope,
): void {
  const fallback = issueTransportFallbackAction(state, requestScope);
  if (!fallback) return;
  error.message = `${error.message}; use the equivalent ${fallbackSurfaceLabel(fallback.surface)} fallback once: ${fallbackTarget(fallback)}`;
}

function issueTransportErrorMessage(
  state: IssueTransportState,
  requestScope: IssueTransportScope = state,
): string {
  const base = state.phase === "fallback_in_flight" || state.phase === "probe_in_flight"
    ? "Issue transport probe already in flight"
    : "Issue transport unavailable";
  const fallback = issueTransportFallbackAction(state, requestScope);
  return fallback
    ? `${base}; use the equivalent ${fallbackSurfaceLabel(fallback.surface)} fallback once: ${fallbackTarget(fallback)}`
    : base;
}

function transportDiagnostic(
  state: IssueTransportState,
  now: number,
  requestScope: IssueTransportScope = state,
) {
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
    fallbackAction: issueTransportFallbackAction(state, requestScope),
    retryAfterMs: Math.max(0, state.expiresAt - now),
    checkpoint: "Issue transport unavailable",
  };
}

function issueTransportFallbackAction(
  state: IssueTransportState,
  requestScope: IssueTransportScope = state,
): IssueTransportFallbackAction | null {
  if (state.phase !== "fallback_available") return null;
  if (state.initialSurface === "mcp") {
    const command = requestScope.fallbackCommand ?? state.fallbackCommand;
    if (command) {
      return { surface: "cli", command };
    }
    if (state.operation === "issue.comment" || !isLegacyIssueScope(state)) return null;
    return {
      surface: "cli",
      command: buildCliFallbackCommand(state.operation, state.issueId, undefined, new URLSearchParams()),
    };
  }
  return {
    surface: "mcp",
    tool: mcpToolNameForOperation(state.operation),
  };
}

function fallbackSurfaceLabel(surface: RudderToolTransportSurface): string {
  return surface === "cli" ? "Rudder CLI" : "Rudder MCP";
}

function fallbackTarget(fallback: IssueTransportFallbackAction): string {
  return fallback.command ?? fallback.tool ?? "the alternate Rudder transport";
}

function mcpToolNameForOperation(operation: string): string {
  return `rudder_${operation.replace(/\./g, "_")}`;
}

function buildCliFallbackCommand(
  operation: string,
  issueId: string,
  commentId: string | undefined,
  query: URLSearchParams,
  options: { bodyFile?: string; reopen?: boolean } = {},
): string {
  const issue = shellQuote(issueId);
  switch (operation) {
    case "issue.get":
      return `rudder issue get ${issue} --json`;
    case "issue.context": {
      const command = [`rudder issue context ${issue}`];
      appendCliOption(command, "--wake-comment-id", query.get("wakeCommentId"));
      return `${command.join(" ")} --json`;
    }
    case "issue.comments.list": {
      const command = [`rudder issue comments list ${issue}`];
      appendCliOption(command, "--after", query.get("after"));
      appendCliOption(command, "--order", query.get("order"));
      return `${command.join(" ")} --json`;
    }
    case "issue.comments.get":
      return `rudder issue comments get ${issue} ${shellQuote(commentId ?? "<comment-id>")} --json`;
    case "issue.comment": {
      if (!options.bodyFile) return "";
      const command = [`rudder issue comment ${issue}`, "--body-file", shellQuote(options.bodyFile)];
      if (options.reopen) command.push("--reopen");
      command.push("--json");
      return command.join(" ");
    }
    default:
      return `rudder issue ${shellQuote(operation)} ${issue} --json`;
  }
}

function appendCliOption(command: string[], option: string, value: string | null): void {
  if (value === null || value.trim().length === 0) return;
  command.push(option, shellQuote(value));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readState(filePath: string): Promise<IssueTransportState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const state = normalizeIssueTransportState(parsed);
    if (!state) throw new Error("Invalid Issue transport budget state");
    return state;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeState(filePath: string, state: IssueTransportState): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
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
  const generation = value.generation === undefined
    ? 0
    : typeof value.generation === "number" && Number.isInteger(value.generation) && value.generation >= 0
      ? value.generation
      : null;
  const activeReservations = value.activeReservations === undefined
    ? []
    : Array.isArray(value.activeReservations) && value.activeReservations.every(
      (reservation) => typeof reservation === "string" && reservation.length > 0,
    )
      ? value.activeReservations as string[]
      : null;
  if (!operation || !scopeKey
    || !["request_in_flight", "fallback_available", "fallback_in_flight", "probe_in_flight", "blocked", "healthy"].includes(String(phase))
    || !initialSurface
    || observedAt === null
    || expiresAt === null
    || generation === null
    || activeReservations === null) {
    return null;
  }
  const fallbackCommand = value.fallbackCommand === undefined
    ? undefined
    : typeof value.fallbackCommand === "string" && value.fallbackCommand.length > 0
      ? value.fallbackCommand
      : null;
  const fallbackBodyFile = value.fallbackBodyFile === undefined
    ? undefined
    : typeof value.fallbackBodyFile === "string" && value.fallbackBodyFile.length > 0
      ? value.fallbackBodyFile
      : null;
  if (fallbackCommand === null || fallbackBodyFile === null) return null;
  const failure = normalizeFingerprint(value.failure);
  if (value.failure !== undefined && !failure) return null;
  if (["fallback_available", "fallback_in_flight", "blocked"].includes(String(phase)) && !failure) {
    return null;
  }
  return {
    operation,
    scopeKey,
    ...(issueId ? { issueId } : {}),
    ...(fallbackCommand ? { fallbackCommand } : {}),
    ...(fallbackBodyFile ? { fallbackBodyFile } : {}),
    generation,
    activeReservations,
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

async function prepareInitialScope(
  scope: IssueTransportScope,
  surface: RudderToolTransportSurface,
  stateFilePath: string,
  reservationId: string,
  requestBody: unknown,
): Promise<IssueTransportScope> {
  if (surface !== "mcp" || scope.operation !== "issue.comment" || !isLegacyIssueScope(scope)) {
    return scope;
  }
  const payload = issueCommentPayload(requestBody);
  if (!payload) return scope;
  const bodyFile = `${stateFilePath}.${reservationId}.comment.md`;
  await fs.writeFile(bodyFile, payload.body, { encoding: "utf8", mode: 0o600 });
  return {
    ...scope,
    fallbackBodyFile: bodyFile,
    fallbackCommand: buildCliFallbackCommand(
      scope.operation,
      scope.issueId,
      undefined,
      new URLSearchParams(),
      { bodyFile, reopen: payload.reopen },
    ),
  };
}

function issueCommentPayload(value: unknown): { body: string; reopen: boolean } | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.body !== "string" || parsed.body.length === 0) return null;
  return { body: parsed.body, reopen: parsed.reopen === true };
}

async function retireExpiredState(
  stateFilePath: string,
  state: IssueTransportState,
  now: number,
): Promise<IssueTransportState> {
  await cleanupOwnedCommentBodyFile(stateFilePath, state.fallbackBodyFile);
  const next = healthyState(state, now, state.generation + 1);
  await writeState(stateFilePath, next);
  return next;
}

function healthyState(
  state: IssueTransportState,
  now: number,
  generation: number,
): IssueTransportState {
  return {
    operation: state.operation,
    scopeKey: state.scopeKey,
    ...(state.issueId ? { issueId: state.issueId } : {}),
    generation,
    activeReservations: [],
    phase: "healthy",
    initialSurface: state.initialSurface,
    observedAt: now,
    expiresAt: HEALTHY_EXPIRY,
  };
}

async function cleanupOwnedCommentBodyFile(stateFilePath: string, bodyFile: string | undefined): Promise<void> {
  if (!bodyFile || !isOwnedCommentBodyFile(stateFilePath, bodyFile)) return;
  await fs.rm(bodyFile, { force: true });
}

function isOwnedCommentBodyFile(stateFilePath: string, bodyFile: string): boolean {
  const stateDir = path.dirname(stateFilePath);
  const stateBase = path.basename(stateFilePath, ".json");
  const bodyBase = path.basename(bodyFile);
  return path.dirname(bodyFile) === stateDir
    && bodyBase.startsWith(`${stateBase}.`)
    && bodyBase.endsWith(".comment.md");
}

function issueTransportStorageUnavailable(
  scope: IssueTransportScope,
  surface: RudderToolTransportSurface,
): ApiRequestError {
  const issueTransport = {
    state: "blocked",
    fingerprint: null,
    operation: scope.operation,
    scopeKey: scope.scopeKey,
    issueId: scope.issueId ?? null,
    upstreamStatus: null,
    upstreamCode: null,
    normalizedServerMessage: null,
    initialSurface: surface,
    fallbackSurface: null,
    fallbackMatchedFingerprint: null,
    fallbackBudgetRemaining: 0,
    fallbackAction: null,
    retryAfterMs: DEFAULT_BACKOFF_MS,
    checkpoint: "Issue transport unavailable",
  };
  const details = { issueTransport };
  return new ApiRequestError(
    503,
    "Issue transport unavailable: local budget state unavailable",
    details,
    { error: "Issue transport unavailable", code: "issue_transport_unavailable", details },
    "issue_transport_unavailable",
  );
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
