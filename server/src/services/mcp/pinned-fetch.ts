import type { FetchLike } from "@modelcontextprotocol/client";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";
import {
  resolveMcpHttpTarget,
  type McpDnsLookup,
} from "./security-policy.js";

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SecureMcpFetchOptions {
  allowedOrigins: string[];
  curatedOrigin?: string;
  lookup?: McpDnsLookup;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

async function requestBodyBuffer(request: Request): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    return undefined;
  }
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_REQUEST_BYTES) {
    throw new Error("Managed MCP request body exceeds the limit");
  }
  return body;
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
): BodyInit {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(new Error("Managed MCP upstream response exceeds the output limit"));
        return;
      }
      callback(null, buffer);
    },
  });
  return Readable.toWeb(response.pipe(limiter)) as unknown as BodyInit;
}

async function executePinnedRequest(input: {
  request: Request;
  body: Buffer | undefined;
  options: SecureMcpFetchOptions;
}): Promise<Response> {
  const target = await resolveMcpHttpTarget(input.request.url, {
    allowedOrigins: input.options.allowedOrigins,
    curatedOrigin: input.options.curatedOrigin,
    lookup: input.options.lookup,
  });
  const headers = Object.fromEntries(input.request.headers.entries());
  headers.host = target.hostHeader;
  if (input.body && !input.request.headers.has("content-length")) {
    headers["content-length"] = String(input.body.byteLength);
  }
  const options: RequestOptions = {
    protocol: target.url.protocol,
    hostname: target.resolvedAddress,
    port: target.url.port
      ? Number(target.url.port)
      : target.useTls
        ? 443
        : 80,
    path: `${target.url.pathname}${target.url.search}`,
    method: input.request.method,
    headers,
    servername: target.tlsServername,
    signal: input.request.signal,
  };

  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const requestFn = target.useTls ? httpsRequest : httpRequest;
    const req = requestFn(options, resolve);
    req.once("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });

  const status = response.statusCode ?? 500;
  const headersOut = responseHeaders(response);
  const hasBody = input.request.method !== "HEAD" && ![204, 205, 304].includes(status);
  return new Response(
    hasBody
      ? limitedResponseBody(
        response,
        input.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      )
      : null,
    {
      status,
      statusText: response.statusMessage,
      headers: headersOut,
    },
  );
}

export function createSecureMcpFetch(options: SecureMcpFetchOptions): FetchLike {
  return async (input, init) => {
    let request = new Request(input, { ...init, redirect: "manual" });
    let body = await requestBodyBuffer(request);
    const initialOrigin = new URL(request.url).origin;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await executePinnedRequest({ request, body, options });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
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
        signal: request.signal,
        redirect: "manual",
      });
    }

    throw new Error("Managed MCP redirect limit exceeded");
  };
}
