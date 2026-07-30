import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

function base64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export type IdentityPkceRequest = {
  state: string;
  verifier: string;
  challenge: string;
  method: "S256";
};

export function createIdentityPkceRequest(): IdentityPkceRequest {
  const verifier = base64Url(randomBytes(48));
  return {
    state: base64Url(randomBytes(32)),
    verifier,
    challenge: base64Url(createHash("sha256").update(verifier, "ascii").digest()),
    method: "S256",
  };
}

export type IdentityLoopbackCallback = {
  redirectUri: string;
  waitForCode: Promise<string>;
  close(): Promise<void>;
};

export async function openIdentityLoopbackCallback(options: {
  expectedState: string;
  timeoutMs?: number;
}): Promise<IdentityLoopbackCallback> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (settled) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
      response.end("This sign-in callback has already been used.");
      return;
    }
    const state = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    const error = requestUrl.searchParams.get("error");
    if (state !== options.expectedState) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("The sign-in response did not match this Rudder request.");
      return;
    }
    settled = true;
    if (error || !code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Rudder sign-in was not completed.");
      rejectCode(new Error(error ? `Identity authorization failed: ${error}` : "Identity authorization code is missing"));
      void close();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end("<!doctype html><meta charset=\"utf-8\"><title>Rudder sign-in complete</title><p>Sign-in complete. You can return to Rudder.</p>");
    resolveCode(code);
    void close();
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to open the Rudder sign-in callback");
  }

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCode(new Error("Rudder sign-in timed out"));
    void close();
  }, timeoutMs);
  timer.unref();

  async function close(): Promise<void> {
    clearTimeout(timer);
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode,
    close,
  };
}
