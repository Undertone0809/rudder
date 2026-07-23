import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  markBrowserHttpRequestBodySensitive,
  markHttpRequestBodySensitive,
  requestBodyForLogs,
  requestHeadersForLogs,
  requestQueryForLogs,
  requestUrlForLogs,
  serializeHttpRequestForLogs,
} from "./logger.js";

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

  it("keeps Browser bodies redacted when an HTTP request returns before its route", async () => {
    const app = express();
    let loggedBody: unknown;
    app.use(express.json());
    app.use(markBrowserHttpRequestBodySensitive);
    app.use((req, res) => {
      loggedBody = requestBodyForLogs(req, req.body);
      res.status(req.originalUrl.includes("clipboard") ? 401 : 403).json({ error: "rejected before route" });
    });

    const unauthorized = await request(app)
      .post("/api/browser/clipboard")
      .send({ items: [{ entries: [{ text: "clipboard-secret" }] }] });
    expect(unauthorized.status).toBe(401);
    expect(loggedBody).toBe("[REDACTED]");

    const mismatched = await request(app)
      .post("/api/browser/evaluate")
      .send({ function: "() => 'private-value'" });
    expect(mismatched.status).toBe(403);
    expect(loggedBody).toBe("[REDACTED]");
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
});
