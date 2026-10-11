import type { NextFunction, Request, Response } from "express";
import postgres from "postgres";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { requestQueryForLogs, requestUrlForLogs } from "./logger.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

const NETWORK_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const POSTGRES_TRANSPORT_UNAVAILABLE_CODES = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
]);
const POSTGRES_SERVER_UNAVAILABLE_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

function isDatabaseUnavailable(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const candidate = current as {
      address?: unknown;
      cause?: unknown;
      code?: unknown;
      errno?: unknown;
      errors?: unknown;
      port?: unknown;
    };
    const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
    const hasSocketAddress = typeof candidate.address === "string"
      || typeof candidate.port === "number";
    const address = candidate.address;
    const port = candidate.port;
    const hasPostgresTcpEndpoint = (typeof address === "string"
      && address.length > 0
      && typeof port === "number"
      && Number.isInteger(port)
      && port > 0)
      || (Array.isArray(address)
        && address.length > 0
        && address.every((host) => typeof host === "string" && host.length > 0)
        && Array.isArray(port)
        && port.length === address.length
        && port.every((candidatePort) => typeof candidatePort === "number" && Number.isInteger(candidatePort) && candidatePort > 0));
    const hasPostgresSocketPath = typeof address === "string"
      && address.length > 0
      && port == null;
    if (current instanceof postgres.PostgresError
      && (POSTGRES_SERVER_UNAVAILABLE_CODES.has(code) || /^08[0-9A-Z]{3}$/u.test(code))) {
      return true;
    }
    // postgres.js stores resolved TCP endpoints as host/port arrays on its
    // connection errors; its wrapper may then place that error under Drizzle's
    // `cause`. Require the driver's paired errno and endpoint shape so an
    // arbitrary Error that merely copies a transport code is not treated as a
    // database outage.
    if (POSTGRES_TRANSPORT_UNAVAILABLE_CODES.has(code)
      && typeof candidate.errno === "string"
      && candidate.errno.toUpperCase() === code
      && (hasPostgresTcpEndpoint || hasPostgresSocketPath)) {
      return true;
    }
    if (hasSocketAddress && NETWORK_UNAVAILABLE_CODES.has(code)) {
      return true;
    }
    if (candidate.cause) pending.push(candidate.cause);
    if (Array.isArray(candidate.errors)) pending.push(...candidate.errors);
  }
  return false;
}

function isSecretsPublicRoute(req: Request): boolean {
  const rawUrl = typeof req.originalUrl === "string" ? req.originalUrl : req.url;
  const pathname = rawUrl.split(/[?#]/u, 1)[0]!.toLowerCase().replace(/\/+$/u, "");
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return /^\/api\/orgs\/[^/]+\/(?:secret-providers|secrets)$/u.test(pathname);
  }
  if (method === "POST") {
    return /^\/api\/orgs\/[^/]+\/secrets$/u.test(pathname)
      || /^\/api\/secrets\/[^/]+\/rotate$/u.test(pathname);
  }
  return (method === "PATCH" || method === "DELETE")
    && /^\/api\/secrets\/[^/]+$/u.test(pathname);
}

function isZodErrorLike(err: unknown): err is { issues: unknown[] } {
  if (err instanceof ZodError) return true;
  if (!err || typeof err !== "object") return false;
  const candidate = err as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: requestUrlForLogs(req),
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: requestQueryForLogs(req, req.query),
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (isSecretsPublicRoute(req) && isDatabaseUnavailable(err)) {
    attachErrorContext(req, res, {
      message: "Database temporarily unavailable",
      name: "DatabaseUnavailableError",
    });
    res.status(503).json({
      error: "Service temporarily unavailable",
      code: "database_unavailable",
    });
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (isZodErrorLike(err)) {
    res.status(400).json({ error: "Validation error", details: err.issues });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  res.status(500).json({ error: "Internal server error" });
}
