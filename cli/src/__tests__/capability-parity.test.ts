import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";
import { writeContext } from "../client/context.js";

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
});
