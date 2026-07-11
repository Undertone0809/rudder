import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_STORAGE_TYPES,
  createBrowserProfileController,
  deriveBrowserPartition,
  isAllowedBrowserBootstrapUrl,
  isAllowedBrowserNavigationUrl,
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
  const controlPlaneOrigins = ["http://127.0.0.1:3100", "https://rudder.internal"];

  it("allows web URLs but rejects the Rudder control-plane origin", () => {
    expect(isAllowedBrowserNavigationUrl("https://example.com/path?q=1", controlPlaneOrigins)).toBe(true);
    expect(isAllowedBrowserNavigationUrl("http://example.test/", controlPlaneOrigins)).toBe(true);
    expect(isAllowedBrowserNavigationUrl("http://127.0.0.1:3100/api/orgs", controlPlaneOrigins)).toBe(false);
    expect(isAllowedBrowserNavigationUrl("https://rudder.internal/settings", controlPlaneOrigins)).toBe(false);
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
  ])("blocks equivalent loopback control-plane target %s", (target) => {
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
    expect(isAllowedBrowserNavigationUrl(target, controlPlaneOrigins)).toBe(false);
  });

  it("allows only exact about:blank through the explicit bootstrap policy", () => {
    expect(isAllowedBrowserBootstrapUrl("about:blank", controlPlaneOrigins)).toBe(true);
    expect(isAllowedBrowserBootstrapUrl("about:blank#injected", controlPlaneOrigins)).toBe(false);
    expect(isAllowedBrowserBootstrapUrl("https://example.com", controlPlaneOrigins)).toBe(true);
    expect(isAllowedBrowserNavigationUrl("about:blank", controlPlaneOrigins)).toBe(false);
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
    expect(session.clearCache).toHaveBeenCalledTimes(2);
    expect(session.clearStorageData).toHaveBeenCalledTimes(2);
    expect(session.clearStorageData).toHaveBeenNthCalledWith(1, { storages: BROWSER_STORAGE_TYPES });
    expect(session.cookies.flushStore).toHaveBeenCalledTimes(2);
    expect(closeBrowserGuests).toHaveBeenCalledTimes(2);
    expect(broadcastReset).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toEqual({ enabled: true, available: true, clearing: false });
  });

  it("disables and resets Browser guests without clearing profile data", async () => {
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
    expect(broadcastReset).toHaveBeenCalledWith({ reason: "disabled", enabled: false, available: false });
    expect(closeBrowserGuests).toHaveBeenCalledTimes(1);
    expect(session.clearAuthCache).not.toHaveBeenCalled();
    expect(session.clearCache).not.toHaveBeenCalled();
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(session.cookies.flushStore).not.toHaveBeenCalled();

    await controller.setEnabled(true);
    expect(controller.getState()).toEqual({ enabled: true, available: true, clearing: false });
    expect(broadcastReset).toHaveBeenCalledTimes(1);
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

  it("serializes Browser imports with clear and disable lifecycle operations", async () => {
    const importGate = createDeferred();
    const session = createSessionMock();
    const closeBrowserGuests = vi.fn(async () => undefined);
    const controller = createBrowserProfileController({
      partition: "persist:rudder-browser-v1-test",
      session,
      closeBrowserGuests,
      broadcastReset: vi.fn(),
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

    expect(session.clearAuthCache).not.toHaveBeenCalled();
    expect(closeBrowserGuests).not.toHaveBeenCalled();
    importGate.resolve();
    await expect(importing).resolves.toBe(42);
    await clearing;
    await disabling;
    expect(lifecycle).toEqual(["import:start", "import:end", "clear:end", "disable:end"]);
  });
});
