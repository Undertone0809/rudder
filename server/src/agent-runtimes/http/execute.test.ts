import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http adapter Delegation delivery", () => {
  it("sends the bounded task in the target runtime context without source credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "delegation complete" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        orgId: "org-1",
        name: "Target",
        agentRuntimeType: "http",
        agentRuntimeConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://runtime.example/invoke" },
      context: {
        scene: "delegation",
        sourceRunId: "source-run-1",
        delegationTask: "Inspect the target independently",
      },
      onLog: async () => {},
    });

    expect(result.summary).toBe("delegation complete");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ agentId: "agent-1", runId: "run-1" });
    expect(body.context).toMatchObject({
      scene: "delegation",
      sourceRunId: "source-run-1",
      delegationTask: "Inspect the target independently",
    });
    expect(JSON.stringify(body)).not.toContain("RUDDER_API_KEY");
  });
});
