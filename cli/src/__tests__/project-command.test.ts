import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

describe("project command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.RUDDER_AGENT_ID;
    delete process.env.RUDDER_RUN_ID;
  });

  it("creates projects through the organization-scoped API with agent run context", async () => {
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        id: "project-1",
        orgId: "org-1",
        name: "New Launch",
        status: "planned",
      }),
      { status: 201 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "project",
      "create",
      "--org-id",
      "org-1",
      "--name",
      "New Launch",
      "--description",
      "Launch plan",
      "--status",
      "planned",
      "--goal-ids",
      "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222",
      "--lead-agent-id",
      "33333333-3333-4333-8333-333333333333",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/orgs/org-1/projects");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "New Launch",
      description: "Launch plan",
      status: "planned",
      goalIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
      leadAgentId: "33333333-3333-4333-8333-333333333333",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-1");
    expect(headers["x-rudder-agent-id"]).toBe("agent-1");
    expect(headers["x-rudder-run-id"]).toBe("run-1");

    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(output)).toEqual(expect.objectContaining({ id: "project-1", name: "New Launch" }));
  });

  it("updates projects by shortname with org context for resolution", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        id: "project-1",
        orgId: "org-1",
        name: "Renamed Launch",
        status: "in_progress",
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "project",
      "update",
      "launch-plan",
      "--org-id",
      "org-1",
      "--name",
      "Renamed Launch",
      "--status",
      "in_progress",
      "--archived-at",
      "null",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/projects/launch-plan");
    expect(requestedUrl.searchParams.get("orgId")).toBe("org-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Renamed Launch",
      status: "in_progress",
      archivedAt: null,
    });
  });
});
