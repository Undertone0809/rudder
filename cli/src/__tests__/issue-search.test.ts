import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

describe("issue search command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the server-side q parameter instead of local filtering", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify([
        {
          id: "issue-1",
          identifier: "ZST-1",
          title: "Needle issue",
          description: null,
          status: "todo",
          priority: "high",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          projectId: "project-1",
          updatedAt: "2026-05-09T00:00:00.000Z",
        },
      ]),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "issue",
      "search",
      "needle comment",
      "--org-id",
      "org-1",
      "--status",
      "todo",
      "--project-id",
      "project-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/orgs/org-1/issues");
    expect(requestedUrl.searchParams.get("q")).toBe("needle comment");
    expect(requestedUrl.searchParams.get("status")).toBe("todo");
    expect(requestedUrl.searchParams.get("projectId")).toBe("project-1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-1");

    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(output)).toEqual([
      expect.objectContaining({
        id: "issue-1",
        identifier: "ZST-1",
        title: "Needle issue",
      }),
    ]);
  });

  it("lets issue list use the server-side query while keeping --match local", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify([
        {
          id: "issue-1",
          identifier: "ZST-1",
          title: "Needle issue",
          description: "local visible text",
          status: "todo",
          priority: "high",
          assigneeAgentId: null,
          assigneeUserId: null,
          projectId: null,
          updatedAt: "2026-05-09T00:00:00.000Z",
        },
      ]),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "issue",
      "list",
      "--query",
      "server text",
      "--match",
      "local visible",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--json",
    ])).resolves.toBe(0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/orgs/org-1/issues");
    expect(requestedUrl.searchParams.get("q")).toBe("server text");

    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(output)).toEqual([expect.objectContaining({ id: "issue-1" })]);
  });

});
