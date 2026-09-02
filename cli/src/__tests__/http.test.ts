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
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
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
    await expect(client.get("/api/issues/iss-1")).resolves.toEqual({ request: "second" });
    releaseFirst?.();
    await expect(first).resolves.toEqual({ request: "first" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses two concurrent matching 5xx responses as the complete backend budget", async () => {
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
    expect(errors.some((error) => error.code === "issue_transport_unavailable")).toBe(true);
    await expect(cli.get("/api/issues/iss-1/comments")).rejects.toMatchObject({
      status: 503,
      code: "issue_transport_unavailable",
      details: { issueTransport: { state: "blocked", fallbackBudgetRemaining: 0 } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(writeError).toMatchObject({
      message: "Internal server error; use the equivalent Rudder CLI fallback once: rudder issue comment iss-1 --body-file ./issue-comment.md --json",
      details: {
        issueTransport: {
          fallbackAction: {
            surface: "cli",
            command: "rudder issue comment iss-1 --body-file ./issue-comment.md --json",
          },
        },
      },
    });

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
