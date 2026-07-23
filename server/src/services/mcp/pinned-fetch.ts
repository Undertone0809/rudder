import type { FetchLike } from "@modelcontextprotocol/client";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  resolveMcpHttpTarget,
  type McpDnsLookup,
} from "./security-policy.js";

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SecureMcpFetchOptions {
  allowedOrigins: string[];
  curatedOrigin?: string;
  lookup?: McpDnsLookup;
  maxRedirects?: number;
  maxResponseBytes?: number;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  totalTimeoutMs?: number;
}

interface PinnedResponse {
  response: Response;
  bodyFinished: Promise<void>;
}

function timeoutMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Managed MCP request aborted");
}

function createDeadline(timeout: number, message: string): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeout);
  timer.unref();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function requestBodyBuffer(
  request: Request,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        throw new Error("Managed MCP request body exceeds the limit");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel(signal.aborted ? abortReason(signal) : error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function responseHeaders(response: import("node:http").IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function limitedResponseBody(
  response: import("node:http").IncomingMessage,
  maxBytes: number,
  bodyTimeoutMs: number,
  signal: AbortSignal,
): { body: BodyInit; finished: Promise<void> } {
  let bytes = 0;
  let finish!: () => void;
  let cancelBody = () => {
    response.destroy();
    finish();
  };
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error("Managed MCP response body timeout"));
      }, bodyTimeoutMs);
      timer.unref();

      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        response.off("data", onData);
        response.off("end", onEnd);
        response.off("error", onError);
        response.off("aborted", onAborted);
        response.off("close", onClose);
        finish();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        response.destroy();
        cleanup();
        controller.error(error);
      };
      const onAbort = () => fail(abortReason(signal));
      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maxBytes) {
          fail(new Error("Managed MCP upstream response exceeds the output limit"));
          return;
        }
        controller.enqueue(buffer);
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.close();
      };
      const onError = (error: Error) => fail(error);
      const onAborted = () => fail(new Error("Managed MCP upstream response was aborted"));
      const onClose = () => {
        if (!response.complete) {
          fail(new Error("Managed MCP upstream response closed before completion"));
        }
      };
      cancelBody = () => {
        if (settled) return;
        settled = true;
        response.destroy();
        cleanup();
      };

      if (signal.aborted) {
        fail(abortReason(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      response.on("data", onData);
      response.once("end", onEnd);
      response.once("error", onError);
      response.once("aborted", onAborted);
      response.once("close", onClose);
    },
    cancel() {
      cancelBody();
    },
  });
  return {
    body: body as unknown as BodyInit,
    finished,
  };
}

function discardResponseBody(
  response: import("node:http").IncomingMessage,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      response.off("end", done);
      response.off("error", done);
      response.off("aborted", done);
      response.off("close", done);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      response.destroy();
      done();
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    response.once("end", done);
    response.once("error", done);
    response.once("aborted", done);
    response.once("close", done);
    response.resume();
  });
}

function socketConnected(socket: Socket, useTls: boolean): boolean {
  if (!useTls) return !socket.connecting;
  const tlsSocket = socket as TLSSocket & { _secureEstablished?: boolean };
  return !tlsSocket.connecting && tlsSocket._secureEstablished === true;
}

async function requestResponse(input: {
  target: Awaited<ReturnType<typeof resolveMcpHttpTarget>>;
  request: Request;
  body: Buffer | undefined;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
}): Promise<import("node:http").IncomingMessage> {
  if (input.request.signal.aborted) throw abortReason(input.request.signal);
  const phaseController = new AbortController();
  const combinedSignal = AbortSignal.any([
    input.request.signal,
    phaseController.signal,
  ]);
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = (timeout: number, message: string) => {
    if (phaseTimer) clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => phaseController.abort(new Error(message)), timeout);
    phaseTimer.unref();
  };
  armTimeout(input.connectTimeoutMs, "Managed MCP connect timeout");

  const requestOptions: RequestOptions = {
    protocol: input.target.url.protocol,
    hostname: input.target.resolvedAddress,
    port: input.target.url.port
      ? Number(input.target.url.port)
      : input.target.useTls
        ? 443
        : 80,
    path: `${input.target.url.pathname}${input.target.url.search}`,
    method: input.request.method,
    headers: input.headers,
    servername: input.target.tlsServername,
  };

  return await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const requestFn = input.target.useTls ? httpsRequest : httpRequest;
    let settled = false;
    let activeSocket: Socket | undefined;
    const req = requestFn(requestOptions);
    const cleanup = () => {
      if (phaseTimer) clearTimeout(phaseTimer);
      combinedSignal.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      activeSocket?.destroy();
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(abortReason(combinedSignal));
    const onError = (error: Error) => rejectOnce(
      combinedSignal.aborted ? abortReason(combinedSignal) : error,
    );
    const onConnected = () => {
      if (settled) return;
      armTimeout(input.headersTimeoutMs, "Managed MCP response headers timeout");
    };

    combinedSignal.addEventListener("abort", onAbort, { once: true });
    req.once("error", onError);
    req.once("socket", (socket) => {
      activeSocket = socket;
      if (socketConnected(socket, input.target.useTls)) {
        onConnected();
      } else {
        socket.once(input.target.useTls ? "secureConnect" : "connect", onConnected);
      }
    });
    req.once("response", (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    });
    if (input.body) req.write(input.body);
    req.end();
  });
}

async function executePinnedRequest(input: {
  request: Request;
  body: Buffer | undefined;
  options: SecureMcpFetchOptions;
}): Promise<PinnedResponse> {
  const target = await abortable(resolveMcpHttpTarget(input.request.url, {
    allowedOrigins: input.options.allowedOrigins,
    curatedOrigin: input.options.curatedOrigin,
    lookup: input.options.lookup,
  }), input.request.signal);
  const headers = Object.fromEntries(input.request.headers.entries());
  headers.host = target.hostHeader;
  if (input.body && !input.request.headers.has("content-length")) {
    headers["content-length"] = String(input.body.byteLength);
  }

  const response = await requestResponse({
    target,
    request: input.request,
    body: input.body,
    headers,
    connectTimeoutMs: timeoutMs(
      input.options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    headersTimeoutMs: timeoutMs(
      input.options.headersTimeoutMs,
      DEFAULT_HEADERS_TIMEOUT_MS,
    ),
  });

  const status = response.statusCode ?? 500;
  const headersOut = responseHeaders(response);
  const hasBody = input.request.method !== "HEAD" && ![204, 205, 304].includes(status);
  const bodyResult = hasBody
    ? limitedResponseBody(
      response,
      input.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      timeoutMs(input.options.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS),
      input.request.signal,
    )
    : {
      body: null,
      finished: discardResponseBody(response, input.request.signal),
    };
  return {
    response: new Response(bodyResult.body, {
      status,
      statusText: response.statusMessage,
      headers: headersOut,
    }),
    bodyFinished: bodyResult.finished,
  };
}

export function createSecureMcpFetch(options: SecureMcpFetchOptions): FetchLike {
  return async (input, init) => {
    const initialRequest = new Request(input, { ...init, redirect: "manual" });
    const totalDeadline = createDeadline(
      timeoutMs(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS),
      "Managed MCP total timeout",
    );
    const combinedSignal = AbortSignal.any([
      initialRequest.signal,
      totalDeadline.signal,
    ]);
    let request = new Request(initialRequest, {
      signal: combinedSignal,
      redirect: "manual",
    });
    let body: Buffer | undefined;
    try {
      body = await requestBodyBuffer(request, combinedSignal);
    } catch (error) {
      totalDeadline.clear();
      throw combinedSignal.aborted ? abortReason(combinedSignal) : error;
    }
    const initialOrigin = new URL(request.url).origin;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    try {
      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        const pinned = await executePinnedRequest({ request, body, options });
        const { response } = pinned;
        if (!REDIRECT_STATUSES.has(response.status)) {
          void pinned.bodyFinished.then(totalDeadline.clear, totalDeadline.clear);
          return response;
        }

        const location = response.headers.get("location");
        if (!location) {
          void pinned.bodyFinished.then(totalDeadline.clear, totalDeadline.clear);
          return response;
        }
        if (redirectCount === maxRedirects) {
          await response.body?.cancel();
          throw new Error("Managed MCP redirect limit exceeded");
        }

        const redirectedUrl = new URL(location, request.url);
        if (redirectedUrl.origin !== initialOrigin) {
          await response.body?.cancel();
          throw new Error("Managed MCP cross-origin redirects are not allowed");
        }
        await response.body?.cancel();

        const switchToGet = response.status === 303
          || ((response.status === 301 || response.status === 302) && request.method === "POST");
        const nextHeaders = new Headers(request.headers);
        if (switchToGet) {
          nextHeaders.delete("content-length");
          nextHeaders.delete("content-type");
          body = undefined;
        }
        request = new Request(redirectedUrl, {
          method: switchToGet ? "GET" : request.method,
          headers: nextHeaders,
          signal: combinedSignal,
          redirect: "manual",
        });
      }

      throw new Error("Managed MCP redirect limit exceeded");
    } catch (error) {
      totalDeadline.clear();
      throw combinedSignal.aborted ? abortReason(combinedSignal) : error;
    }
  };
}
