import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

describe("organization members command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves member UUID refs when --full-ids is requested", async () => {
    const agentId = "d573266f-af95-44e6-9303-e903a54662b8";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/orgs/org-1/members/directory");
      expect(url.searchParams.get("fullIds")).toBe("true");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
      return new Response(JSON.stringify({
        total: 1,
        items: [{ name: "Ada", type: "agent", role: "builder", ref: agentId }],
        nextCursor: null,
        hasMore: false,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "org",
      "members",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
      "--full-ids",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(output)).toEqual({
      total: 1,
      items: [{ name: "Ada", type: "agent", role: "builder", ref: agentId }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("uses the authenticated cursor to fetch the next short-reference page", async () => {
    const firstPage = {
      total: 3,
      items: [
        { name: "Ada", type: "agent", role: "builder", ref: "agt_12345678" },
        { name: "Grace", type: "agent", role: "builder", ref: "agt_23456789" },
      ],
      nextCursor: "next/page?token=1",
      hasMore: true,
    };
    const secondPage = {
      total: 3,
      items: [{ name: "Linus", type: "agent", role: "builder", ref: "agt_34567890" }],
      nextCursor: null,
      hasMore: false,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/orgs/org-1/members/directory");
      expect(url.searchParams.get("query")).toBe("builder");
      expect(url.searchParams.get("type")).toBe("agent");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-2");
      return new Response(JSON.stringify(url.searchParams.has("cursor") ? secondPage : firstPage), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "org",
      "members",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-2",
      "--query",
      "builder",
      "--type",
      "agent",
      "--limit",
      "2",
      "--cursor",
      firstPage.nextCursor!,
      "--json",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""));
    expect(output).toEqual(secondPage);
    expect(output.items[0].ref).toMatch(/^agt_[a-z0-9]{8,}$/u);
    expect(output.items[0].ref).not.toMatch(/^[0-9a-f-]{36}$/iu);
  });
});
