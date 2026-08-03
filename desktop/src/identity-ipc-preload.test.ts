import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_IDENTITY_IPC_CHANNELS } from "./identity-ipc.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

await import("./preload.js");

type ExposedDesktopIdentity = {
  getState(): Promise<unknown>;
  signIn(hint?: { method: "google" }): Promise<unknown>;
  signOut(): Promise<unknown>;
  listDeviceSessions(): Promise<unknown[]>;
  revokeDeviceSession(deviceId: string): Promise<void>;
  getProfile(): Promise<unknown>;
  updateProfile(input: { image: string | null }): Promise<unknown>;
  onStateChanged(listener: (state: unknown) => void): () => void;
};

function desktopIdentity(): ExposedDesktopIdentity {
  const exposed = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "desktopIdentity");
  if (!exposed) throw new Error("desktopIdentity was not exposed");
  return exposed[1] as ExposedDesktopIdentity;
}

describe("Desktop Rudder Account preload bridge", () => {
  beforeEach(() => {
    electronMocks.invoke.mockClear();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();
  });

  it("exposes only narrow Rudder Account commands", async () => {
    const identity = desktopIdentity();

    await identity.getState();
    await identity.signIn({ method: "google" });
    await identity.signOut();
    await identity.listDeviceSessions();
    await identity.revokeDeviceSession("device-1");
    await identity.getProfile();
    await identity.updateProfile({ image: null });

    expect(electronMocks.invoke.mock.calls).toEqual([
      [DESKTOP_IDENTITY_IPC_CHANNELS.getState],
      [DESKTOP_IDENTITY_IPC_CHANNELS.signIn, { method: "google" }],
      [DESKTOP_IDENTITY_IPC_CHANNELS.signOut],
      [DESKTOP_IDENTITY_IPC_CHANNELS.listDeviceSessions],
      [DESKTOP_IDENTITY_IPC_CHANNELS.revokeDeviceSession, { deviceId: "device-1" }],
      [DESKTOP_IDENTITY_IPC_CHANNELS.getProfile],
      [DESKTOP_IDENTITY_IPC_CHANNELS.updateProfile, { image: null }],
    ]);
  });

  it("forwards only valid state events and can unsubscribe", () => {
    const listener = vi.fn();
    const remove = desktopIdentity().onStateChanged(listener);
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged,
    );

    registration?.[1]({}, {
      status: "signed-in",
      account: { id: "account-1", email: null, name: "Rudder User", image: null },
      deviceId: "device-1",
      refreshToken: "must-not-cross-bridge",
    });
    registration?.[1]({}, { status: "signed-in", account: { id: "account-1" }, refreshToken: "secret" });
    registration?.[1]({}, { status: "unknown" });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      status: "signed-in",
      account: { id: "account-1", email: null, name: "Rudder User", image: null },
      deviceId: "device-1",
    });

    remove();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged,
      registration?.[1],
    );
  });
});
