import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

describe("activity command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders JSON activity IDs as CLI short IDs by default", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify([
        {
          id: "b3c85ce0-d7b4-407d-b071-478d6e2d337d",
          orgId: "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
          actorType: "agent",
          actorId: "d573266f-af95-44e6-9303-e903a54662b8",
          action: "issue.checked_out",
          entityType: "issue",
          entityId: "8daeadc9-3ea2-49b6-984a-fc2a4101b59c",
          agentId: "d573266f-af95-44e6-9303-e903a54662b8",
          runId: "021814b8-6691-4351-a286-ad33caec1272",
          details: {
            agentId: "d573266f-af95-44e6-9303-e903a54662b8",
            issueIdentifier: "ZST-369",
            title: "把 chat 整合进 Agent run",
          },
          createdAt: "2026-06-18T04:10:29.195Z",
        },
      ]),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "activity",
      "list",
      "--org-id",
      "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
      "--entity-id",
      "8daeadc9-3ea2-49b6-984a-fc2a4101b59c",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(output).not.toContain("d573266f-af95-44e6-9303-e903a54662b8");
    expect(output).not.toContain("8daeadc9-3ea2-49b6-984a-fc2a4101b59c");
    expect(JSON.parse(output)).toEqual([
      expect.objectContaining({
        id: "b3c85ce0",
        orgId: "87e2f140",
        actorId: "agt_d573266f",
        entityId: "ZST-369",
        agentId: "agt_d573266f",
        runId: "021814b8",
        details: expect.objectContaining({
          agentId: "agt_d573266f",
        }),
      }),
    ]);
  });

  it("can preserve full UUIDs for activity JSON when requested", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify([
        {
          id: "b3c85ce0-d7b4-407d-b071-478d6e2d337d",
          orgId: "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
          actorType: "agent",
          actorId: "d573266f-af95-44e6-9303-e903a54662b8",
          action: "issue.checked_out",
          entityType: "issue",
          entityId: "8daeadc9-3ea2-49b6-984a-fc2a4101b59c",
          agentId: "d573266f-af95-44e6-9303-e903a54662b8",
          runId: "021814b8-6691-4351-a286-ad33caec1272",
          details: {
            agentId: "d573266f-af95-44e6-9303-e903a54662b8",
            issueIdentifier: "ZST-369",
          },
          createdAt: "2026-06-18T04:10:29.195Z",
        },
      ]),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "activity",
      "list",
      "--org-id",
      "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
      "--full-ids",
    ])).resolves.toBe(0);

    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(output)[0]).toMatchObject({
      id: "b3c85ce0-d7b4-407d-b071-478d6e2d337d",
      orgId: "87e2f140-3876-4d47-b1e0-71d1bcd772ac",
      actorId: "d573266f-af95-44e6-9303-e903a54662b8",
      entityId: "8daeadc9-3ea2-49b6-984a-fc2a4101b59c",
      agentId: "d573266f-af95-44e6-9303-e903a54662b8",
      runId: "021814b8-6691-4351-a286-ad33caec1272",
      details: expect.objectContaining({
        agentId: "d573266f-af95-44e6-9303-e903a54662b8",
      }),
    });
  });
});
