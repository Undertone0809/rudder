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

  it("creates automation triggers with schedule flags and attribution headers", async () => {
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      trigger: {
        id: "trigger-1",
        automationId: "automation-1",
        kind: "schedule",
        label: "Morning run",
        enabled: false,
        cronExpression: "0 9 * * *",
        timezone: "Asia/Shanghai",
      },
      secretMaterial: null,
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "triggers",
      "create",
      "automation-1",
      "--kind",
      "schedule",
      "--label",
      "Morning run",
      "--disabled",
      "--cron-expression",
      "0 9 * * *",
      "--timezone",
      "Asia/Shanghai",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/automations/automation-1/triggers");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-rudder-agent-id": "agent-1",
      "x-rudder-run-id": "run-1",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "schedule",
      label: "Morning run",
      enabled: false,
      cronExpression: "0 9 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(JSON.parse(output.stdoutText()).trigger.id).toBe("trigger-1");
  });

  it("preserves raw automation trigger payload timezone defaults", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      trigger: { id: "trigger-1", kind: "schedule" },
      secretMaterial: null,
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "triggers",
      "create",
      "automation-1",
      "--payload",
      "{\"kind\":\"schedule\",\"cronExpression\":\"0 10 * * *\",\"timezone\":\"America/New_York\"}",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "schedule",
      cronExpression: "0 10 * * *",
      timezone: "America/New_York",
      enabled: true,
    });
  });

  it("deletes automation triggers with stable JSON output", async () => {
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "triggers",
      "delete",
      "trigger-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/automation-triggers/trigger-1");
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({
      "x-rudder-agent-id": "agent-1",
      "x-rudder-run-id": "run-1",
    });
    expect(JSON.parse(output.stdoutText())).toEqual({ id: "trigger-1", deleted: true });
  });

  it("updates and rotates automation triggers through governed mutation routes", async () => {
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "trigger-1",
        label: "Renamed",
        enabled: true,
        replayWindowSec: 600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        trigger: { id: "trigger-1", kind: "webhook" },
        secretMaterial: { webhookUrl: "https://example.test/hook", webhookSecret: "secret" },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "triggers",
      "update",
      "trigger-1",
      "--label",
      "Renamed",
      "--enabled",
      "--replay-window-sec",
      "600",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    await expect(runCli([
      process.execPath,
      "rudder",
      "automation",
      "triggers",
      "rotate-secret",
      "trigger-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [updateUrl, updateInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(updateUrl).pathname).toBe("/api/automation-triggers/trigger-1");
    expect(updateInit.method).toBe("PATCH");
    expect(updateInit.headers).toMatchObject({
      "x-rudder-agent-id": "agent-1",
      "x-rudder-run-id": "run-1",
    });
    expect(JSON.parse(String(updateInit.body))).toEqual({
      label: "Renamed",
      enabled: true,
      replayWindowSec: 600,
    });

    const [rotateUrl, rotateInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URL(rotateUrl).pathname).toBe("/api/automation-triggers/trigger-1/rotate-secret");
    expect(rotateInit.method).toBe("POST");
    expect(rotateInit.headers).toMatchObject({
      "x-rudder-agent-id": "agent-1",
      "x-rudder-run-id": "run-1",
    });
    expect(JSON.parse(String(rotateInit.body))).toEqual({});
  });

  it("uses server chat search and clips human snippets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        id: "14ff96a7-2518-456a-8aae-480360f0d9aa",
        shortRef: "cht_14ff96a7",
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
    expect(output.stdoutText()).toContain("id=cht_14ff96a7");
    expect(output.stdoutText()).not.toContain("14ff96a7-2518-456a-8aae-480360f0d9aa");
    expect(output.stdoutText()).toContain("snippet=needle xxxxxxxxxxxx…");
  });

  it("prefers chat short refs in human list output while JSON preserves both identities", async () => {
    const row = {
      id: "14ff96a7-2518-456a-8aae-480360f0d9aa",
      shortRef: "cht_14ff96a7",
      title: "Short reference",
      status: "active",
      preferredAgentId: null,
      unreadCount: 0,
      lastMessageAt: "2026-06-11T00:00:00.000Z",
      latestReplyPreview: null,
      latestUserMessagePreview: "Compact discovery",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([row]), { status: 200 })));
    const output = captureOutput();
    const args = [
      process.execPath,
      "rudder",
      "chat",
      "list",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
    ];

    await expect(runCli(args)).resolves.toBe(0);
    expect(output.stdoutText()).toContain("id=cht_14ff96a7");
    expect(output.stdoutText()).not.toContain(row.id);

    output.stdout.mockClear();
    output.log.mockClear();
    await expect(runCli([...args, "--json", "--full-ids"])).resolves.toBe(0);
    expect(JSON.parse(output.stdoutText())).toEqual([expect.objectContaining({
      id: row.id,
      shortRef: row.shortRef,
    })]);
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

  it("prints chat message run linkage and follow-up run commands in human output", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        {
          id: "message-2",
          role: "assistant",
          kind: "message",
          status: "completed",
          runId: "609695f1-f90a-4b17-be61-4f0c6fe37c42",
          createdAt: "2026-06-11T00:00:00.000Z",
          body: "done",
          transcriptSummary: { entryCount: 3 },
        },
      ],
      page: {
        cursor: null,
        nextCursor: null,
        hasMore: false,
        limit: 1,
        order: "newest",
        returnedMessages: 1,
        totalMessages: 1,
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
      "--limit",
      "1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
    ])).resolves.toBe(0);

    expect(output.stdoutText()).toContain("runId=609695f1f90a");
    expect(output.stdoutText()).not.toContain("runId=609695f1-f90a-4b17-be61-4f0c6fe37c42");
    expect(output.stdoutText()).toContain("runCommand=rudder runs get 609695f1f90a");
    expect(output.stdoutText()).toContain("transcriptCommand=rudder runs transcript 609695f1f90a");
    expect(output.stdoutText()).not.toContain("609695f1-f90a-4b17-be61-4f0c6fe37c42");
  });

  it("sends agent-authored chat messages with agent and run attribution headers", async () => {
    process.env.RUDDER_AGENT_ID = "agent-1";
    process.env.RUDDER_RUN_ID = "run-1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        {
          id: "message-agent",
          role: "assistant",
          kind: "message",
          status: "completed",
          createdAt: "2026-06-11T00:00:00.000Z",
          body: "hello",
          replyingAgentId: "agent-1",
        },
      ],
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "chat",
      "send",
      "chat-1",
      "--body",
      "hello",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/chats/chat-1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer token-1",
      "content-type": "application/json",
      "x-rudder-agent-id": "agent-1",
      "x-rudder-run-id": "run-1",
    });
    expect(JSON.parse(String(init.body))).toEqual({ body: "hello" });
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      messages: [
        {
          id: "message-agent",
          role: "assistant",
          replyingAgentId: "agent-1",
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: "run-1",
        agentId: "agent-1",
        status: "failed",
        runtime: "codex_local",
        createdAt: "2026-06-11T00:00:00.000Z",
        finishedAt: "2026-06-11T00:01:00.000Z",
        agentName: "Wesley",
        issue: { id: "issue-1", identifier: "ZST-1", title: "Optimize skill" },
        error: "adapter_error",
        skillEvidence: {
          evidenceType: "used",
          matchedSkillKey: "skill-optimizer",
          matchedSkillLabel: "Skill Optimizer",
        },
      }],
      page: { limit: 50, hasMore: true, nextCursor: "next-summary-page" },
    }), { status: 200 }));
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
    expect(requestedUrl.searchParams.get("projection")).toBe("summary");
    expect(requestedUrl.searchParams.get("usedSkill")).toBe("skill-optimizer");
    expect(requestedUrl.searchParams.get("loadedSkill")).toBeNull();
    expect(output.stdoutText()).toContain("evidence=used");
    expect(output.stdoutText()).toContain("skill=skill-optimizer");
    expect(output.stdoutText()).toContain("rudder runs errors run-1");
    expect(output.stdoutText()).toContain("hasMore=true nextCursor=next-summary-page");
  });

  it("requests bounded run event and log pages", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      return new Response(JSON.stringify(pathname.endsWith("/events")
        ? { items: [], page: { hasMore: true, nextAfterSeq: 60 } }
        : { content: "log page", page: { eof: false, nextOffset: 512000 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "events",
      "run-1",
      "--after-seq",
      "40",
      "--limit",
      "20",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);
    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "log",
      "run-1",
      "--offset",
      "256000",
      "--limit-bytes",
      "256000",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const eventUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(eventUrl.searchParams.get("afterSeq")).toBe("40");
    expect(eventUrl.searchParams.get("limit")).toBe("20");
    const logUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(logUrl.searchParams.get("offset")).toBe("256000");
    expect(logUrl.searchParams.get("limitBytes")).toBe("256000");
    expect(output.stdoutText()).toContain("nextAfterSeq");
    expect(output.stdoutText()).toContain("nextOffset");
  });

  it("builds a by-skill report and opts into loaded evidence explicitly", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: "run-2",
        agentId: "agent-1",
        status: "succeeded",
        runtime: "codex_local",
        createdAt: "2026-06-11T00:00:00.000Z",
        finishedAt: "2026-06-11T00:02:00.000Z",
        agentName: "Wesley",
        issue: { id: "issue-1", identifier: "ZST-1", title: "Optimize skill" },
        error: null,
        skillEvidence: {
          evidenceType: "loaded",
          matchedSkillKey: "skill-optimizer",
          matchedSkillLabel: "Skill Optimizer",
        },
      }],
      page: { limit: 50, hasMore: true, nextCursor: "next-summary-page" },
    }), { status: 200 }));
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
    expect(requestedUrl.searchParams.get("projection")).toBe("summary");
    expect(requestedUrl.searchParams.get("loadedSkill")).toBe("skill-optimizer");
    expect(requestedUrl.searchParams.get("usedSkill")).toBeNull();
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      skill: { query: "skill-optimizer", evidenceType: "loaded" },
      summary: {
        total: 1,
        succeeded: 1,
        failed: 0,
      },
      page: { limit: 50, hasMore: true, nextCursor: "next-summary-page" },
      nextCommands: ["rudder runs transcript run-2"],
    });
  });

  it("prints the next summary cursor for a paginated by-skill report", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [],
      page: { limit: 50, hasMore: true, nextCursor: "next-skill-page" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "by-skill",
      "skill-optimizer",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
    ])).resolves.toBe(0);

    expect(output.stdoutText()).toContain("hasMore=true nextCursor=next-skill-page");
  });

  it("preserves the legacy by-skill report when full rows are requested", async () => {
    const rows = [{
      run: {
        id: "run-full-1",
        agentId: "agent-1",
        status: "failed",
        createdAt: "2026-06-11T00:00:00.000Z",
        finishedAt: null,
        resultJson: { raw: true },
      },
      agentName: "Wesley",
      issue: null,
      bundle: { agentRuntimeType: "codex_local" },
      errorSummary: "adapter_error",
      skillEvidence: {
        evidenceType: "used",
        matchedSkillKey: "rudder",
        matchedSkillLabel: "Rudder",
      },
    }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "by-skill",
      "rudder",
      "--org-id",
      "org-1",
      "--full",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const payload = JSON.parse(output.stdoutText());
    expect(payload.rows).toEqual(rows);
    expect(payload).not.toHaveProperty("page");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get("projection")).toBe("full");
    expect(new URL(url).searchParams.get("limit")).toBe("50");
  });

  it("returns a stable summary page for list JSON and preserves legacy full JSON", async () => {
    const summaryPage = {
      items: [{ id: "run-1", agentId: "agent-1", status: "failed", runtime: "codex_local" }],
      page: { limit: 1, hasMore: true, nextCursor: "next-page" },
    };
    const legacyRows = [{ run: { id: "run-1", resultJson: { large: true } } }];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestedUrl = new URL(String(input));
      return new Response(JSON.stringify(requestedUrl.searchParams.get("projection") === "summary" ? summaryPage : legacyRows), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const summaryOutput = captureOutput();
    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "list",
      "--org-id",
      "org-1",
      "--cursor",
      "current-page",
      "--limit",
      "1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);
    expect(JSON.parse(summaryOutput.stdoutText())).toEqual(summaryPage);

    summaryOutput.stdout.mockClear();
    summaryOutput.log.mockClear();
    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "list",
      "--org-id",
      "org-1",
      "--full",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);
    expect(JSON.parse(summaryOutput.stdoutText())).toEqual(legacyRows);

    const summaryUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const fullUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(summaryUrl.searchParams.get("projection")).toBe("summary");
    expect(summaryUrl.searchParams.get("cursor")).toBe("current-page");
    expect(fullUrl.searchParams.get("projection")).toBe("full");
    expect(fullUrl.searchParams.get("limit")).toBe("200");
  });

  it("keeps run transcript JSON compact with cursor and output controls", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      run: { id: "run-1", status: "failed" },
      order: "newest",
      output: "compact",
      page: {
        cursor: "step-9",
        nextCursor: null,
        hasMore: false,
        order: "newest",
        turnLimit: 2,
        returnedSteps: 1,
        totalFilteredSteps: 10,
      },
      rows: [{
        id: "step-10",
        index: 10,
        turnIndex: 2,
        kind: "tool_result",
        preview: "Y".repeat(40),
        output: { text: "Y".repeat(40), clipped: true, originalLength: 200 },
      }],
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
    expect(requestedUrl.searchParams.get("output")).toBe("compact");
    expect(requestedUrl.searchParams.get("cursor")).toBe("step-9");
    expect(requestedUrl.searchParams.get("turnLimit")).toBe("2");
    expect(requestedUrl.searchParams.get("includeOutputs")).toBe("true");
    expect(requestedUrl.searchParams.get("maxChars")).toBe("40");
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      output: "compact",
      rows: [
        {
          output: {
            clipped: true,
            originalLength: 200,
          },
        },
      ],
    });
  });

  it("requests a lossless transcript only with explicit --full", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      run: { id: "run-1", status: "failed" },
      order: "newest",
      output: "full",
      entries: [{
        id: "step-10",
        index: 10,
        turnIndex: 2,
        entry: { kind: "tool_result", content: "lossless output" },
      }],
      transcript: [{ kind: "tool_result", content: "lossless output" }],
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
      "--full",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
    ])).resolves.toBe(0);

    const [[requestedUrlValue]] = fetchMock.mock.calls as unknown as [[string, RequestInit]];
    const requestedUrl = new URL(requestedUrlValue);
    expect(requestedUrl.searchParams.get("output")).toBe("full");
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      output: "full",
      entries: [{ entry: { content: "lossless output" } }],
    });
  });

  it("prints non-empty chat run transcript rows from Run Intelligence", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      run: {
        id: "run-chat-1",
        status: "succeeded",
        invocationSource: "chat",
        triggerDetail: "chat_assistant_reply_stream",
      },
      order: "newest",
      output: "compact",
      page: {
        cursor: null,
        nextCursor: null,
        hasMore: false,
        order: "newest",
        turnLimit: 20,
        returnedSteps: 1,
        totalFilteredSteps: 1,
      },
      rows: [
        {
          id: "step-1",
          index: 1,
          turnIndex: 1,
          kind: "assistant",
          ts: "2026-06-17T09:00:01.000Z",
          label: "assistant",
          preview: "Chat reply from the agent",
          detailPreview: "Chat reply from the agent",
          isError: false,
          output: {
            text: "Chat reply from the agent",
            clipped: false,
            originalLength: 25,
          },
        },
      ],
      trace: { turnCount: 1, stepCount: 1, payloadStepCount: 0, filteredStepCount: 1 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const output = captureOutput();

    await expect(runCli([
      process.execPath,
      "rudder",
      "runs",
      "transcript",
      "run-chat-1",
      "--include-output",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
    ])).resolves.toBe(0);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/run-intelligence/runs/run-chat-1/transcript");
    expect(output.stdoutText()).toContain("step-1");
    expect(output.stdoutText()).toContain("assistant");
    expect(output.stdoutText()).toContain("Chat reply from the agent");
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
