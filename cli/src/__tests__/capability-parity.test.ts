import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeContext } from "../client/context.js";
import { runCli } from "../program.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_ARGV = [...process.argv];

function createContextPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-cli-parity-"));
  const contextPath = path.join(dir, "context.json");
  writeContext({ version: 1, currentProfile: "default", profiles: { default: {} } }, contextPath);
  return contextPath;
}

function captureOutput() {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    stdout,
    stderr,
    log,
    error,
    stdoutText: () =>
      stdout.mock.calls.map((call) => String(call[0])).join("") +
      log.mock.calls.map((call) => call.map(String).join(" ")).join("\n"),
    stderrText: () =>
      stderr.mock.calls.map((call) => String(call[0])).join("") +
      error.mock.calls.map((call) => call.map(String).join(" ")).join("\n"),
  };
}

function parseFirstJsonObject(text: string) {
  const end = text.indexOf("\n}");
  const jsonText = end >= 0 ? text.slice(0, end + 2) : text;
  return JSON.parse(jsonText);
}

describe("CLI automation/chat/runs parity", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RUDDER_ORG_ID;
    delete process.env.RUDDER_AGENT_ID;
    delete process.env.RUDDER_RUN_ID;
    process.argv = [...ORIGINAL_ARGV];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    process.argv = [...ORIGINAL_ARGV];
  });

  it("filters automation list rows locally while preserving JSON output", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        id: "automation-1",
        title: "Daily triage",
        status: "active",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        outputMode: "track_issue",
        triggers: [],
        lastRun: { status: "succeeded" },
      },
      {
        id: "automation-2",
        title: "Chat digest",
        status: "paused",
        assigneeAgentId: "agent-2",
        projectId: "project-1",
        outputMode: "chat_output",
        triggers: [],
        lastRun: null,
      },
      {
        id: "automation-3",
        title: "Other active automation",
        status: "active",
        assigneeAgentId: "agent-2",
        projectId: "project-2",
        outputMode: "track_issue",
        triggers: [],
        lastRun: null,
      },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "list",
      "--org-id",
      "org-1",
      "--status",
      "active",
      "--assignee-agent-id",
      "agent-1",
      "--project-id",
      "project-1",
      "--output-mode",
      "track_issue",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/orgs/org-1/automations");
    expect(init.method).toBe("GET");
    expect(JSON.parse(output.stdoutText())).toEqual([
      expect.objectContaining({ id: "automation-1", title: "Daily triage" }),
    ]);
  });

  it("keeps inactive automation filters explicit instead of dropping paused rows implicitly", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        id: "automation-active",
        title: "Active",
        status: "active",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        outputMode: "track_issue",
        triggers: [],
        lastRun: null,
      },
      {
        id: "automation-paused",
        title: "Paused",
        status: "paused",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        outputMode: "track_issue",
        triggers: [],
        lastRun: null,
      },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "list",
      "--org-id",
      "org-1",
      "--status",
      "paused",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    expect(JSON.parse(output.stdoutText()).map((row: { id: string }) => row.id)).toEqual(["automation-paused"]);
  });

  it("sends automation mutations with agent and run attribution headers", async () => {
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "run-created" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "run",
      "automation-1",
      "--payload",
      "{\"manual\":true}",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/automations/automation-1/run");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-rudder-agent-id": "agent-1",
      "x-rudder-run-id": "run-1",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      payload: { manual: true },
      source: "manual",
    });
  });

  it("uses server chat search and clips human snippets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        id: "chat-1",
        title: "CLI parity",
        status: "active",
        preferredAgentId: null,
        unreadCount: 0,
        lastMessageAt: "2026-06-11T00:00:00.000Z",
        latestReplyPreview: null,
        latestUserMessagePreview: null,
        searchPreview: "needle " + "x".repeat(100),
      },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "chat",
      "search",
      "needle",
      "--org-id",
      "org-1",
      "--status",
      "all",
      "--snippet-chars",
      "20",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
    ])).resolves.toBe(0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/orgs/org-1/chats");
    expect(requestedUrl.searchParams.get("q")).toBe("needle");
    expect(requestedUrl.searchParams.get("status")).toBe("all");
    expect(output.stdoutText()).toContain("snippet=needle xxxxxxxxxxxx…");
  });

  it("requests paginated chat messages with transcript output controls", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        {
          id: "message-2",
          role: "assistant",
          kind: "message",
          status: "completed",
          createdAt: "2026-06-11T00:00:00.000Z",
          body: "done",
          transcript: [
            { kind: "tool_result", ts: "2026-06-11T00:00:00.000Z", toolUseId: "tool-1", content: "X".repeat(80), isError: false },
          ],
        },
      ],
      page: {
        cursor: "message-3",
        nextCursor: "message-2",
        hasMore: true,
        limit: 1,
        order: "newest",
        returnedMessages: 1,
        totalMessages: 3,
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "chat",
      "messages",
      "chat-1",
      "--cursor",
      "message-3",
      "--limit",
      "1",
      "--include-output",
      "--max-output-chars",
      "12",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/chats/chat-1/messages");
    expect(requestedUrl.searchParams.get("envelope")).toBe("true");
    expect(requestedUrl.searchParams.get("order")).toBe("newest");
    expect(requestedUrl.searchParams.get("cursor")).toBe("message-3");
    expect(requestedUrl.searchParams.get("limit")).toBe("1");
    expect(requestedUrl.searchParams.get("includeTranscript")).toBe("true");
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      page: {
        nextCursor: "message-2",
        hasMore: true,
      },
      messages: [
        {
          id: "message-2",
          transcript: [
            {
              content: "X".repeat(80),
            },
          ],
        },
      ],
    });
  });

  it("fails organization-scoped reads before making an API call when org id is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    const args = [
      process.execPath,
      "rudder",
      "runs",
      "list",
      "--context",
      createContextPath(),
      "--api-base",
      "http://localhost:3100",
      "--json",
    ];
    process.argv = args;
    await expect(runCli(args)).resolves.toBe(1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(parseFirstJsonObject(output.stderrText())).toMatchObject({
      code: "cli_error",
      error: expect.stringContaining("Organization ID is required"),
    });
  });

  it("prints API failures to stderr as JSON envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })));
    const output = captureOutput();

    const args = [
      process.execPath,
      "rudder",
      "runs",
      "get",
      "run-1",
      "--api-base",
      "http://localhost:3100",
      "--json",
    ];
    process.argv = args;
    await expect(runCli(args)).resolves.toBe(1);

    expect(parseFirstJsonObject(output.stderrText())).toMatchObject({
      status: 500,
      code: "api_request_error",
      error: "nope",
    });
  });

  it("renders runs errors with clipped output and transcript jump commands", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      run: { id: "run-1", status: "failed" },
      errors: [
        {
          id: "step-2",
          type: "tool_result",
          turnIndex: 1,
          summary: "command failed",
          output: { text: "E".repeat(20), clipped: true, originalLength: 5000 },
          transcriptContext: {
            id: "step-2",
            command: "rudder runs transcript run-1 --around-error step-2",
          },
        },
      ],
    }), { status: 200 })));
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "errors",
      "run-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
    ])).resolves.toBe(0);

    expect(output.stdoutText()).toContain("id=step-2");
    expect(output.stdoutText()).toContain("rudder runs transcript run-1 --around-error step-2");
  });

  it("requests run list filters with used skill evidence by default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        run: {
          id: "run-1",
          agentId: "agent-1",
          status: "failed",
          createdAt: "2026-06-11T00:00:00.000Z",
          finishedAt: "2026-06-11T00:01:00.000Z",
        },
        agentName: "Wesley",
        issue: { id: "issue-1", identifier: "ZST-1", title: "Optimize skill" },
        bundle: { agentRuntimeType: "codex_local" },
        langfuse: { traceUrl: "http://localhost:3000/project/test/traces/trace-1" },
        errorSummary: "adapter_error",
        skillEvidence: {
          evidenceType: "used",
          matchedSkillKey: "skill-optimizer",
          matchedSkillLabel: "Skill Optimizer",
        },
      },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "list",
      "--used-skill",
      "skill-optimizer",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
    ])).resolves.toBe(0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/run-intelligence/orgs/org-1/runs");
    expect(requestedUrl.searchParams.get("usedSkill")).toBe("skill-optimizer");
    expect(requestedUrl.searchParams.get("loadedSkill")).toBeNull();
    expect(output.stdoutText()).toContain("evidence=used");
    expect(output.stdoutText()).toContain("skill=skill-optimizer");
    expect(output.stdoutText()).toContain("rudder runs errors run-1");
  });

  it("builds a by-skill report and opts into loaded evidence explicitly", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        run: {
          id: "run-2",
          agentId: "agent-1",
          status: "succeeded",
          createdAt: "2026-06-11T00:00:00.000Z",
          finishedAt: "2026-06-11T00:02:00.000Z",
        },
        agentName: "Wesley",
        issue: { id: "issue-1", identifier: "ZST-1", title: "Optimize skill" },
        bundle: { agentRuntimeType: "codex_local" },
        langfuse: null,
        errorSummary: null,
        skillEvidence: {
          evidenceType: "loaded",
          matchedSkillKey: "skill-optimizer",
          matchedSkillLabel: "Skill Optimizer",
        },
      },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "by-skill",
      "skill-optimizer",
      "--evidence",
      "loaded",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/run-intelligence/orgs/org-1/runs");
    expect(requestedUrl.searchParams.get("loadedSkill")).toBe("skill-optimizer");
    expect(requestedUrl.searchParams.get("usedSkill")).toBeNull();
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      skill: { query: "skill-optimizer", evidenceType: "loaded" },
      summary: {
        total: 1,
        succeeded: 1,
        failed: 0,
      },
      nextCommands: ["rudder runs transcript run-2"],
    });
  });

  it("requests full run transcript JSON with cursor and output controls", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      run: { id: "run-1", status: "failed" },
      order: "newest",
      output: "full",
      page: {
        cursor: "step-9",
        nextCursor: null,
        hasMore: false,
        order: "newest",
        turnLimit: 2,
        returnedSteps: 1,
        totalFilteredSteps: 10,
      },
      rows: [],
      entries: [
        {
          id: "step-10",
          index: 10,
          turnIndex: 2,
          entry: { kind: "tool_result", content: "Y".repeat(200) },
          output: { text: "Y".repeat(200), clipped: false, originalLength: 200 },
        },
      ],
      transcript: [{ kind: "tool_result", content: "Y".repeat(200) }],
      trace: { turnCount: 2, stepCount: 10, payloadStepCount: 8, filteredStepCount: 10 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "transcript",
      "run-1",
      "--cursor",
      "step-9",
      "--turn-limit",
      "2",
      "--include-output",
      "--max-output-chars",
      "40",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/run-intelligence/runs/run-1/transcript");
    expect(requestedUrl.searchParams.get("output")).toBe("full");
    expect(requestedUrl.searchParams.get("cursor")).toBe("step-9");
    expect(requestedUrl.searchParams.get("turnLimit")).toBe("2");
    expect(requestedUrl.searchParams.get("includeOutputs")).toBe("true");
    expect(requestedUrl.searchParams.get("maxChars")).toBe("40");
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      output: "full",
      entries: [
        {
          entry: {
            content: "Y".repeat(200),
          },
          output: {
            clipped: false,
            originalLength: 200,
          },
        },
      ],
    });
  });

  it("surfaces mutation permission failures without swallowing attribution context", async () => {
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Missing permission: automation:run" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    const args = [
      process.execPath,
      "rudder",
      "automation",
      "run",
      "automation-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ];
    process.argv = args;
    await expect(runCli(args)).resolves.toBe(1);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      "x-rudder-agent-id": "agent-1",
      "x-rudder-run-id": "run-1",
    });
    expect(parseFirstJsonObject(output.stderrText())).toMatchObject({
      status: 403,
      code: "api_request_error",
      error: "Missing permission: automation:run",
    });
  });
});
