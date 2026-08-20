import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

describe("organization members command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves member UUID refs when --full-ids is requested", async () => {
    const agentId = "d573266f-af95-44e6-9303-e903a54662b8";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/orgs/org-1/members/directory");
      expect(url.searchParams.get("fullIds")).toBe("true");
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
});
