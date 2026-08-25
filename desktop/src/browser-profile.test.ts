import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserProfileController,
  deriveBrowserPartition,
  isAllowedAgentBrowserNavigationUrl,
  isAllowedAgentBrowserRudderAssetUrl,
  isAllowedBrowserBootstrapUrl,
  isAllowedBrowserNavigationUrl,
  isAllowedOperatorBrowserNavigationUrl,
  isLocalAbsoluteFileUrl,
} from "./browser-profile.js";

const tempRoots: string[] = [];

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createSessionMock() {
  return {
    clearAuthCache: vi.fn(async () => undefined),
    clearData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    cookies: {
      flushStore: vi.fn(async () => undefined),
    },
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Rudder Browser profile partition", () => {
  it("uses the canonical absolute instance root without leaking the path", async () => {
    const parent = await createTempRoot("rudder-browser-profile-");
    const instanceRoot = path.join(parent, "instances", "dev-secret-name");
    const aliasRoot = path.join(parent, "instance-alias");
    await mkdir(instanceRoot, { recursive: true });
    await symlink(instanceRoot, aliasRoot);

    const directPartition = deriveBrowserPartition(instanceRoot);
    const aliasPartition = deriveBrowserPartition(aliasRoot);

    expect(aliasPartition).toBe(directPartition);
    expect(directPartition).toMatch(/^persist:rudder-browser-v1-[a-f0-9]{64}$/);
    expect(directPartition).not.toContain("dev-secret-name");
    expect(directPartition).not.toContain(parent);
  });

  it("isolates different absolute instance roots", async () => {
    const firstRoot = await createTempRoot("rudder-browser-first-");
    const secondRoot = await createTempRoot("rudder-browser-second-");

    expect(deriveBrowserPartition(firstRoot)).not.toBe(deriveBrowserPartition(secondRoot));
  });

  it("preserves whitespace that is part of the canonical instance directory name", async () => {
    const parent = await createTempRoot("rudder-browser-spaced-");
    const instanceRoot = path.join(parent, "instance-with-trailing-space ");
    await mkdir(instanceRoot);

    expect(deriveBrowserPartition(instanceRoot)).toMatch(/^persist:rudder-browser-v1-[a-f0-9]{64}$/);
  });
});

describe("Rudder Browser URL policy", () => {
  const rudderAppOrigins = ["http://127.0.0.1:3100", "https://rudder.internal"];

  it("allows web URLs but rejects the Rudder origin", () => {
    expect(isAllowedBrowserNavigationUrl("https://example.com/path?q=1", rudderAppOrigins)).toBe(true);
    expect(isAllowedBrowserNavigationUrl("http://example.test/", rudderAppOrigins)).toBe(true);
    expect(isAllowedBrowserNavigationUrl("file:///Users/example/report.html", rudderAppOrigins)).toBe(false);
    expect(isAllowedBrowserNavigationUrl("http://127.0.0.1:3100/api/orgs", rudderAppOrigins)).toBe(false);
    expect(isAllowedBrowserNavigationUrl("https://rudder.internal/settings", rudderAppOrigins)).toBe(false);
  });

  it("allows Agent Browser loopback HTTP(S) targets for local debugging", () => {
    expect(isAllowedAgentBrowserNavigationUrl(
      "http://localhost:3200/api/assets/bb297c93-b65c-4807-895b-3b02d7dbcf78/content",
      rudderAppOrigins,
    )).toBe(true);
    expect(isAllowedAgentBrowserNavigationUrl("http://127.0.0.2:43123/debug", rudderAppOrigins)).toBe(true);
    expect(isAllowedAgentBrowserNavigationUrl("http://127.1:43123/debug", rudderAppOrigins)).toBe(true);
    expect(isAllowedAgentBrowserNavigationUrl("https://[::1]:9443/debug", rudderAppOrigins)).toBe(true);
    expect(isAllowedAgentBrowserNavigationUrl("https://[::ffff:127.0.0.1]:9443/debug", rudderAppOrigins)).toBe(true);
    expect(isAllowedAgentBrowserNavigationUrl("http://127.evil.example:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://0.0.0.0:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://[::]:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://[::ffff:0:0]:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://10.0.0.1:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://172.16.0.1:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://192.168.1.1:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://169.254.1.1:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://[fc00::1]:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://[fe80::1]:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://[::ffff:c0a8:101]:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("ws://localhost:3200/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("wss://example.com/debug", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("https://rudder.internal/settings", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://localhost:3100/api/orgs", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserNavigationUrl("http://127.0.0.1:3100/api/assets/bb297c93-b65c-4807-895b-3b02d7dbcf78/content", rudderAppOrigins)).toBe(true);
    expect(isAllowedAgentBrowserNavigationUrl("file:///tmp/debug.html", rudderAppOrigins)).toBe(false);
  });

  it("allows only canonical local Rudder asset content through the Agent Browser exception", () => {
    expect(isAllowedAgentBrowserRudderAssetUrl(
      "http://localhost:3100/api/assets/bb297c93-b65c-4807-895b-3b02d7dbcf78/content",
      rudderAppOrigins,
    )).toBe(true);
    expect(isAllowedAgentBrowserRudderAssetUrl("http://localhost:3100/api/orgs", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserRudderAssetUrl("http://localhost:3100/api/assets/not-an-id/content", rudderAppOrigins)).toBe(false);
    expect(isAllowedAgentBrowserRudderAssetUrl(
      "https://rudder.internal/api/assets/bb297c93-b65c-4807-895b-3b02d7dbcf78/content",
      rudderAppOrigins,
    )).toBe(false);
  });

  it("allows operator-entered local file URLs without broadening Agent Browser navigation", () => {
    expect(isAllowedOperatorBrowserNavigationUrl("file:///Users/example/report.html", rudderAppOrigins)).toBe(true);
    expect(isAllowedOperatorBrowserNavigationUrl("file:///C:/Users/example/report.html", rudderAppOrigins)).toBe(true);
    expect(isAllowedOperatorBrowserNavigationUrl("https://example.com/path?q=1", rudderAppOrigins)).toBe(true);
    expect(isAllowedOperatorBrowserNavigationUrl("file://remote-host/share/report.html", rudderAppOrigins)).toBe(false);
    expect(isAllowedOperatorBrowserNavigationUrl("file://localhost/tmp/report.html", rudderAppOrigins)).toBe(false);
    expect(isAllowedOperatorBrowserNavigationUrl("file:relative.html", rudderAppOrigins)).toBe(false);
    expect(isAllowedOperatorBrowserNavigationUrl("http://127.0.0.1:3100/api/orgs", rudderAppOrigins)).toBe(false);
    expect(isAllowedOperatorBrowserNavigationUrl("javascript:alert(1)", rudderAppOrigins)).toBe(false);
  });

  it("recognizes only canonical local absolute file URLs", () => {
    expect(isLocalAbsoluteFileUrl("file:///tmp/report.html")).toBe(true);
    expect(isLocalAbsoluteFileUrl("file:///C:/Users/example/report.html")).toBe(true);
    expect(isLocalAbsoluteFileUrl("file://remote-host/share/report.html")).toBe(false);
    expect(isLocalAbsoluteFileUrl("file://localhost/tmp/report.html")).toBe(false);
    expect(isLocalAbsoluteFileUrl("file:////server/share/report.html")).toBe(false);
    expect(isLocalAbsoluteFileUrl("file:///\\\\server\\share\\report.html")).toBe(false);
    expect(isLocalAbsoluteFileUrl("file:///%2F%2Fserver/share/report.html")).toBe(false);
    expect(isLocalAbsoluteFileUrl("file:///%5C%5Cserver%5Cshare%5Creport.html")).toBe(false);
    expect(isLocalAbsoluteFileUrl("file:/tmp/report.html")).toBe(false);
    expect(isLocalAbsoluteFileUrl("file:report.html")).toBe(false);
  });

  it.each([
    "http://localhost:3100/api/orgs",
    "http://localhost.:3100/api/orgs",
    "http://admin.localhost:3100/api/orgs",
    "http://admin.localhost.:3100/api/orgs",
    "http://0.0.0.0:3100/api/orgs",
    "http://127.0.0.2:3100/api/orgs",
    "http://[::1]:3100/api/orgs",
    "http://[::]:3100/api/orgs",
    "http://[::ffff:127.0.0.1]:3100/api/orgs",
    "http://localtest.me:3100/api/orgs",
    "http://lvh.me:3100/api/orgs",
    "http://example.com:3100/public",
  ])("blocks equivalent loopback Rudder target %s", (target) => {
    expect(isAllowedBrowserNavigationUrl(target, ["http://127.0.0.1:3100"])).toBe(false);
  });

  it.each([
    "about:blank",
    "file:///Users/example/.ssh/id_rsa",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "devtools://devtools/bundled/inspector.html",
    "rudder://settings",
    "custom-protocol:payload",
    "not a url",
  ])("rejects unsafe navigation target %s", (target) => {
    expect(isAllowedBrowserNavigationUrl(target, rudderAppOrigins)).toBe(false);
  });

  it("allows only exact about:blank through the explicit bootstrap policy", () => {
    expect(isAllowedBrowserBootstrapUrl("about:blank", rudderAppOrigins)).toBe(true);
    expect(isAllowedBrowserBootstrapUrl("about:blank#injected", rudderAppOrigins)).toBe(false);
    expect(isAllowedBrowserBootstrapUrl("https://example.com", rudderAppOrigins)).toBe(true);
    expect(isAllowedBrowserBootstrapUrl("file:///Users/example/report.html", rudderAppOrigins)).toBe(true);
    expect(isAllowedBrowserBootstrapUrl("file://remote-host/share/report.html", rudderAppOrigins)).toBe(false);
    expect(isAllowedBrowserBootstrapUrl("file:////server/share/report.html", rudderAppOrigins)).toBe(false);
    expect(isAllowedBrowserNavigationUrl("about:blank", rudderAppOrigins)).toBe(false);
  });

});

describe("Rudder Browser profile lifecycle", () => {
  it("serializes clears, marks the profile unavailable, and clears supported session data", async () => {
    const firstClearGate = createDeferred();
    const session = createSessionMock();
    const lifecycle: string[] = [];
    const closeBrowserGuests = vi.fn(async () => {
      lifecycle.push("close-guests");
    });
    const broadcastReset = vi.fn((event) => {
      lifecycle.push(`reset:${event.reason}`);
    });
    session.clearAuthCache.mockImplementationOnce(async () => {
      lifecycle.push("clear-auth");
      await firstClearGate.promise;
    }).mockResolvedValue(undefined);
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session,
      closeBrowserGuests,
      broadcastReset,
    });

    const firstClear = controller.clearBrowserData();
    const secondClear = controller.clearBrowserData();
    expect(controller.getState()).toEqual({ enabled: true, available: false, clearing: true });
    await vi.waitFor(() => expect(session.clearAuthCache).toHaveBeenCalledTimes(1));

    expect(controller.getState()).toEqual({ enabled: true, available: false, clearing: true });
    expect(lifecycle.slice(0, 3)).toEqual(["reset:clear", "close-guests", "clear-auth"]);
    firstClearGate.resolve();
    await firstClear;
    await secondClear;

    expect(session.clearAuthCache).toHaveBeenCalledTimes(2);
    expect(session.clearData).toHaveBeenCalledTimes(2);
    expect(session.cookies.flushStore).toHaveBeenCalledTimes(2);
    expect(closeBrowserGuests).toHaveBeenCalledTimes(2);
    expect(broadcastReset).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toEqual({ enabled: true, available: true, clearing: false });
  });

  it("disables Agent Browser guests without resetting operator tabs or clearing profile data", async () => {
    const session = createSessionMock();
    const closeBrowserGuests = vi.fn(async () => undefined);
    const broadcastReset = vi.fn();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session,
      closeBrowserGuests,
      broadcastReset,
    });

    await controller.setEnabled(false);

    expect(controller.getState()).toEqual({ enabled: false, available: false, clearing: false });
    expect(controller.isOperatorAvailable()).toBe(true);
    expect(broadcastReset).not.toHaveBeenCalled();
    expect(closeBrowserGuests).toHaveBeenCalledWith("agent");
    expect(closeBrowserGuests).toHaveBeenCalledTimes(1);
    expect(session.clearAuthCache).not.toHaveBeenCalled();
    expect(session.clearCache).not.toHaveBeenCalled();
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(session.cookies.flushStore).not.toHaveBeenCalled();

    await controller.setEnabled(true);
    expect(controller.getState()).toEqual({ enabled: true, available: true, clearing: false });
    expect(controller.isOperatorAvailable()).toBe(true);
    expect(broadcastReset).not.toHaveBeenCalled();
  });

  it("does not become available until an in-flight disable reset has finished", async () => {
    const disableGate = createDeferred();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session: createSessionMock(),
      closeBrowserGuests: async () => {
        await disableGate.promise;
      },
      broadcastReset: vi.fn(),
    });

    const disabling = controller.setEnabled(false);
    const enabling = controller.setEnabled(true);

    expect(controller.getState()).toEqual({ enabled: true, available: false, clearing: false });
    disableGate.resolve();
    await disabling;
    await enabling;
    expect(controller.getState()).toEqual({ enabled: true, available: true, clearing: false });
  });

  it("serializes clear behind an in-flight disable guest shutdown", async () => {
    const disableGate = createDeferred();
    const session = createSessionMock();
    let activeGuestShutdowns = 0;
    let maxActiveGuestShutdowns = 0;
    const closeBrowserGuests = vi.fn(async () => {
      activeGuestShutdowns += 1;
      maxActiveGuestShutdowns = Math.max(maxActiveGuestShutdowns, activeGuestShutdowns);
      if (closeBrowserGuests.mock.calls.length === 1) {
        await disableGate.promise;
      }
      activeGuestShutdowns -= 1;
    });
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session,
      closeBrowserGuests,
      broadcastReset: vi.fn(),
    });

    const disabling = controller.setEnabled(false);
    const clearing = controller.clearBrowserData();
    await vi.waitFor(() => expect(closeBrowserGuests).toHaveBeenCalled());

    expect(maxActiveGuestShutdowns).toBe(1);
    expect(session.clearAuthCache).not.toHaveBeenCalled();
    disableGate.resolve();
    await disabling;
    await clearing;
    expect(maxActiveGuestShutdowns).toBe(1);
    expect(session.clearAuthCache).toHaveBeenCalledTimes(1);
  });

  it("revokes immediately while serializing Browser import and stored-data clear", async () => {
    const importGate = createDeferred();
    const session = createSessionMock();
    const closeBrowserGuests = vi.fn(async () => undefined);
    const broadcastReset = vi.fn();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session,
      closeBrowserGuests,
      broadcastReset,
    });
    const lifecycle: string[] = [];

    const importing = controller.runExclusive(async () => {
      lifecycle.push("import:start");
      await importGate.promise;
      lifecycle.push("import:end");
      return 42;
    });
    const clearing = controller.clearBrowserData().then(() => lifecycle.push("clear:end"));
    const disabling = controller.setEnabled(false).then(() => lifecycle.push("disable:end"));
    await vi.waitFor(() => expect(lifecycle).toContain("import:start"));

    await vi.waitFor(() => expect(closeBrowserGuests).toHaveBeenCalledTimes(2));
    await disabling;
    expect(session.clearAuthCache).not.toHaveBeenCalled();
    expect(lifecycle).toEqual(["import:start", "disable:end"]);
    importGate.resolve();
    await expect(importing).resolves.toBe(42);
    await clearing;
    expect(lifecycle).toEqual(["import:start", "disable:end", "import:end", "clear:end"]);
    expect(broadcastReset.mock.calls.map(([event]) => event)).toEqual([
      { reason: "clear", enabled: true, available: false },
    ]);
  });

  it("revokes Browser guests immediately while clear waits for an in-flight import", async () => {
    const importGate = createDeferred();
    const session = createSessionMock();
    const closeBrowserGuests = vi.fn(async () => undefined);
    const broadcastReset = vi.fn();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session,
      closeBrowserGuests,
      broadcastReset,
    });

    const importing = controller.runExclusive(async () => {
      await importGate.promise;
    });
    await Promise.resolve();
    const clearing = controller.clearBrowserData();

    await vi.waitFor(() => expect(closeBrowserGuests).toHaveBeenCalledTimes(1));
    expect(broadcastReset).toHaveBeenCalledWith({ reason: "clear", enabled: true, available: false });
    expect(controller.getState()).toEqual({ enabled: true, available: false, clearing: true });
    expect(session.clearData).not.toHaveBeenCalled();
    await expect(controller.runExclusive(async () => "late import"))
      .rejects.toThrow("unavailable during a Browser profile lifecycle operation");

    importGate.resolve();
    await importing;
    await clearing;
    expect(session.clearData).toHaveBeenCalledTimes(1);
  });

  it("revokes Agent guests without resetting operator tabs when disable races an in-flight import", async () => {
    const importGate = createDeferred();
    const closeBrowserGuests = vi.fn(async () => undefined);
    const broadcastReset = vi.fn();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session: createSessionMock(),
      closeBrowserGuests,
      broadcastReset,
    });

    const importing = controller.runExclusive(async () => {
      await importGate.promise;
    });
    await Promise.resolve();
    const disabling = controller.setEnabled(false);

    await vi.waitFor(() => expect(closeBrowserGuests).toHaveBeenCalledTimes(1));
    expect(closeBrowserGuests).toHaveBeenCalledWith("agent");
    expect(broadcastReset).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ enabled: false, available: false, clearing: false });
    expect(controller.isOperatorAvailable()).toBe(true);

    importGate.resolve();
    await importing;
    await disabling;
  });

  it("keeps clear behind an import that was admitted before disable", async () => {
    const importGate = createDeferred();
    const session = createSessionMock();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session,
      closeBrowserGuests: vi.fn(async () => undefined),
      broadcastReset: vi.fn(),
    });
    const lifecycle: string[] = [];

    const importing = controller.runExclusive(async () => {
      lifecycle.push("import:start");
      await importGate.promise;
      lifecycle.push("import:end");
    });
    await Promise.resolve();
    await controller.setEnabled(false);
    const clearing = controller.clearBrowserData().then(() => lifecycle.push("clear:end"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(session.clearData).not.toHaveBeenCalled();
    expect(lifecycle).toEqual(["import:start"]);
    importGate.resolve();
    await importing;
    await clearing;
    expect(lifecycle).toEqual(["import:start", "import:end", "clear:end"]);
  });

  it("keeps re-enable unavailable until the admitted import drains and rejects new control work", async () => {
    const importGate = createDeferred();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session: createSessionMock(),
      closeBrowserGuests: vi.fn(async () => undefined),
      broadcastReset: vi.fn(),
    });
    const lifecycle: string[] = [];

    const firstImport = controller.runExclusive(async () => {
      lifecycle.push("first:start");
      await importGate.promise;
      lifecycle.push("first:end");
    });
    await Promise.resolve();
    await controller.setEnabled(false);
    const enabling = controller.setEnabled(true).then(() => lifecycle.push("enable:end"));
    await Promise.resolve();

    expect(lifecycle).toEqual(["first:start"]);
    expect(controller.getState()).toEqual({ enabled: true, available: false, clearing: false });
    await expect(controller.runExclusive(async () => lifecycle.push("second:start")))
      .rejects.toThrow("unavailable during a Browser profile lifecycle operation");
    importGate.resolve();
    await firstImport;
    await enabling;
    await controller.runExclusive(async () => lifecycle.push("second:start"));
    expect(lifecycle).toEqual(["first:start", "first:end", "enable:end", "second:start"]);
  });

  it("does not let an older enable transition override a later disable", async () => {
    const importGate = createDeferred();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session: createSessionMock(),
      closeBrowserGuests: vi.fn(async () => undefined),
      broadcastReset: vi.fn(),
    });

    const importing = controller.runExclusive(async () => {
      await importGate.promise;
    });
    await Promise.resolve();
    await controller.setEnabled(false);
    const staleEnable = controller.setEnabled(true);
    const latestDisable = controller.setEnabled(false);

    importGate.resolve();
    await importing;
    await staleEnable;
    await latestDisable;
    expect(controller.getState()).toEqual({ enabled: false, available: false, clearing: false });
  });

  it("closes admission, cancels active control work, and waits for its cleanup during shutdown", async () => {
    const cleanupGate = createDeferred();
    const closeBrowserGuests = vi.fn(async () => undefined);
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session: createSessionMock(),
      closeBrowserGuests,
      broadcastReset: vi.fn(),
    });
    const lifecycle: string[] = [];

    const importing = controller.runExclusive(async (signal) => {
      lifecycle.push("import:start");
      if (!signal) {
        lifecycle.push("signal:missing");
        return;
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          lifecycle.push("import:abort");
          void cleanupGate.promise.then(() => {
            lifecycle.push("import:cleanup");
            resolve();
          });
        }, { once: true });
      });
    });
    await vi.waitFor(() => expect(lifecycle).toContain("import:start"));

    const shuttingDown = controller.shutdown();
    await vi.waitFor(() => expect(lifecycle).toContain("import:abort"));
    expect(controller.getState()).toEqual({ enabled: false, available: false, clearing: false });
    await expect(controller.runExclusive(async () => undefined))
      .rejects.toThrow("unavailable during a Browser profile lifecycle operation");
    let shutdownFinished = false;
    void shuttingDown.then(() => { shutdownFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shutdownFinished).toBe(false);

    cleanupGate.resolve();
    await importing;
    await shuttingDown;
    expect(lifecycle).toEqual(["import:start", "import:abort", "import:cleanup"]);
    expect(closeBrowserGuests).toHaveBeenCalledTimes(1);
  });

  it("still waits for admitted control cleanup when guest revocation fails during shutdown", async () => {
    const cleanupGate = createDeferred();
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session: createSessionMock(),
      closeBrowserGuests: vi.fn(async () => {
        throw new Error("guest close failed");
      }),
      broadcastReset: vi.fn(),
    });

    const importing = controller.runExclusive(async (signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          void cleanupGate.promise.then(resolve);
        }, { once: true });
      });
    });
    await Promise.resolve();
    let shutdownSettled = false;
    const shuttingDown = controller.shutdown().finally(() => {
      shutdownSettled = true;
    });
    void shuttingDown.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(shutdownSettled).toBe(false);
    cleanupGate.resolve();
    await importing;
    await expect(shuttingDown).rejects.toThrow("guest close failed");
  });
});
