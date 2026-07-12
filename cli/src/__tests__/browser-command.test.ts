import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

describe("browser command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.RUDDER_ORG_ID;
    delete process.env.RUDDER_AGENT_ID;
    delete process.env.RUDDER_RUN_ID;
  });

  it("uses the runtime-owned identity for Browser CLI fallback actions", async () => {
    process.env.RUDDER_ORG_ID = "org-1";
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ tabId: "tab-1", url: "https://example.com/" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "browser",
      "open",
      "https://example.com",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    await expect(runCli([
      process.execPath,
      "rudder",
      "browser",
      "type",
      "tab-1",
      "ref-1",
      "--text",
      "hello",
      "--submit",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [openUrl, openInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(openUrl).pathname).toBe("/api/browser/open");
    expect(JSON.parse(String(openInit.body))).toEqual({ url: "https://example.com" });
    const [typeUrl, typeInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URL(typeUrl).pathname).toBe("/api/browser/type");
    expect(JSON.parse(String(typeInit.body))).toEqual({
      tabId: "tab-1",
      ref: "ref-1",
      text: "hello",
      submit: true,
    });

    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      const headers = init.headers as Record<string, string>;
      expect(init.method).toBe("POST");
      expect(headers.authorization).toBe("Bearer token-1");
      expect(headers["x-rudder-agent-id"]).toBe("agent-1");
      expect(headers["x-rudder-run-id"]).toBe("run-1");
    }
  });
});
