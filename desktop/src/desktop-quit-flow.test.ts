import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appExitMock = vi.hoisted(() => vi.fn());
const appQuitMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    exit: appExitMock,
    quit: appQuitMock,
  },
  dialog: {
    showMessageBox: vi.fn(),
  },
}));

const { createDesktopQuitFlow } = await import("./desktop-quit-flow.js");

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

async function readQuitResponse(responsePath: string) {
  return JSON.parse(await readFile(responsePath, "utf8")) as unknown;
}

describe("desktop quit flow update handoff", () => {
  beforeEach(() => {
    appExitMock.mockReset();
    appQuitMock.mockReset();
  });

  it("waits for Browser import cancellation cleanup before stopping the runtime", async () => {
    let finishBrowserCleanup!: () => void;
    const browserCleanup = new Promise<void>((resolve) => {
      finishBrowserCleanup = resolve;
    });
    const lifecycle: string[] = [];
    const prepareForQuit = vi.fn(async () => {
      lifecycle.push("browser:cleanup:start");
      await browserCleanup;
      lifecycle.push("browser:cleanup:end");
    });
    const stopLocalRudder = vi.fn(async () => {
      lifecycle.push("runtime:stop");
    });
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => null,
      setMainWindow: vi.fn(),
      getServerHandle: () => null,
      fetchApi: globalThis.fetch,
      prepareForQuit,
      stopLocalRudder,
      destroyResidentTray: vi.fn(),
    });

    const quitting = quitFlow.beginQuitFlow();
    await vi.waitFor(() => expect(prepareForQuit).toHaveBeenCalledTimes(1));
    expect(stopLocalRudder).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();

    finishBrowserCleanup();
    await quitting;
    expect(lifecycle).toEqual(["browser:cleanup:start", "browser:cleanup:end", "runtime:stop"]);
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it("stops renderer requests before shutting down the owned runtime", async () => {
    const lifecycle: string[] = [];
    let destroyed = false;
    const mainWindow = {
      isDestroyed: vi.fn(() => destroyed),
      destroy: vi.fn(() => {
        lifecycle.push("window:destroy");
        destroyed = true;
      }),
    };
    const setMainWindow = vi.fn(() => lifecycle.push("window:clear"));
    const stopLocalRudder = vi.fn(async () => {
      lifecycle.push("runtime:stop");
    });
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => mainWindow as never,
      setMainWindow,
      getServerHandle: () => null,
      fetchApi: globalThis.fetch,
      prepareForQuit: vi.fn(async () => lifecycle.push("browser:cleanup")),
      prepareLocalAppsForQuit: vi.fn(async () => lifecycle.push("local-apps:cleanup")),
      stopLocalRudder,
      destroyResidentTray: vi.fn(),
    });

    await quitFlow.beginQuitFlow();

    expect(lifecycle).toEqual([
      "browser:cleanup",
      "local-apps:cleanup",
      "window:destroy",
      "window:clear",
      "runtime:stop",
    ]);
    expect(appQuitMock).toHaveBeenCalledOnce();
  });

  it("hands a natural quit to automatic apply before stopping the runtime", async () => {
    const beforeFinalizeQuit = vi.fn(async () => "handled" as const);
    const stopLocalRudder = vi.fn(async () => undefined);
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => null,
      setMainWindow: vi.fn(),
      getServerHandle: () => null,
      fetchApi: globalThis.fetch,
      beforeFinalizeQuit,
      stopLocalRudder,
      destroyResidentTray: vi.fn(),
    });

    await quitFlow.beginQuitFlow();

    expect(beforeFinalizeQuit).toHaveBeenCalledTimes(1);
    expect(stopLocalRudder).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();
  });

  it("logs Local App cleanup failures distinctly and continues the watchdog-backed quit fallback", async () => {
    const cleanupError = new AggregateError([new Error("binding-a: still alive")], "Local App cleanup failed");
    const prepareForQuit = vi.fn(async () => undefined);
    const prepareLocalAppsForQuit = vi.fn(async () => { throw cleanupError; });
    const stopLocalRudder = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => null,
        fetchApi: globalThis.fetch,
        prepareForQuit,
        prepareLocalAppsForQuit,
        stopLocalRudder,
        destroyResidentTray: vi.fn(),
      });

      await quitFlow.beginQuitFlow();

      expect(prepareForQuit).toHaveBeenCalledOnce();
      expect(prepareLocalAppsForQuit).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        "[rudder-desktop] failed to verify Local App cleanup before quit; continuing with watchdog fallback",
        cleanupError,
      );
      expect(warning.mock.calls.some(([message]) => String(message).includes("Browser cleanup"))).toBe(false);
      expect(stopLocalRudder).toHaveBeenCalledOnce();
      expect(appQuitMock).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("fails closed when update blocker inspection has no runtime handle", async () => {
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => null,
      setMainWindow: vi.fn(),
      getServerHandle: () => null,
      fetchApi: globalThis.fetch,
      stopLocalRudder: vi.fn(),
      destroyResidentTray: vi.fn(),
    });

    await expect(quitFlow.listActiveRunsForQuit()).resolves.toEqual({
      totalRuns: 0,
      organizations: [],
    });
    await expect(quitFlow.listRunningRunsForUpdate()).rejects.toThrow(
      "Local Rudder runtime is not ready for update blocker inspection",
    );
  });

  it("keeps broad quit activity but exposes only running work as update blockers", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") {
        return jsonResponse([
          { id: "org-a", name: "Current Org" },
          { id: "org-b", name: "Z Studio" },
        ]);
      }
      if (pathName === "/api/orgs/org-a/live-runs") {
        return jsonResponse([{ id: "run-queued", status: "queued", agentId: "agent-mia", agentName: "Mia" }]);
      }
      if (pathName === "/api/orgs/org-b/live-runs") {
        return jsonResponse([
          { id: "f5258de4-running", status: "running", agentId: "agent-wesley", agentName: "Wesley", issueId: "issue-776" },
          { id: "run-finalizing", status: "succeeded", agentId: "agent-wesley", agentName: "Wesley" },
        ]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;

    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: globalThis.fetch,
        stopLocalRudder: vi.fn(),
        destroyResidentTray: vi.fn(),
      });

      await expect(quitFlow.listActiveRunsForQuit()).resolves.toMatchObject({ totalRuns: 3 });
      const updateBlockers = await quitFlow.listRunningRunsForUpdate();
      expect(updateBlockers).toEqual({
        totalRuns: 1,
        organizations: [{
          id: "org-b",
          name: "Z Studio",
          runs: [expect.objectContaining({ id: "f5258de4-running", status: "running" })],
        }],
        blockers: [{
          runId: "f5258de4-running",
          agentId: "agent-wesley",
          agentName: "Wesley",
          issueId: "issue-776",
          organizationId: "org-b",
          organizationName: "Z Studio",
        }],
      });
      expect(quitFlow.formatUpdateRunDetail(updateBlockers)).toBe("Z Studio: Wesley (run f5258de4)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the Electron session fetch with credentials for authenticated blocker inspection", async () => {
    const fetchApi = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      expect(init?.credentials).toBe("include");
      if (pathName === "/api/orgs") {
        return jsonResponse([{ id: "org-auth", name: "Authenticated Org" }]);
      }
      if (pathName === "/api/orgs/org-auth/live-runs") {
        return jsonResponse([]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const globalFetch = vi.spyOn(globalThis, "fetch");
    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3200", runtime: { mode: "owned" } }),
        fetchApi,
        stopLocalRudder: vi.fn(),
        destroyResidentTray: vi.fn(),
      });

      await expect(quitFlow.listRunningRunsForUpdate()).resolves.toEqual({
        totalRuns: 0,
        organizations: [],
        blockers: [],
      });
      expect(fetchApi).toHaveBeenCalledTimes(2);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("allows update quit when only queued or terminal records remain", async () => {
    const stopLocalRudder = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (url: string) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      if (pathName === "/api/orgs/org-1/live-runs") {
        return jsonResponse([
          { id: "run-queued", status: "queued", agentName: "Mia" },
          { id: "run-finalizing", status: "succeeded", agentName: "Wesley" },
        ]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    const responseDir = await mkdtemp(path.join(tmpdir(), "rudder-update-non-running-response."));
    const responsePath = path.join(responseDir, "response.json");

    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: globalThis.fetch,
        stopLocalRudder,
        destroyResidentTray: vi.fn(),
      });

      await quitFlow.handleUpdateQuitRequest(responsePath);

      expect(await readQuitResponse(responsePath)).toMatchObject({ ok: true, status: "quitting" });
      expect(fetchMock.mock.calls.some(([url, init]) =>
        new URL(String(url)).pathname.includes("/heartbeat-runs/") && init?.method === "POST")).toBe(false);
      expect(stopLocalRudder).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(responseDir, { recursive: true, force: true });
    }
  });

  it("cancels active runs before confirming a forced update quit", async () => {
    const stopLocalRudder = vi.fn(async () => undefined);
    const destroyResidentTray = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") {
        return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      }
      if (pathName === "/api/orgs/org-1/live-runs") {
        const cancelCalls = fetchMock.mock.calls.filter(([requestUrl, requestInit]) =>
          new URL(String(requestUrl)).pathname.includes("/heartbeat-runs/")
          && requestInit?.method === "POST");
        return jsonResponse(cancelCalls.length === 0
          ? [{ id: "run-1", status: "running", agentName: "Codex" }]
          : []);
      }
      if (pathName === "/api/heartbeat-runs/run-1/cancel" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    const responseDir = await mkdtemp(path.join(tmpdir(), "rudder-update-quit-response."));
    const responsePath = path.join(responseDir, "response.json");

    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: globalThis.fetch,
        stopLocalRudder,
        destroyResidentTray,
      });

      await quitFlow.handleUpdateQuitRequest(responsePath, { force: true });

      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3100/api/heartbeat-runs/run-1/cancel", expect.objectContaining({
        method: "POST",
      }));
      expect(await readQuitResponse(responsePath)).toMatchObject({
        ok: true,
        status: "quitting",
      });
      expect(stopLocalRudder).toHaveBeenCalledTimes(1);
      expect(destroyResidentTray).toHaveBeenCalledTimes(1);
      expect(appExitMock).toHaveBeenCalledWith(0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(responseDir, { recursive: true, force: true });
    }
  });

  it("does not quit when forced update cannot cancel an active run", async () => {
    const stopLocalRudder = vi.fn(async () => undefined);
    const destroyResidentTray = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") {
        return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      }
      if (pathName === "/api/orgs/org-1/live-runs") {
        return jsonResponse([{ id: "run-1", status: "running", agentName: "Codex" }]);
      }
      if (pathName === "/api/heartbeat-runs/run-1/cancel" && init?.method === "POST") {
        return new Response("cancel failed", { status: 500, statusText: "Internal Server Error" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    const responseDir = await mkdtemp(path.join(tmpdir(), "rudder-update-quit-failed-response."));
    const responsePath = path.join(responseDir, "response.json");

    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: globalThis.fetch,
        stopLocalRudder,
        destroyResidentTray,
      });

      await quitFlow.handleUpdateQuitRequest(responsePath, { force: true });

      expect(await readQuitResponse(responsePath)).toMatchObject({
        ok: false,
        status: "failed",
      });
      expect(stopLocalRudder).not.toHaveBeenCalled();
      expect(destroyResidentTray).not.toHaveBeenCalled();
      expect(appExitMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(responseDir, { recursive: true, force: true });
    }
  });

  it("does not quit when update quit cannot inspect active runs", async () => {
    const stopLocalRudder = vi.fn(async () => undefined);
    const destroyResidentTray = vi.fn();
    const fetchMock = vi.fn(async (url: string) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") {
        return new Response("org list failed", { status: 503, statusText: "Service Unavailable" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    const responseDir = await mkdtemp(path.join(tmpdir(), "rudder-update-quit-inspect-failed-response."));
    const responsePath = path.join(responseDir, "response.json");

    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: globalThis.fetch,
        stopLocalRudder,
        destroyResidentTray,
      });

      await quitFlow.handleUpdateQuitRequest(responsePath, { force: true });

      expect(await readQuitResponse(responsePath)).toMatchObject({
        ok: false,
        status: "failed",
      });
      expect(stopLocalRudder).not.toHaveBeenCalled();
      expect(destroyResidentTray).not.toHaveBeenCalled();
      expect(appExitMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(responseDir, { recursive: true, force: true });
    }
  });

  it("does not quit when active runs remain after forced cancellation", async () => {
    const stopLocalRudder = vi.fn(async () => undefined);
    const destroyResidentTray = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") {
        return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      }
      if (pathName === "/api/orgs/org-1/live-runs") {
        return jsonResponse([{ id: "run-1", status: "running", agentName: "Codex" }]);
      }
      if (pathName === "/api/heartbeat-runs/run-1/cancel" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as never;
    const responseDir = await mkdtemp(path.join(tmpdir(), "rudder-update-quit-active-response."));
    const responsePath = path.join(responseDir, "response.json");

    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: globalThis.fetch,
        stopLocalRudder,
        destroyResidentTray,
      });

      await quitFlow.handleUpdateQuitRequest(responsePath, { force: true });

      expect(await readQuitResponse(responsePath)).toMatchObject({
        ok: false,
        status: "active_runs",
        totalRuns: 1,
      });
      expect(stopLocalRudder).not.toHaveBeenCalled();
      expect(destroyResidentTray).not.toHaveBeenCalled();
      expect(appExitMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(responseDir, { recursive: true, force: true });
    }
  });
});
