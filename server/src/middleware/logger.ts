import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { pinoHttp } from "pino-http";
import pretty from "pino-pretty";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";

const REDACTED_REQUEST_BODY = "[REDACTED]";
const REDACTED_REQUEST_QUERY = "[REDACTED]";

function requestRawUrl(req: object): string {
  const request = req as { originalUrl?: unknown; url?: unknown };
  return typeof request.originalUrl === "string"
    ? request.originalUrl
    : typeof request.url === "string"
      ? request.url
      : "";
}

function requestPathname(req: object): string {
  return (requestRawUrl(req).split(/[?#]/u, 1)[0] ?? "")
    .toLowerCase()
    .replace(/\/+$/u, "");
}

function isMcpOAuthCallbackRequest(req: object): boolean {
  return requestPathname(req) === "/api/mcp/oauth/callback";
}

function isBrowserRequest(req: object): boolean {
  const pathname = requestPathname(req);
  return pathname === "/api/browser"
    || pathname.startsWith("/api/browser/")
    || pathname === "/api/instance/browser/broker";
}

function isLocalAccountCredentialRequest(req: object): boolean {
  const pathname = requestPathname(req);
  return pathname === "/api/auth/local-exchange"
    || pathname === "/api/auth/local-offline";
}

function containsInlineAnnotations(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (Object.hasOwn(body, "inlineAnnotations")) return true;
  const payload = (body as { payload?: unknown }).payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return Object.hasOwn(payload, "inlineAnnotations");
  }
  if (typeof payload !== "string") return false;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return Boolean(
      parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && Object.hasOwn(parsed, "inlineAnnotations"),
    );
  } catch {
    // Malformed multipart JSON still reaches HTTP error logging. Prefer
    // over-redaction when it declares the sensitive annotation field.
    return /"inlineAnnotations"\s*:/u.test(payload);
  }
}

export function requestUrlForLogs(req: object): string {
  const rawUrl = requestRawUrl(req);
  if (!isMcpOAuthCallbackRequest(req)) return rawUrl;
  const pathname = rawUrl.split(/[?#]/u, 1)[0] ?? "/api/mcp/oauth/callback";
  return rawUrl.includes("?") || rawUrl.includes("#")
    ? `${pathname}?${REDACTED_REQUEST_QUERY}`
    : pathname;
}

export function requestQueryForLogs(req: object, query: unknown): unknown {
  return isMcpOAuthCallbackRequest(req) ? REDACTED_REQUEST_QUERY : query;
}

export function requestHeadersForLogs(req: object, headers: unknown): unknown {
  if (!headers || typeof headers !== "object") {
    return headers;
  }
  const output = { ...(headers as Record<string, unknown>) };
  const sensitiveNames = isMcpOAuthCallbackRequest(req)
    ? ["referer", "referrer", "cookie", "authorization"]
    : ["cookie", "authorization"];
  for (const name of sensitiveNames) {
    if (Object.keys(output).some((key) => key.toLowerCase() === name)) {
      for (const key of Object.keys(output)) {
        if (key.toLowerCase() === name) output[key] = REDACTED_REQUEST_QUERY;
      }
    }
  }
  return output;
}

export function serializeHttpRequestForLogs(
  serializedRequest: Record<string, unknown>,
): Record<string, unknown> {
  const {
    originalUrl: _originalUrl,
    raw: _raw,
    ...safeRequest
  } = serializedRequest;
  return {
    ...safeRequest,
    url: requestUrlForLogs(serializedRequest),
    query: requestQueryForLogs(serializedRequest, serializedRequest.query),
    headers: requestHeadersForLogs(serializedRequest, serializedRequest.headers),
  };
}

export function serializeHttpResponseForLogs(
  serializedResponse: Record<string, unknown>,
): Record<string, unknown> {
  if (!serializedResponse.headers || typeof serializedResponse.headers !== "object") {
    return serializedResponse;
  }
  const headers = { ...(serializedResponse.headers as Record<string, unknown>) };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "set-cookie") headers[key] = REDACTED_REQUEST_QUERY;
  }
  return { ...serializedResponse, headers };
}

export function markHttpRequestBodySensitive(req: object): void {
  (req as { __rudderSensitiveRequestBody?: boolean }).__rudderSensitiveRequestBody = true;
}

export function markBrowserHttpRequestBodySensitive(
  req: object,
  _res: object,
  next: () => void,
): void {
  if (isBrowserRequest(req)) markHttpRequestBodySensitive(req);
  next();
}

export function requestBodyForLogs(req: object, body: unknown): unknown {
  return (req as { __rudderSensitiveRequestBody?: boolean }).__rudderSensitiveRequestBody === true
    || isBrowserRequest(req)
    || isLocalAccountCredentialRequest(req)
    || containsInlineAnnotations(body)
    ? REDACTED_REQUEST_BODY
    : body;
}

function resolveServerLogDir(): string {
  const envOverride = process.env.RUDDER_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveDailyLogFilePath(baseDir: string, date: Date): string {
  return path.join(baseDir, `server-${formatLocalDateKey(date)}.log`);
}

class DailyFileStream extends Writable {
  private readonly baseDir: string;
  private currentDateKey: string | null = null;
  private currentStream: fs.WriteStream | null = null;

  constructor(baseDir: string) {
    super();
    this.baseDir = baseDir;
  }

  private ensureStream(date: Date): fs.WriteStream {
    const dateKey = formatLocalDateKey(date);
    if (this.currentStream && this.currentDateKey === dateKey) {
      return this.currentStream;
    }
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
    fs.mkdirSync(this.baseDir, { recursive: true });
    const nextStream = fs.createWriteStream(resolveDailyLogFilePath(this.baseDir, date), { flags: "a" });
    this.currentDateKey = dateKey;
    this.currentStream = nextStream;
    return nextStream;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const stream = this.ensureStream(new Date());
    stream.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.currentStream) {
      callback();
      return;
    }
    this.currentStream.end(() => callback());
  }
}

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const consolePrettyStream = pretty({
  ...sharedOpts,
  ignore: "pid,hostname,req,res,responseTime",
  colorize: true,
  destination: 1,
});

const filePrettyStream = pretty({
  ...sharedOpts,
  colorize: false,
  destination: new DailyFileStream(logDir),
});

export const logger = pino({
  level: "debug",
}, pino.multistream([
  { stream: consolePrettyStream, level: "info" },
  { stream: filePrettyStream, level: "debug" },
]));

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    req(serializedRequest) {
      return serializeHttpRequestForLogs(serializedRequest);
    },
    res(serializedResponse) {
      return serializeHttpResponseForLogs(serializedResponse);
    },
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${requestUrlForLogs(req)} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${requestUrlForLogs(req)} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: requestBodyForLogs(req, ctx.reqBody),
          reqParams: ctx.reqParams,
          reqQuery: requestQueryForLogs(req, ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = requestBodyForLogs(req, body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = requestQueryForLogs(req, query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
