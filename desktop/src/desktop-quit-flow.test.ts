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
