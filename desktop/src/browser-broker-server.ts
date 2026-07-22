import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { BrowserAgentCommand } from "./browser-agent-tabs.js";
import { BrowserAgentError } from "./browser-agent-tabs.js";

const MAX_BROWSER_COMMAND_BYTES = 1_048_576;
const BROWSER_COMMAND_DEADLINE_MS = 35_000;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BROWSER_COMMAND_BYTES) {
      throw new BrowserAgentError("browser_invalid_argument", "Browser command is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BrowserAgentError("browser_invalid_argument", "Browser command body is invalid.");
  }
}

function browserErrorStatus(code: string): number {
  if (code === "browser_disabled") return 409;
  if (code === "browser_unavailable") return 503;
  if (code === "browser_tab_limit") return 429;
  if (code === "browser_timeout") return 504;
  if (code === "browser_result_too_large") return 413;
  if (code === "browser_tab_forbidden") return 403;
  if (code === "browser_tab_not_found" || code === "browser_ref_not_found") return 404;
  if (code === "browser_unsafe_url") return 422;
  if (code === "browser_invalid_argument") return 400;
  return 502;
}

function safeBrowserError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof BrowserAgentError && /^browser_[a-z0-9_]+$/.test(error.code)) {
    return {
      status: browserErrorStatus(error.code),
      code: error.code,
      message: error.message.slice(0, 300),
    };
  }
  return {
    status: 500,
    code: "browser_broker_error",
    message: "Rudder Browser action failed.",
  };
}

export async function startBrowserBrokerServer(options: {
  execute(command: BrowserAgentCommand): Promise<unknown>;
  token?: string;
}) {
  const token = options.token ?? randomBytes(32).toString("hex");
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/browser") {
      sendJson(response, 404, { ok: false, error: { code: "browser_broker_not_found", message: "Not found." } });
      return;
    }
    if (!authorized(request, token)) {
      sendJson(response, 401, { ok: false, error: { code: "browser_broker_unauthorized", message: "Unauthorized." } });
      return;
    }
    const operationAbort = new AbortController();
    const abortOperation = () => operationAbort.abort();
    const abortOnEarlyClose = () => {
      if (!response.writableEnded) operationAbort.abort();
    };
    request.once("aborted", abortOperation);
    response.once("close", abortOnEarlyClose);
    try {
      const command = {
        ...await readJsonBody(request) as BrowserAgentCommand,
        deadlineAt: Date.now() + BROWSER_COMMAND_DEADLINE_MS,
        signal: operationAbort.signal,
      };
      const result = await options.execute(command);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      const safeError = safeBrowserError(error);
      sendJson(response, safeError.status, {
        ok: false,
        error: { code: safeError.code, message: safeError.message },
      });
    } finally {
      request.off("aborted", abortOperation);
      response.off("close", abortOnEarlyClose);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => reject(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Rudder Browser Broker failed to bind loopback.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/browser`,
    token,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}
