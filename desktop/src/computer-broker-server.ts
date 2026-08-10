import type { ComputerUseBrokerCommand } from "@rudderhq/shared";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { ComputerDriverError } from "./computer-driver.js";

const MAX_COMMAND_BYTES = 1_048_576;
const COMMAND_DEADLINE_MS = 35_000;

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function authorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_COMMAND_BYTES) throw new ComputerDriverError("computer_invalid_argument", "Computer Use command is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ComputerDriverError("computer_invalid_argument", "Computer Use command body is invalid.");
  }
}

function safeError(error: unknown) {
  if (error instanceof ComputerDriverError && /^computer_[a-z0-9_]+$/u.test(error.code)) {
    return { code: error.code, message: error.message.slice(0, 300) };
  }
  return { code: "computer_driver_error", message: "Computer Use action failed." };
}

export async function startComputerBrokerServer(options: {
  execute(command: ComputerUseBrokerCommand): Promise<unknown>;
  token?: string;
}) {
  const token = options.token ?? randomBytes(32).toString("hex");
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/computer") {
      sendJson(response, 404, { ok: false, error: { code: "computer_broker_not_found", message: "Not found." } });
      return;
    }
    if (!authorized(request, token)) {
      sendJson(response, 401, { ok: false, error: { code: "computer_broker_unauthorized", message: "Unauthorized." } });
      return;
    }
    const abort = new AbortController();
    const abortRequest = () => abort.abort();
    const abortOnClose = () => { if (!response.writableEnded) abort.abort(); };
    request.once("aborted", abortRequest);
    response.once("close", abortOnClose);
    try {
      const command = {
        ...await readJson(request) as ComputerUseBrokerCommand,
        deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
        signal: abort.signal,
      };
      sendJson(response, 200, { ok: true, result: await options.execute(command) });
    } catch (error) {
      const safe = safeError(error);
      const status = safe.code === "computer_invalid_argument" ? 400
        : safe.code === "computer_stale_observation" || safe.code === "computer_target_not_found" ? 404
          : safe.code === "computer_permission_required" ? 409 : 502;
      sendJson(response, status, { ok: false, error: safe });
    } finally {
      request.off("aborted", abortRequest);
      response.off("close", abortOnClose);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Computer Broker failed to bind loopback.");
  return {
    endpoint: `http://127.0.0.1:${address.port}/computer`,
    token,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
