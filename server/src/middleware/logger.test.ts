import express from "express";
import { once } from "node:events";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  httpRequestLogLevel,
  markBrowserHttpRequestBodySensitive,
  markHttpRequestBodySensitive,
  requestBodyForLogs,
  requestHeadersForLogs,
  requestQueryForLogs,
  requestUrlForLogs,
  serializeHttpRequestForLogs,
  serializeHttpResponseForLogs,
} from "./logger.js";

describe("HTTP request log levels", () => {
  it("silences only successful Browser liveness probes", () => {
    expect(httpRequestLogLevel(
      { method: "POST", originalUrl: "/api/browser/liveness" },
      { statusCode: 204 },
    )).toBe("silent");
    expect(httpRequestLogLevel(
      { method: "post", originalUrl: "/API/BROWSER/LIVENESS/?source=mcp" },
      { statusCode: 204 },
    )).toBe("silent");

    expect(httpRequestLogLevel(
      { method: "POST", originalUrl: "/api/browser/liveness" },
      { statusCode: 409 },
    )).toBe("warn");
    expect(httpRequestLogLevel(
      { method: "POST", originalUrl: "/api/browser/liveness" },
      { statusCode: 500 },
    )).toBe("error");
    expect(httpRequestLogLevel(
      { method: "POST", originalUrl: "/api/browser/liveness" },
      { statusCode: 204 },
      new Error("connection closed"),
    )).toBe("error");
  });

  it("keeps ordinary successful requests and non-POST liveness requests visible", () => {
    expect(httpRequestLogLevel(
      { method: "GET", originalUrl: "/api/browser/liveness" },
      { statusCode: 200 },
    )).toBe("info");
    expect(httpRequestLogLevel(
      { method: "POST", originalUrl: "/api/browser/tabs" },
      { statusCode: 204 },
    )).toBe("info");
  });
});

describe("HTTP request-body logging", () => {
  it("redacts a request body after the route marks it sensitive", () => {
    const request = {};
    const body = {
      token: "browser-broker-secret",
      text: "private clipboard value",
      paths: ["/private/upload.txt"],
    };

    markHttpRequestBodySensitive(request);

    expect(requestBodyForLogs(request, body)).toBe("[REDACTED]");
    expect(JSON.stringify(requestBodyForLogs(request, body))).not.toContain("private clipboard value");
  });

  it("keeps ordinary request bodies available for diagnostics", () => {
    const body = { status: "todo" };

    expect(requestBodyForLogs({}, body)).toBe(body);
  });

  it("redacts Browser bodies by path before auth or route middleware runs", () => {
    const body = { items: [{ entries: [{ text: "clipboard-secret" }] }] };

    expect(requestBodyForLogs({ originalUrl: "/api/browser/clipboard" }, body)).toBe("[REDACTED]");
    expect(requestBodyForLogs({ url: "/api/instance/browser/broker?retry=1" }, body)).toBe("[REDACTED]");
    expect(requestBodyForLogs({ originalUrl: "/API/INSTANCE/BROWSER/BROKER/" }, body)).toBe("[REDACTED]");
    expect(requestBodyForLogs({ originalUrl: "/API/BROWSER/CLIPBOARD/" }, body)).toBe("[REDACTED]");
    expect(requestBodyForLogs({ originalUrl: "/api/issues" }, body)).toBe(body);
  });

  it("redacts local account exchange and Offline Grant bodies before route validation", () => {
    const exchange = { exchangeCode: "live-one-time-code" };
    const offline = {
      grant: "signed-offline-grant",
      proof: { signature: "device-proof" },
    };

    expect(requestBodyForLogs(
      { originalUrl: "/api/auth/local-exchange" },
      exchange,
    )).toBe("[REDACTED]");
    expect(requestBodyForLogs(
      { url: "/API/AUTH/LOCAL-OFFLINE/?retry=1" },
      offline,
    )).toBe("[REDACTED]");
    expect(JSON.stringify([
      requestBodyForLogs({ originalUrl: "/api/auth/local-exchange" }, exchange),
      requestBodyForLogs({ originalUrl: "/api/auth/local-offline" }, offline),
    ])).not.toContain("live-one-time-code");
  });

  it("redacts direct and queued inline annotation request bodies", () => {
    const direct = {
      body: "",
      inlineAnnotations: [{
        selectedText: "PRIVATE_SELECTED_TEXT",
        comment: "PRIVATE_OPERATOR_COMMENT",
      }],
    };
    const queued = {
      payload: {
        body: "",
        inlineAnnotations: [{
          selectedText: "PRIVATE_THINKING_TEXT",
          comment: null,
        }],
      },
    };

    expect(requestBodyForLogs(
      { originalUrl: "/api/chats/chat-1/messages" },
      direct,
    )).toBe("[REDACTED]");
    expect(requestBodyForLogs(
      { originalUrl: "/api/chats/chat-1/queue" },
      queued,
    )).toBe("[REDACTED]");
    expect(JSON.stringify(requestBodyForLogs(
      { originalUrl: "/api/chats/chat-1/messages" },
      direct,
    ))).not.toContain("PRIVATE_SELECTED_TEXT");
    expect(JSON.stringify(requestBodyForLogs(
      { originalUrl: "/api/chats/chat-1/queue" },
      queued,
    ))).not.toContain("PRIVATE_THINKING_TEXT");
  });

  it("redacts multipart Queue payloads whose annotation JSON is still stringified", () => {
    const payload = JSON.stringify({
      body: "",
      inlineAnnotations: [{
        selectedText: "PRIVATE_MULTIPART_THINKING_TEXT",
        comment: "PRIVATE_MULTIPART_OPERATOR_COMMENT",
      }],
    });
    const multipartCreate = {
      payload,
      clientMutationId: "mutation-1",
    };
    const multipartUpdate = {
      payload,
      expectedVersion: "2",
    };

    expect(requestBodyForLogs(
      { originalUrl: "/api/chats/chat-1/queue" },
      multipartCreate,
    )).toBe("[REDACTED]");
    expect(requestBodyForLogs(
      { originalUrl: "/api/chats/chat-1/queue/queued-1" },
      multipartUpdate,
    )).toBe("[REDACTED]");

    const logged = JSON.stringify([
      requestBodyForLogs({}, multipartCreate),
      requestBodyForLogs({}, multipartUpdate),
    ]);
    expect(logged).not.toContain("PRIVATE_MULTIPART_THINKING_TEXT");
    expect(logged).not.toContain("PRIVATE_MULTIPART_OPERATOR_COMMENT");

    expect(requestBodyForLogs({}, {
      payload: "{\"inlineAnnotations\":[{\"selectedText\":\"PRIVATE_TRUNCATED_TEXT\"}",
    })).toBe("[REDACTED]");
  });

  it("keeps Browser bodies redacted when an HTTP request returns before its route", async () => {
    const app = express();
    let loggedBody: unknown;
    app.use(express.json());
    app.use(markBrowserHttpRequestBodySensitive);
    app.use((req, res) => {
      loggedBody = requestBodyForLogs(req, req.body);
      res.status(req.originalUrl.includes("clipboard") ? 401 : 403).json({ error: "rejected before route" });
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const unauthorized = await request(server)
        .post("/api/browser/clipboard")
        .send({ items: [{ entries: [{ text: "clipboard-secret" }] }] });
      expect(unauthorized.status).toBe(401);
      expect(loggedBody).toBe("[REDACTED]");

      const mismatched = await request(server)
        .post("/api/browser/evaluate")
        .send({ function: "() => 'private-value'" });
      expect(mismatched.status).toBe(403);
      expect(loggedBody).toBe("[REDACTED]");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("redacts OAuth callback URL and query before auth or route middleware runs", () => {
    const req = {
      originalUrl: "/api/mcp/oauth/callback?state=raw-state&code=raw-code&error_description=private",
      url: "/api/mcp/oauth/callback?state=raw-state&code=raw-code&error_description=private",
      query: {
        state: "raw-state",
        code: "raw-code",
        error_description: "private",
        iss: "https://oauth.example.test",
      },
      headers: {
        referer: "https://oauth.example.test/authorize?state=referer-state&code_challenge=pkce-secret",
        cookie: "oauth-session=cookie-secret",
        authorization: "Bearer callback-secret",
        "user-agent": "test",
      },
    };

    expect(requestUrlForLogs(req)).toBe("/api/mcp/oauth/callback?[REDACTED]");
    expect(requestQueryForLogs(req, req.query)).toBe("[REDACTED]");
    expect(requestHeadersForLogs(req, req.headers)).toEqual({
      referer: "[REDACTED]",
      cookie: "[REDACTED]",
      authorization: "[REDACTED]",
      "user-agent": "test",
    });
    const serialized = serializeHttpRequestForLogs(req);
    expect(serialized).toMatchObject({
      url: "/api/mcp/oauth/callback?[REDACTED]",
      query: "[REDACTED]",
      headers: {
        referer: "[REDACTED]",
        cookie: "[REDACTED]",
        authorization: "[REDACTED]",
        "user-agent": "test",
      },
    });
    expect(JSON.stringify({
      url: requestUrlForLogs(req),
      query: requestQueryForLogs(req, req.query),
      headers: requestHeadersForLogs(req, req.headers),
      serialized,
    })).not.toMatch(/raw-state|raw-code|private|oauth\.example|referer-state|pkce-secret|cookie-secret|callback-secret/u);
  });

  it("redacts session credentials from all request and response headers", () => {
    const requestHeaders = requestHeadersForLogs(
      { originalUrl: "/api/auth/local-claim" },
      {
        cookie: "better-auth.session_token=secret",
        authorization: "Bearer secret",
        "proxy-authorization": "Basic proxy-secret",
        "x-api-key": "api-secret",
        "x-rudder-api-key": "rudder-secret",
        origin: "http://127.0.0.1:3100",
      },
    );
    const response = serializeHttpResponseForLogs({
      statusCode: 200,
      headers: {
        "set-cookie": "better-auth.session_token=secret; HttpOnly",
        "content-type": "application/json",
      },
    });

    expect(requestHeaders).toEqual({
      cookie: "[REDACTED]",
      authorization: "[REDACTED]",
      "proxy-authorization": "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "x-rudder-api-key": "[REDACTED]",
      origin: "http://127.0.0.1:3100",
    });
    expect(response).toEqual({
      statusCode: 200,
      headers: {
        "set-cookie": "[REDACTED]",
        "content-type": "application/json",
      },
    });
    expect(JSON.stringify({ requestHeaders, response })).not.toContain("secret");
  });
});
