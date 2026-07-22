import { describe, expect, it, vi } from "vitest";
import { BrowserAgentError } from "./browser-agent-tabs.js";
import { startBrowserBrokerServer } from "./browser-broker-server.js";

const command = {
  identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
  action: "tabs" as const,
  args: {},
};

describe("Desktop Browser Broker server", () => {
  it("binds an authenticated random endpoint on IPv4 loopback only", async () => {
    const execute = vi.fn(async () => ({ tabs: [] }));
    const broker = await startBrowserBrokerServer({ execute });
    try {
      const endpoint = new URL(broker.endpoint);
      expect(endpoint.hostname).toBe("127.0.0.1");
      expect(Number(endpoint.port)).toBeGreaterThan(0);
      expect(endpoint.pathname).toBe("/browser");
      expect(broker.token).toMatch(/^[a-f0-9]{64}$/);

      const unauthorized = await fetch(broker.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      expect(unauthorized.status).toBe(401);
      expect(execute).not.toHaveBeenCalled();

      const response = await fetch(broker.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${broker.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, result: { tabs: [] } });
      expect(execute).toHaveBeenCalledWith({
        ...command,
        deadlineAt: expect.any(Number),
        signal: expect.any(AbortSignal),
      });
    } finally {
      await broker.stop();
    }
  });

  it("rejects malformed requests without invoking the controller", async () => {
    const execute = vi.fn(async () => ({}));
    const broker = await startBrowserBrokerServer({ execute });
    try {
      const response = await fetch(broker.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${broker.token}`,
          "content-type": "application/json",
        },
        body: "{not-json",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "browser_invalid_argument" },
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await broker.stop();
    }
  });

  it("returns only stable Browser errors and never serializes stacks or arbitrary fields", async () => {
    const execute = vi.fn(async () => {
      const error = new BrowserAgentError("browser_tab_forbidden", "This tab belongs to another run.");
      Object.assign(error, { secret: "must-not-escape" });
      throw error;
    });
    const broker = await startBrowserBrokerServer({ execute });
    try {
      const response = await fetch(broker.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${broker.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      });
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        ok: false,
        error: { code: "browser_tab_forbidden", message: "This tab belongs to another run." },
      });
      expect(body).not.toContain("must-not-escape");
      expect(body).not.toContain("stack");
    } finally {
      await broker.stop();
    }
  });

  it("preserves the stable full-page size failure through the HTTP Broker boundary", async () => {
    const broker = await startBrowserBrokerServer({
      execute: async () => {
        throw new BrowserAgentError(
          "browser_result_too_large",
          "Browser full-page screenshot exceeds Chromium's 16384-pixel dimension limit.",
        );
      },
    });
    try {
      const response = await fetch(broker.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${broker.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: {
          code: "browser_result_too_large",
          message: "Browser full-page screenshot exceeds Chromium's 16384-pixel dimension limit.",
        },
      });
    } finally {
      await broker.stop();
    }
  });
});
