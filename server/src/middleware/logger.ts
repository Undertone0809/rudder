import path from "node:path";
import fs from "node:fs";
import { Writable } from "node:stream";
import pino from "pino";
import { pinoHttp } from "pino-http";
import pretty from "pino-pretty";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";

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
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
