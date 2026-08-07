import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";

const ORIGINAL_ENV = { ...process.env };

describe("Goal CLI commands", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      RUDDER_AGENT_ID: "11111111-1111-4111-8111-111111111111",
      RUDDER_RUN_ID: "22222222-2222-4222-8222-222222222222",
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("records evidence-backed progress with runtime attribution headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "activity-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runCli([
      process.execPath,
      "rudder",
      "goal",
      "progress",
      "goal-1",
      "--summary",
      "Verified the external result.",
      "--evidence-refs",
      '["artifact://goal/progress"]',
      "--idempotency-key",
      "goal-progress-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "runtime-key",
      "--json",
    ])).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/goals/goal-1/activities");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-rudder-agent-id": "11111111-1111-4111-8111-111111111111",
      "x-rudder-run-id": "22222222-2222-4222-8222-222222222222",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      summary: "Verified the external result.",
      activityKind: "progress",
      evidenceRefs: ["artifact://goal/progress"],
      idempotencyKey: "goal-progress-1",
    });
  });

  it("submits a result proposal without accepting or closing the Goal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "proposal-1",
      status: "ready",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runCli([
      process.execPath,
      "rudder",
      "goal",
      "result",
      "propose",
      "goal-1",
      "--contract-revision",
      "3",
      "--criteria",
      '[{"id":"criterion-1","status":"met"}]',
      "--evidence-refs",
      '["artifact://goal/result"]',
      "--risk-summary",
      "No known gap.",
      "--idempotency-key",
      "goal-result-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "runtime-key",
      "--json",
    ])).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/goals/goal-1/result-proposals");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      contractRevision: 3,
      criteria: [{ id: "criterion-1", status: "met" }],
      evidenceRefs: ["artifact://goal/result"],
      resultPayload: {},
      riskSummary: "No known gap.",
      idempotencyKey: "goal-result-1",
    });
  });
});
