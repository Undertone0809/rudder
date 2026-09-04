import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, RudderApiClient } from "../client/http.js";

describe("RudderApiClient", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function transportStateDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-issue-transport-test-"));
    tempDirs.push(dir);
    return dir;
  }

  async function captureApiError(request: Promise<unknown>): Promise<ApiRequestError> {
    try {
      await request;
    } catch (error) {
      if (error instanceof ApiRequestError) return error;
      throw error;
    }
    throw new Error("Expected request to fail with ApiRequestError");
  }

  it("adds authorization and agent context headers on mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      apiKey: "token-123",
      agentId: "agent-123",
      runId: "run-abc",
    });

    await client.post("/api/test", { hello: "world" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain("/api/test");

    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
    expect(headers["x-rudder-agent-id"]).toBe("agent-123");
    expect(headers["x-rudder-run-id"]).toBe("run-abc");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("does not attach agent context headers on read requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      apiKey: "token-123",
      agentId: "agent-123",
      runId: "run-abc",
    });

    await client.get("/api/test");

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
    expect(headers["x-rudder-agent-id"]).toBeUndefined();
    expect(headers["x-rudder-run-id"]).toBeUndefined();
  });

  it("does not reject concurrent healthy Issue reads before a 5xx is observed", async () => {
    const stateDir = await transportStateDir();
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        markFirstStarted?.();
        await firstGate;
        return new Response(JSON.stringify({ request: "first" }), { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ request: "second" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-healthy-concurrency",
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    const first = client.get("/api/issues/iss-1");
    await firstStarted;
    await expect(client.get("/api/issues/iss-1")).resolves.toEqual({ request: "second" });
    releaseFirst?.();
    await expect(first).resolves.toEqual({ request: "first" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the heterogeneous fallback after concurrent matching initial 5xx responses", async () => {
    const stateDir = await transportStateDir();
    let started = 0;
    let releaseFailures: (() => void) | undefined;
    let confirmBothStarted: (() => void) | undefined;
    const failuresGate = new Promise<void>((resolve) => { releaseFailures = resolve; });
    const bothStarted = new Promise<void>((resolve) => { confirmBothStarted = resolve; });
    const fetchMock = vi.fn().mockImplementation(async () => {
      started += 1;
      if (started === 2) confirmBothStarted?.();
      await failuresGate;
      return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-concurrent-failures",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    const first = captureApiError(mcp.get("/api/issues/iss-1/comments"));
    const second = captureApiError(mcp.get("/api/issues/iss-1/comments"));
    await bothStarted;
    releaseFailures?.();
    const errors = await Promise.all([first, second]);
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error.status === 500 && error.code === null)).toBe(true);
    await expect(cli.get("/api/issues/iss-1/comments")).rejects.toMatchObject({
      status: 500,
      code: "issue_transport_unavailable",
      details: {
        issueTransport: {
          state: "blocked",
          fallbackBudgetRemaining: 0,
          fallbackMatchedFingerprint: true,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns null on ignoreNotFound", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new RudderApiClient({ apiBase: "http://localhost:3100" });
    const result = await client.get("/api/missing", { ignoreNotFound: true });
    expect(result).toBeNull();
  });

  it("throws ApiRequestError with details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Issue checkout conflict",
          code: "issue_checkout_conflict",
          details: { issueId: "1" },
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new RudderApiClient({ apiBase: "http://localhost:3100" });

    await expect(client.post("/api/issues/1/checkout", {})).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout conflict",
      code: "issue_checkout_conflict",
      details: { issueId: "1" },
    } satisfies Partial<ApiRequestError>);
  });

  it("retries once after interactive auth recovery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Board access required" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const recoverAuth = vi.fn().mockResolvedValue("board-token-123");
    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      recoverAuth,
    });

    const result = await client.post<{ ok: boolean }>("/api/test", { hello: "world" });

    expect(result).toEqual({ ok: true });
    expect(recoverAuth).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders.authorization).toBe("Bearer board-token-123");
  });

  it("shares one heterogeneous Issue 5xx fallback across MCP and CLI clients", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-shared-budget",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    const first = await captureApiError(mcp.get("/api/issues/iss-1"));
    expect(first).toMatchObject({
      status: 500,
      message: "Internal server error; use the equivalent Rudder CLI fallback once: rudder issue get iss-1 --json",
      details: {
        issueTransport: {
          state: "fallback_available",
          operation: "issue.get",
          issueId: "iss-1",
          initialSurface: "mcp",
          fallbackBudgetRemaining: 1,
          fallbackAction: {
            surface: "cli",
            command: "rudder issue get iss-1 --json",
          },
          checkpoint: "Issue transport unavailable",
        },
      },
    });
    const fingerprint = (first.details as { issueTransport: { fingerprint: string } }).issueTransport.fingerprint;

    const fallback = await captureApiError(cli.get("/api/issues/iss-1"));
    expect(fallback).toMatchObject({
      status: 500,
      code: "issue_transport_unavailable",
      message: "Issue transport unavailable",
      details: {
        issueTransport: {
          state: "blocked",
          fingerprint,
          initialSurface: "mcp",
          fallbackSurface: "cli",
          fallbackBudgetRemaining: 0,
          fallbackAction: null,
        },
      },
    });

    await expect(mcp.get("/api/issues/iss-1")).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
      details: {
        issueTransport: {
          state: "blocked",
          fingerprint,
          fallbackBudgetRemaining: 0,
          fallbackMatchedFingerprint: true,
          fallbackAction: null,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders an operation-specific CLI fallback with the original Issue arguments", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const mcp = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-fallback-command",
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    const listError = await captureApiError(mcp.get(
      "/api/issues/iss-1/comments?after=cmt_after&order=asc",
    ));
    expect(listError).toMatchObject({
      message: "Internal server error; use the equivalent Rudder CLI fallback once: rudder issue comments list iss-1 --after cmt_after --order asc --json",
      details: {
        issueTransport: {
          fallbackAction: {
            surface: "cli",
            command: "rudder issue comments list iss-1 --after cmt_after --order asc --json",
          },
        },
      },
    });

    const commentError = await captureApiError(mcp.get(
      "/api/issues/iss-1/comments/cmt_target",
    ));
    expect(commentError).toMatchObject({
      message: "Internal server error; use the equivalent Rudder CLI fallback once: rudder issue comments get iss-1 cmt_target --json",
      details: {
        issueTransport: {
          fallbackAction: {
            surface: "cli",
            command: "rudder issue comments get iss-1 cmt_target --json",
          },
        },
      },
    });

    const contextError = await captureApiError(mcp.get(
      "/api/issues/iss-1/heartbeat-context?wakeCommentId=cmt_wake",
    ));
    expect(contextError).toMatchObject({
      message: "Internal server error; use the equivalent Rudder CLI fallback once: rudder issue context iss-1 --wake-comment-id cmt_wake --json",
      details: {
        issueTransport: {
          fallbackAction: {
            surface: "cli",
            command: "rudder issue context iss-1 --wake-comment-id cmt_wake --json",
          },
        },
      },
    });

    const writeError = await captureApiError(mcp.post(
      "/api/issues/iss-1/comments",
      { body: "preserve this comment", reopen: true },
    ));
    const writeFallback = (writeError.details as {
      issueTransport: { fallbackAction: { command: string } };
    }).issueTransport.fallbackAction;
    expect(writeError.message).toContain("use the equivalent Rudder CLI fallback once:");
    expect(writeFallback.command).toMatch(
      /^rudder issue comment iss-1 --body-file \/.+ --reopen --json$/,
    );
    const bodyFile = writeFallback.command.match(/--body-file (\S+) --reopen --json/)?.[1];
    expect(bodyFile).toBeTruthy();
    expect(await fs.readFile(bodyFile!, "utf8")).toBe("preserve this comment");

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("points a CLI-origin failure at the equivalent MCP tool", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const cli = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-cli-first",
      transportSurface: "cli",
      transportStateDir: stateDir,
    });

    const error = await captureApiError(cli.get("/api/issues/iss-1/comments"));
    expect(error).toMatchObject({
      message: "Internal server error; use the equivalent Rudder MCP fallback once: rudder_issue_comments_list",
      details: {
        issueTransport: {
          fallbackAction: {
            surface: "mcp",
            tool: "rudder_issue_comments_list",
          },
        },
      },
    });
  });

  it("uses the current arguments when a same-surface read is short-circuited", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const mcp = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-current-fallback-arguments",
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    await expect(mcp.get("/api/issues/iss-1/comments/cmt-first")).rejects.toMatchObject({
      details: {
        issueTransport: {
          fallbackAction: {
            command: "rudder issue comments get iss-1 cmt-first --json",
          },
        },
      },
    });
    await expect(mcp.get("/api/issues/iss-1/comments/cmt-second")).rejects.toMatchObject({
      status: 503,
      message: "Issue transport unavailable; use the equivalent Rudder CLI fallback once: rudder issue comments get iss-1 cmt-second --json",
      details: {
        issueTransport: {
          fallbackAction: {
            surface: "cli",
            command: "rudder issue comments get iss-1 cmt-second --json",
          },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scopes Issue list and search budgets by organization and project, not query filters", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-issue-collection-scope",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    const firstList = await captureApiError(
      mcp.get("/api/orgs/org-1/issues?projectId=project-1&status=todo"),
    );
    expect(firstList).toMatchObject({
      details: {
        issueTransport: {
          operation: "issue.list",
          scopeKey: "org:org-1|project:project-1",
          issueId: null,
          initialSurface: "mcp",
          fallbackBudgetRemaining: 1,
          fallbackAction: {
            surface: "cli",
            command: "rudder issue list --org-id org-1 --status todo --project-id project-1 --json",
          },
        },
      },
    });
    const sharedSearch = await captureApiError(
      mcp.get("/api/orgs/org-1/issues?projectId=project-1&q=first-search&status=done"),
    );
    expect(sharedSearch).toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
      details: {
        issueTransport: {
          operation: "issue.search",
          scopeKey: "org:org-1|project:project-1",
          fallbackBudgetRemaining: 1,
          fallbackAction: {
            surface: "cli",
            command: "rudder issue search first-search --org-id org-1 --status done --project-id project-1 --json",
          },
        },
      },
    });
    await expect(cli.get("/api/orgs/org-1/issues?projectId=project-1&q=different-search&status=in_progress")).rejects.toMatchObject({
      code: "issue_transport_unavailable",
      details: {
        issueTransport: {
          operation: "issue.search",
          scopeKey: "org:org-1|project:project-1",
          fallbackMatchedFingerprint: true,
        },
      },
    });
    await expect(mcp.get("/api/orgs/org-1/issues?projectId=project-1&status=done")).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
    });

    const firstSearch = await captureApiError(
      mcp.get("/api/orgs/org-1/issues?projectId=project-2&q=first-search&assigneeAgentId=agent-1"),
    );
    expect(firstSearch).toMatchObject({
      details: {
        issueTransport: {
          operation: "issue.search",
          scopeKey: "org:org-1|project:project-2",
          fallbackAction: {
            surface: "cli",
            command: "rudder issue search first-search --org-id org-1 --assignee-agent-id agent-1 --project-id project-2 --json",
          },
        },
      },
    });
    await expect(cli.get("/api/orgs/org-1/issues?projectId=project-2&q=different-search&assigneeAgentId=agent-2")).rejects.toMatchObject({
      code: "issue_transport_unavailable",
      details: { issueTransport: { scopeKey: "org:org-1|project:project-2" } },
    });

    await expect(mcp.get("/api/orgs/org-1/issues?projectId=project-2&q=different-search")).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
      details: { issueTransport: { scopeKey: "org:org-1|project:project-2" } },
    });
    await expect(mcp.get("/api/orgs/org-2/issues?projectId=project-1&q=different-search")).rejects.toMatchObject({
      status: 500,
      details: { issueTransport: { scopeKey: "org:org-2|project:project-1" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("scopes runs list budgets by organization or linked Issue, ignoring list filters", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-runs-collection-scope",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    const firstOrg = await captureApiError(
      mcp.get("/api/run-intelligence/orgs/org-1/runs?projection=summary&agentId=rowan&limit=50"),
    );
    expect(firstOrg).toMatchObject({
      details: {
        issueTransport: {
          operation: "runs.list",
          scopeKey: "org:org-1",
          issueId: null,
          fallbackAction: {
            surface: "cli",
            command: "rudder runs list --org-id org-1 --agent-id rowan --limit 50 --json",
          },
        },
      },
    });
    await expect(cli.get("/api/run-intelligence/orgs/org-1/runs?projection=summary&agentId=alex&limit=100")).rejects.toMatchObject({
      code: "issue_transport_unavailable",
      details: { issueTransport: { scopeKey: "org:org-1" } },
    });
    await expect(mcp.get("/api/run-intelligence/orgs/org-1/runs?projection=summary&agentId=sage&limit=20")).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
    });

    const firstIssue = await captureApiError(
      mcp.get("/api/run-intelligence/orgs/org-1/runs?issueId=issue-1&agentId=rowan&limit=50"),
    );
    expect(firstIssue).toMatchObject({
      details: {
        issueTransport: {
          scopeKey: "org:org-1|issue:issue-1",
          issueId: "issue-1",
          fallbackAction: {
            surface: "cli",
            command: "rudder runs list --org-id org-1 --agent-id rowan --issue-id issue-1 --limit 50 --json",
          },
        },
      },
    });
    await expect(cli.get("/api/run-intelligence/orgs/org-1/runs?issueId=issue-1&agentId=alex&limit=100")).rejects.toMatchObject({
      code: "issue_transport_unavailable",
      details: { issueTransport: { scopeKey: "org:org-1|issue:issue-1" } },
    });
    await expect(mcp.get("/api/run-intelligence/orgs/org-2/runs?issueId=issue-1&limit=20")).rejects.toMatchObject({
      status: 500,
      details: { issueTransport: { scopeKey: "org:org-2|issue:issue-1" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("gates concurrent collection fanout behind one readiness probe", async () => {
    const stateDir = await transportStateDir();
    let releaseFailure: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchMock = vi.fn().mockImplementation(async () => {
      markStarted?.();
      await failureGate;
      return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mcp = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-collection-fanout",
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    const first = captureApiError(mcp.get("/api/orgs/org-1/issues?projectId=project-1&q=probe"));
    await requestStarted;
    const second = captureApiError(mcp.get("/api/orgs/org-1/issues?projectId=project-1&q=fanout"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFailure?.();

    await expect(first).resolves.toMatchObject({
      status: 500,
      details: { issueTransport: { state: "fallback_available" } },
    });
    await expect(second).resolves.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
      details: { issueTransport: { state: "fallback_available" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("extends an unresolved collection probe to the backoff before retrying", async () => {
    const stateDir = await transportStateDir();
    const runId = "run-collection-probe-timeout";
    const scopeKey = "org:org-1|project:project-1";
    const stateFile = path.join(
      stateDir,
      "issue-transport-budget",
      `${createHash("sha256").update([runId, "issue.collection", scopeKey].join("\n")).digest("hex")}.json`,
    );
    const startedAt = Date.now();
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, `${JSON.stringify({
      operation: "issue.list",
      scopeKey,
      phase: "probe_in_flight",
      initialSurface: "mcp",
      probeBackoff: false,
      generation: 1,
      activeReservations: ["probe-owner"],
      observedAt: startedAt,
      expiresAt: startedAt + 20,
    })}\n`);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId,
      transportSurface: "mcp",
      transportStateDir: stateDir,
      transportBackoffMs: 150,
    });

    const request = client.get("/api/orgs/org-1/issues?projectId=project-1&q=probe");
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(fetchMock).not.toHaveBeenCalled();
    const extended = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
      phase: string;
      probeBackoff: boolean;
      expiresAt: number;
    };
    expect(extended).toMatchObject({ phase: "probe_in_flight", probeBackoff: true });
    expect(extended.expiresAt).toBeGreaterThan(startedAt + 100);

    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets concurrent collection reads continue after a healthy probe", async () => {
    const stateDir = await transportStateDir();
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        markStarted?.();
        await firstGate;
        return new Response(JSON.stringify({ request: "probe" }), { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ request: "fanout" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const mcp = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-healthy-collection-fanout",
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    const first = mcp.get("/api/orgs/org-1/issues?projectId=project-1&q=probe");
    await firstStarted;
    const second = mcp.get("/api/orgs/org-1/issues?projectId=project-1&q=fanout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await expect(first).resolves.toEqual({ request: "probe" });
    await expect(second).resolves.toEqual({ request: "fanout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses legacy Issue state that only contains issueId", async () => {
    const stateDir = await transportStateDir();
    const runId = "run-legacy-issue-state";
    const issueId = "iss-legacy";
    const normalizedMessage = "internal server error";
    const legacyFingerprint = createHash("sha256")
      .update(["issue.get", issueId, 500, "api_request_error", normalizedMessage].join("\n"))
      .digest("hex");
    const stateFile = path.join(
      stateDir,
      "issue-transport-budget",
      `${createHash("sha256").update([runId, "issue.get", issueId].join("\n")).digest("hex")}.json`,
    );
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, `${JSON.stringify({
      operation: "issue.get",
      issueId,
      phase: "fallback_available",
      initialSurface: "mcp",
      failure: {
        fingerprint: legacyFingerprint,
        status: 500,
        code: "api_request_error",
        normalizedMessage,
      },
      observedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })}\n`);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cli = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId,
      transportSurface: "cli",
      transportStateDir: stateDir,
    });

    await expect(cli.get(`/api/issues/${issueId}`)).rejects.toMatchObject({
      status: 500,
      code: "issue_transport_unavailable",
      details: {
        issueTransport: {
          scopeKey: `issue:${issueId}`,
          fallbackMatchedFingerprint: true,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose legacy comment fallback guidance without a preserved body", async () => {
    const stateDir = await transportStateDir();
    const runId = "run-legacy-comment-state";
    const issueId = "iss-legacy-comment";
    const normalizedMessage = "internal server error";
    const legacyFingerprint = createHash("sha256")
      .update(["issue.comment", issueId, 500, "api_request_error", normalizedMessage].join("\n"))
      .digest("hex");
    const stateFile = path.join(
      stateDir,
      "issue-transport-budget",
      `${createHash("sha256").update([runId, "issue.comment", issueId].join("\n")).digest("hex")}.json`,
    );
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, `${JSON.stringify({
      operation: "issue.comment",
      issueId,
      phase: "fallback_available",
      initialSurface: "mcp",
      fallbackCommand: "rudder issue comment iss-legacy-comment --body-file ./issue-comment.md --json",
      failure: {
        fingerprint: legacyFingerprint,
        status: 500,
        code: "api_request_error",
        normalizedMessage,
      },
      observedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })}\n`);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mcp = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId,
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    await expect(mcp.post(`/api/issues/${issueId}/comments`, { body: "new body" })).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
      message: "Issue transport unavailable",
      details: {
        issueTransport: {
          fallbackAction: null,
          fallbackBudgetRemaining: 1,
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the budget lock cannot be acquired", async () => {
    const stateDir = await transportStateDir();
    const runId = "run-lock-failure";
    const issueId = "iss-lock";
    const stateFile = path.join(
      stateDir,
      "issue-transport-budget",
      `${createHash("sha256").update([runId, "issue.get", issueId].join("\n")).digest("hex")}.json`,
    );
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(`${stateFile}.lock`, "stale lock\n");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId,
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    await expect(client.get(`/api/issues/${issueId}`)).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
      details: { issueTransport: { state: "blocked", checkpoint: "Issue transport unavailable" } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the budget state is malformed", async () => {
    const stateDir = await transportStateDir();
    const runId = "run-corrupt-state";
    const issueId = "iss-corrupt";
    const stateFile = path.join(
      stateDir,
      "issue-transport-budget",
      `${createHash("sha256").update([runId, "issue.get", issueId].join("\n")).digest("hex")}.json`,
    );
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, "{not-json\n");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId,
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    await expect(client.get(`/api/issues/${issueId}`)).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let a late success clear a concurrent Issue failure", async () => {
    const stateDir = await transportStateDir();
    let releaseFailure: (() => void) | undefined;
    let releaseSuccess: (() => void) | undefined;
    let markFailureStarted: (() => void) | undefined;
    let markSuccessStarted: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const successGate = new Promise<void>((resolve) => { releaseSuccess = resolve; });
    const failureStarted = new Promise<void>((resolve) => { markFailureStarted = resolve; });
    const successStarted = new Promise<void>((resolve) => { markSuccessStarted = resolve; });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        markFailureStarted?.();
        await failureGate;
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
      })
      .mockImplementationOnce(async () => {
        markSuccessStarted?.();
        await successGate;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-generation-success",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    const first = captureApiError(mcp.get("/api/issues/iss-1/comments"));
    await failureStarted;
    const second = mcp.get("/api/issues/iss-1/comments");
    await successStarted;
    releaseFailure?.();
    await expect(first).resolves.toMatchObject({
      status: 500,
      details: { issueTransport: { state: "fallback_available" } },
    });
    releaseSuccess?.();
    await expect(second).resolves.toEqual({ ok: true });
    await expect(cli.get("/api/issues/iss-1/comments")).rejects.toMatchObject({
      status: 500,
      code: "issue_transport_unavailable",
      details: { issueTransport: { state: "blocked" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears a failure when an alternate-surface request was already in flight and succeeds", async () => {
    const stateDir = await transportStateDir();
    let releaseFailure: (() => void) | undefined;
    let releaseSuccess: (() => void) | undefined;
    let markFailureStarted: (() => void) | undefined;
    let markSuccessStarted: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const successGate = new Promise<void>((resolve) => { releaseSuccess = resolve; });
    const failureStarted = new Promise<void>((resolve) => { markFailureStarted = resolve; });
    const successStarted = new Promise<void>((resolve) => { markSuccessStarted = resolve; });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        markFailureStarted?.();
        await failureGate;
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
      })
      .mockImplementationOnce(async () => {
        markSuccessStarted?.();
        await successGate;
        return new Response(JSON.stringify({ ok: "alternate" }), { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: "recovered" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-alternate-concurrent-success",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    const first = captureApiError(mcp.get("/api/issues/iss-1/comments"));
    await failureStarted;
    const alternate = cli.get("/api/issues/iss-1/comments");
    await successStarted;
    releaseFailure?.();
    await expect(first).resolves.toMatchObject({
      status: 500,
      details: { issueTransport: { state: "fallback_available" } },
    });
    releaseSuccess?.();
    await expect(alternate).resolves.toEqual({ ok: "alternate" });
    await expect(mcp.get("/api/issues/iss-1/comments")).resolves.toEqual({ ok: "recovered" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores a late fallback failure after expiry starts a fresh generation", async () => {
    const stateDir = await transportStateDir();
    let now = 1_000;
    let releaseFallback: (() => void) | undefined;
    let markFallbackStarted: (() => void) | undefined;
    const fallbackGate = new Promise<void>((resolve) => { releaseFallback = resolve; });
    const fallbackStarted = new Promise<void>((resolve) => { markFallbackStarted = resolve; });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }))
      .mockImplementationOnce(async () => {
        markFallbackStarted?.();
        await fallbackGate;
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: "recovered" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: "again" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-generation-expiry",
      transportStateDir: stateDir,
      transportBackoffMs: 1_000,
      now: () => now,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    await expect(mcp.get("/api/issues/iss-1/comments")).rejects.toMatchObject({ status: 500 });
    const fallback = captureApiError(cli.get("/api/issues/iss-1/comments"));
    await fallbackStarted;
    now = 3_001;
    await expect(mcp.get("/api/issues/iss-1/comments")).resolves.toEqual({ ok: "recovered" });
    releaseFallback?.();
    await expect(fallback).resolves.toMatchObject({ status: 500 });
    await expect(mcp.get("/api/issues/iss-1/comments")).resolves.toEqual({ ok: "again" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not spend the fallback budget on a repeated call from the same surface", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-same-surface",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    await expect(mcp.get("/api/issues/iss-1/comments")).rejects.toMatchObject({ status: 500 });
    await expect(mcp.get("/api/issues/iss-1/comments")).rejects.toMatchObject({
      status: 503,
      message: "Issue transport unavailable; use the equivalent Rudder CLI fallback once: rudder issue comments list iss-1 --json",
      details: {
        issueTransport: {
          state: "fallback_available",
          fallbackBudgetRemaining: 1,
          fallbackAction: {
            surface: "cli",
            command: "rudder issue comments list iss-1 --json",
          },
        },
      },
    });
    await expect(cli.get("/api/issues/iss-1/comments")).rejects.toMatchObject({
      code: "issue_transport_unavailable",
      details: {
        issueTransport: {
          state: "blocked",
          fallbackBudgetRemaining: 0,
          fallbackAction: null,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an exhausted Issue budget across API base or profile changes", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      runId: "run-profile-bypass",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({
      ...common,
      apiBase: "http://primary.test",
      transportSurface: "mcp",
    });
    const cliFallback = new RudderApiClient({
      ...common,
      apiBase: "http://fallback-profile.test",
      transportSurface: "cli",
    });
    const switchedAgain = new RudderApiClient({
      ...common,
      apiBase: "http://direct-api.test",
      transportSurface: "cli",
    });

    await expect(mcp.get("/api/issues/iss-1")).rejects.toMatchObject({ status: 500 });
    await expect(cliFallback.get("/api/issues/iss-1")).rejects.toMatchObject({
      code: "issue_transport_unavailable",
    });
    await expect(switchedAgain.get("/api/issues/iss-1")).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the Issue transport short circuit after a successful fallback", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: "again" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      apiBase: "http://localhost:3100",
      runId: "run-recovered",
      transportStateDir: stateDir,
    };
    const mcp = new RudderApiClient({ ...common, transportSurface: "mcp" });
    const cli = new RudderApiClient({ ...common, transportSurface: "cli" });

    await expect(mcp.get("/api/issues/iss-1/heartbeat-context")).rejects.toMatchObject({ status: 500 });
    await expect(cli.get("/api/issues/iss-1/heartbeat-context")).resolves.toEqual({ ok: true });
    await expect(mcp.get("/api/issues/iss-1/heartbeat-context")).resolves.toEqual({ ok: "again" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("allows a fresh Issue transport probe after the bounded backoff", async () => {
    const stateDir = await transportStateDir();
    let now = 1_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const mcp = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-backoff",
      transportSurface: "mcp",
      transportStateDir: stateDir,
      transportBackoffMs: 60_000,
      now: () => now,
    });

    await expect(mcp.post("/api/issues/iss-1/comments", { body: "checkpoint" })).rejects.toMatchObject({ status: 500 });
    now += 60_001;
    await expect(mcp.post("/api/issues/iss-1/comments", { body: "checkpoint" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not apply Issue read/comment fallback state to lifecycle requests", async () => {
    const stateDir = await transportStateDir();
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RudderApiClient({
      apiBase: "http://localhost:3100",
      runId: "run-lifecycle",
      transportSurface: "mcp",
      transportStateDir: stateDir,
    });

    await expect(client.post("/api/issues/iss-1/checkout", {})).rejects.toMatchObject({ status: 500 });
    await expect(client.patch("/api/issues/iss-1", { status: "done" })).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
