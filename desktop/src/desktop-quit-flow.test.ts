import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appExitMock = vi.hoisted(() => vi.fn());
const appQuitMock = vi.hoisted(() => vi.fn());
const dialogShowMessageBoxMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    exit: appExitMock,
    quit: appQuitMock,
  },
  dialog: {
    showMessageBox: dialogShowMessageBoxMock,
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
    dialogShowMessageBoxMock.mockReset();
  });

  it("stops a Native Chat through Rust control and verifies its terminal state before quitting", async () => {
    dialogShowMessageBoxMock.mockResolvedValue({ response: 0 });
    const orgId = "10000000-0000-4000-8000-000000000001";
    const chatId = "20000000-0000-4000-8000-000000000001";
    const generationId = "30000000-0000-4000-8000-000000000001";
    const stopLocalRudder = vi.fn(async () => undefined);
    let stopped = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/orgs") return jsonResponse([{ id: orgId, name: "Z Studio" }]);
      if (pathname === `/api/orgs/${orgId}/live-runs`) {
        return jsonResponse([{
          id: "run-native", status: "running", agentName: "Codex",
          executionAuthority: "native_rust", chatConversationId: chatId, chatGenerationId: generationId,
        }]);
      }
      if (pathname.endsWith("/control")) return jsonResponse({
        executionAuthority: "native_rust", orgId, conversationId: chatId, generationId,
        attemptEpoch: 1, controlVersion: 0, lastSequence: 0,
        lastClientCheckpointSeq: null, lastClientCheckpointHash: null, runtimeTerminal: stopped,
      });
      if (pathname === `/api/chats/${chatId}/messages/stream/stop`) {
        expect(new Headers(init?.headers).get("Origin")).toBe("http://127.0.0.1:3100");
        expect(init?.credentials).toBe("include");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          expectedGenerationId: generationId, expectedAttemptEpoch: 1, expectedControlVersion: 0,
          lastCommittedRenderSeq: 0,
          renderedBodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });
        stopped = true;
        return jsonResponse({ controlActionId: body.controlActionId, generationId, stopped: true });
      }
      throw new Error(`Unexpected API: ${pathname}`);
    });
    const flow = createDesktopQuitFlow({
      appName: "Rudder", getMainWindow: () => null, setMainWindow: vi.fn(),
      getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
      fetchApi: fetchMock, stopLocalRudder, destroyResidentTray: vi.fn(),
    });
    await flow.beginQuitFlow();
    expect(fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/control"))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/heartbeat-runs/"))).toBe(false);
    expect(stopLocalRudder).toHaveBeenCalledOnce();
    expect(appQuitMock).toHaveBeenCalledOnce();
  });

  it("cancels a native Goal through its Rust Agent Run route before draining the owned runtime", async () => {
    dialogShowMessageBoxMock.mockResolvedValue({ response: 0 });
    const lifecycle: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/orgs") return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      if (pathname.endsWith("/live-runs")) return jsonResponse([{
        id: "run-native-goal", status: "running", agentName: "Claude",
        executionAuthority: "native_rust", goalId: "40000000-0000-4000-8000-000000000001",
        chatConversationId: null, chatGenerationId: null,
      }]);
      if (pathname === "/api/agent-runs/run-native-goal/cancel") {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("include");
        expect(new Headers(init?.headers).get("Origin")).toBe("http://127.0.0.1:3100");
        lifecycle.push("cancel-intent");
        return jsonResponse({ status: "running" });
      }
      throw new Error(`Unexpected API: ${pathname}`);
    });
    const flow = createDesktopQuitFlow({
      appName: "Rudder", getMainWindow: () => null, setMainWindow: vi.fn(),
      getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
      fetchApi: fetchMock, stopLocalRudder: async () => { lifecycle.push("runtime-drain"); },
      destroyResidentTray: vi.fn(),
    });
    await flow.beginQuitFlow();
    expect(lifecycle).toEqual(["cancel-intent", "runtime-drain"]);
    expect(appQuitMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([url]) => /heartbeat-runs|\/chats\//.test(url))).toBe(false);
  });

  it("reports native Goal cancellation failure without retrying through Chat or the legacy writer", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    const flow = createDesktopQuitFlow({
      appName: "Rudder", getMainWindow: () => null, setMainWindow: vi.fn(),
      getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
      fetchApi: fetchMock, stopLocalRudder: vi.fn(), destroyResidentTray: vi.fn(),
    });
    try {
      await expect(flow.cancelActiveRunsBeforeQuit({ totalRuns: 1, organizations: [{
        id: "org-1", name: "Z Studio", runs: [{
          id: "run-native-goal", status: "running", agentName: "Claude",
          executionAuthority: "native_rust", goalId: "40000000-0000-4000-8000-000000000001",
        }],
      }] })).rejects.toThrow("Could not cancel 1/1 active run");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:3100/api/agent-runs/run-native-goal/cancel");
    } finally {
      warning.mockRestore();
    }
  });

  it.each(["running", "cancelled"] as const)("keeps native Goal update settlement separate from cancel acknowledgement (%s)", async (settledStatus) => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "rudder-goal-quit-"));
    const responsePath = path.join(tempRoot, "response.json");
    let cancelled = false;
    let inspections = 0;
    const stopLocalRudder = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/orgs") return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      if (pathname.endsWith("/live-runs")) {
        inspections += 1;
        return jsonResponse([{
          id: "run-native-goal", status: cancelled ? settledStatus : "running", agentName: "Claude",
          executionAuthority: "native_rust", goalId: "40000000-0000-4000-8000-000000000001",
        }]);
      }
      if (pathname === "/api/agent-runs/run-native-goal/cancel") {
        cancelled = true;
        return jsonResponse({ status: "running" });
      }
      throw new Error(`Unexpected API: ${pathname}`);
    });
    const flow = createDesktopQuitFlow({
      appName: "Rudder", getMainWindow: () => null, setMainWindow: vi.fn(),
      getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
      fetchApi: fetchMock, stopLocalRudder, destroyResidentTray: vi.fn(),
      quitRunSettleTimeoutMs: 20, quitRunSettlePollIntervalMs: 1,
    });
    try {
      await flow.handleUpdateQuitRequest(responsePath, { force: true });
      expect(inspections).toBeGreaterThan(1);
      expect(await readQuitResponse(responsePath)).toMatchObject(settledStatus === "running"
        ? { ok: false, status: "active_runs", totalRuns: 1 }
        : { ok: true });
      expect(stopLocalRudder).toHaveBeenCalledTimes(settledStatus === "running" ? 0 : 1);
      expect(fetchMock.mock.calls.some(([url]) => /heartbeat-runs|\/chats\//.test(url))).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["orgs", "live-runs"] as const)("bounds a hung %s inspection and aborts it before normal quit", async (hungRequest) => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let inspectionSignal: AbortSignal | undefined;
      const stopLocalRudder = vi.fn(async () => undefined);
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (new URL(url).pathname === "/api/orgs" && hungRequest === "live-runs") {
          return Promise.resolve(jsonResponse([{ id: "org-1", name: "Z Studio" }]));
        }
        inspectionSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      });
      const flow = createDesktopQuitFlow({
        appName: "Rudder", getMainWindow: () => null, setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: fetchMock, stopLocalRudder, destroyResidentTray: vi.fn(),
      });
      const quitting = flow.beginQuitFlow();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(appQuitMock).not.toHaveBeenCalled();
      expect(inspectionSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await quitting;
      expect(inspectionSignal?.aborted).toBe(true);
      expect(stopLocalRudder).toHaveBeenCalledOnce();
      expect(appQuitMock).toHaveBeenCalledOnce();
      expect(dialogShowMessageBoxMock).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([url]) => url.includes("/heartbeat-runs/"))).toBe(false);
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["owned", "attached"] as const)("bounds an unresolved Native Stop in an %s runtime without calling the legacy writer", async (runtimeMode) => {
    vi.useFakeTimers();
    try {
      dialogShowMessageBoxMock.mockResolvedValueOnce({ response: runtimeMode === "owned" ? 0 : 1 })
        .mockResolvedValueOnce({ response: 0 });
      const orgId = "10000000-0000-4000-8000-000000000001";
      const chatId = "20000000-0000-4000-8000-000000000001";
      const generationId = "30000000-0000-4000-8000-000000000001";
      const stopLocalRudder = vi.fn(async () => undefined);
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/orgs") return jsonResponse([{ id: orgId, name: "Z Studio" }]);
        if (pathname.endsWith("/live-runs")) return jsonResponse([{
          id: "run-native", status: "running", agentName: "Codex", executionAuthority: "native_rust",
          chatConversationId: chatId, chatGenerationId: generationId,
        }]);
        if (pathname.endsWith("/control")) return jsonResponse({
          executionAuthority: "native_rust", orgId, conversationId: chatId, generationId,
          attemptEpoch: 1, controlVersion: 0, lastSequence: 0,
          lastClientCheckpointSeq: null, lastClientCheckpointHash: null, runtimeTerminal: false,
        });
        if (pathname.endsWith("/stop")) return jsonResponse({
          controlActionId: JSON.parse(String(init?.body)).controlActionId, generationId,
          stopped: false, disposition: "stopping",
        });
        throw new Error(`Unexpected API: ${pathname}`);
      });
      const flow = createDesktopQuitFlow({
        appName: "Rudder", getMainWindow: () => null, setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: runtimeMode } }),
        fetchApi: fetchMock, stopLocalRudder, destroyResidentTray: vi.fn(),
      });
      const quitting = flow.beginQuitFlow();
      await vi.advanceTimersByTimeAsync(5_001);
      await quitting;
      if (runtimeMode === "owned") {
        expect(appQuitMock).toHaveBeenCalledOnce();
        expect(stopLocalRudder).toHaveBeenCalledOnce();
      } else {
        expect(appQuitMock).not.toHaveBeenCalled();
        expect(stopLocalRudder).not.toHaveBeenCalled();
        expect(dialogShowMessageBoxMock).toHaveBeenLastCalledWith(expect.objectContaining({
          message: "Rudder could not stop the active runs.",
        }));
      }
      expect(fetchMock.mock.calls.some(([url]) => url.includes("/heartbeat-runs/"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops active owned runs before quitting after confirmation", async () => {
    dialogShowMessageBoxMock.mockResolvedValue({ response: 0 });
    const stopLocalRudder = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      if (pathName === "/api/orgs/org-1/live-runs") {
        return jsonResponse([{ id: "run-1", status: "running", agentName: "Codex" }]);
      }
      if (pathName === "/api/heartbeat-runs/run-1/cancel" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => null,
      setMainWindow: vi.fn(),
      getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
      fetchApi: fetchMock,
      stopLocalRudder,
      destroyResidentTray: vi.fn(),
    });

    await quitFlow.beginQuitFlow();

    expect(dialogShowMessageBoxMock).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ["Stop Runs and Quit", "Cancel"],
    }));
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3100/api/heartbeat-runs/run-1/cancel", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({}),
    }));
    const cancelRequest = fetchMock.mock.calls.find(([url]) =>
      new URL(String(url)).pathname === "/api/heartbeat-runs/run-1/cancel");
    expect(new Headers(cancelRequest?.[1]?.headers).get("Origin")).toBe("http://127.0.0.1:3100");
    expect(stopLocalRudder).toHaveBeenCalledOnce();
    expect(appQuitMock).toHaveBeenCalledOnce();
  });

  it("continues quitting an owned runtime when active-run cancellation fails", async () => {
    dialogShowMessageBoxMock.mockResolvedValue({ response: 0 });
    const stopLocalRudder = vi.fn(async () => undefined);
    let serverHandle: { apiUrl: string; runtime: { mode: "owned" | "attached" } } | null = {
      apiUrl: "http://127.0.0.1:3100",
      runtime: { mode: "owned" },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      if (pathName === "/api/orgs/org-1/live-runs") {
        return jsonResponse([{ id: "run-1", status: "running", agentName: "Codex" }]);
      }
      if (pathName === "/api/heartbeat-runs/run-1/cancel" && init?.method === "POST") {
        serverHandle = null;
        return new Response("cancel failed", { status: 500, statusText: "Internal Server Error" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => serverHandle,
        fetchApi: fetchMock,
        stopLocalRudder,
        destroyResidentTray: vi.fn(),
      });

      await quitFlow.beginQuitFlow();

      expect(stopLocalRudder).toHaveBeenCalledOnce();
      expect(appQuitMock).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        "[rudder-desktop] active run cancellation did not complete before owned runtime quit",
        expect.any(Error),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("does not wait indefinitely for an active-run cancellation request", async () => {
    vi.useFakeTimers();
    dialogShowMessageBoxMock.mockResolvedValue({ response: 0 });
    const stopLocalRudder = vi.fn(async () => undefined);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") return Promise.resolve(jsonResponse([{ id: "org-1", name: "Z Studio" }]));
      if (pathName === "/api/orgs/org-1/live-runs") {
        return Promise.resolve(jsonResponse([{ id: "run-1", status: "running", agentName: "Codex" }]));
      }
      if (pathName === "/api/heartbeat-runs/run-1/cancel" && init?.method === "POST") {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: fetchMock,
        stopLocalRudder,
        destroyResidentTray: vi.fn(),
      });

      const quitting = quitFlow.beginQuitFlow();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3100/api/heartbeat-runs/run-1/cancel",
        expect.objectContaining({ method: "POST" }),
      );
      const cancelRequest = fetchMock.mock.calls.find(([url]) =>
        new URL(String(url)).pathname === "/api/heartbeat-runs/run-1/cancel");
      expect(new Headers(cancelRequest?.[1]?.headers).get("Origin")).toBe("http://127.0.0.1:3100");
      await vi.advanceTimersByTimeAsync(5_000);
      await quitting;

      expect(stopLocalRudder).toHaveBeenCalledOnce();
      expect(appQuitMock).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        "[rudder-desktop] active run cancellation did not complete before owned runtime quit",
        expect.any(Error),
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps an attached runtime open and reports cancellation failure", async () => {
    dialogShowMessageBoxMock
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 });
    const stopLocalRudder = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      if (pathName === "/api/orgs/org-1/live-runs") {
        return jsonResponse([{ id: "run-1", status: "running", agentName: "Codex" }]);
      }
      if (pathName === "/api/heartbeat-runs/run-1/cancel" && init?.method === "POST") {
        return new Response("cancel failed", { status: 500, statusText: "Internal Server Error" });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => null,
      setMainWindow: vi.fn(),
      getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "attached" } }),
      fetchApi: fetchMock,
      stopLocalRudder,
      destroyResidentTray: vi.fn(),
    });

    await quitFlow.beginQuitFlow();

    expect(stopLocalRudder).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();
    expect(dialogShowMessageBoxMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "error",
      message: "Rudder could not stop the active runs.",
    }));
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

  it("hands a natural quit to automatic apply after stopping the runtime", async () => {
    const afterRuntimeDrain = vi.fn(async () => undefined);
    const stopLocalRudder = vi.fn(async () => undefined);
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => null,
      setMainWindow: vi.fn(),
      getServerHandle: () => null,
      fetchApi: globalThis.fetch,
      afterRuntimeDrain,
      stopLocalRudder,
      destroyResidentTray: vi.fn(),
    });

    await quitFlow.beginQuitFlow();

    expect(afterRuntimeDrain).toHaveBeenCalledTimes(1);
    expect(stopLocalRudder).toHaveBeenCalledTimes(1);
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it("never invokes automatic apply for an OS shutdown", async () => {
    const afterRuntimeDrain = vi.fn(async () => undefined);
    const stopLocalRudder = vi.fn(async () => undefined);
    const quitFlow = createDesktopQuitFlow({
      appName: "Rudder",
      getMainWindow: () => null,
      setMainWindow: vi.fn(),
      getServerHandle: () => null,
      fetchApi: globalThis.fetch,
      afterRuntimeDrain,
      isSystemShutdown: () => true,
      stopLocalRudder,
      destroyResidentTray: vi.fn(),
    });

    await quitFlow.beginQuitFlow();

    expect(stopLocalRudder).toHaveBeenCalledOnce();
    expect(afterRuntimeDrain).not.toHaveBeenCalled();
    expect(appQuitMock).toHaveBeenCalledOnce();
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
      const cancelRequest = fetchMock.mock.calls.find(([url]) =>
        new URL(String(url)).pathname === "/api/heartbeat-runs/run-1/cancel");
      expect(new Headers(cancelRequest?.[1]?.headers).get("Origin")).toBe("http://127.0.0.1:3100");
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

  it("waits for a cancelled run to leave the live-run list before quitting", async () => {
    const stopLocalRudder = vi.fn(async () => undefined);
    const destroyResidentTray = vi.fn();
    let liveRunReadsAfterCancel = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/api/orgs") {
        return jsonResponse([{ id: "org-1", name: "Z Studio" }]);
      }
      if (pathName === "/api/orgs/org-1/live-runs") {
        const cancelRequested = fetchMock.mock.calls.some(([requestUrl, requestInit]) => (
          new URL(String(requestUrl)).pathname === "/api/heartbeat-runs/run-1/cancel"
          && requestInit?.method === "POST"
        ));
        if (cancelRequested) liveRunReadsAfterCancel += 1;
        return jsonResponse(!cancelRequested || liveRunReadsAfterCancel < 2
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
    const responseDir = await mkdtemp(path.join(tmpdir(), "rudder-update-quit-settle-response."));
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
        quitRunSettleTimeoutMs: 100,
        quitRunSettlePollIntervalMs: 1,
      });

      await quitFlow.handleUpdateQuitRequest(responsePath, { force: true });

      expect(await readQuitResponse(responsePath)).toMatchObject({ ok: true, status: "quitting" });
      expect(liveRunReadsAfterCancel).toBeGreaterThanOrEqual(2);
      expect(stopLocalRudder).toHaveBeenCalledTimes(1);
      expect(destroyResidentTray).toHaveBeenCalledTimes(1);
      expect(appExitMock).toHaveBeenCalledWith(0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(responseDir, { recursive: true, force: true });
    }
  });

  it("replies before the CLI deadline when slow cancellation is followed by a hung inspection", async () => {
    const responseDir = await mkdtemp(path.join(tmpdir(), "rudder-update-quit-deadline."));
    const responsePath = path.join(responseDir, "response.json");
    const stopLocalRudder = vi.fn();
    let cancelled = false;
    let inspectionSignal: AbortSignal | undefined;
    let releaseInspection!: (response: Response) => void;
    vi.useFakeTimers();
    try {
      const quitFlow = createDesktopQuitFlow({
        appName: "Rudder",
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        getServerHandle: () => ({ apiUrl: "http://127.0.0.1:3100", runtime: { mode: "owned" } }),
        fetchApi: async (url, init) => {
          const pathname = new URL(url).pathname;
          if (pathname.endsWith("/cancel")) {
            await new Promise((resolve) => setTimeout(resolve, 4_500));
            cancelled = true;
            return new Response(null, { status: 204 });
          }
          if (cancelled) {
            inspectionSignal = init?.signal ?? undefined;
            return new Promise<Response>((resolve) => { releaseInspection = resolve; });
          }
          return jsonResponse(pathname === "/api/orgs"
            ? [{ id: "org-1", name: "Z Studio" }]
            : [{ id: "run-1", status: "running", agentName: "Codex" }]);
        },
        stopLocalRudder,
        destroyResidentTray: vi.fn(),
      });
      const request = quitFlow.handleUpdateQuitRequest(responsePath, { force: true });
      await vi.advanceTimersByTimeAsync(7_000);
      await request;
      expect(await readQuitResponse(responsePath)).toMatchObject({ ok: false, status: "failed" });
      expect(inspectionSignal?.aborted).toBe(true);
      // A fetch implementation that ignores abort must not trigger a late quit.
      releaseInspection(jsonResponse([]));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stopLocalRudder).not.toHaveBeenCalled();
      expect(appExitMock).not.toHaveBeenCalled();
      expect(await readQuitResponse(responsePath)).toMatchObject({ ok: false, status: "failed" });
    } finally {
      vi.useRealTimers();
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
        quitRunSettleTimeoutMs: 0,
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
