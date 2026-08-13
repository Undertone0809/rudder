// @vitest-environment jsdom

import type { DesktopIdentityApi, DesktopIdentityState } from "@/lib/desktop-identity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCurrentUserAvatar } from "./useCurrentUserAvatar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function AvatarProbe() {
  const avatarUrl = useCurrentUserAvatar();
  return <div data-avatar-url={avatarUrl ?? ""} />;
}

afterEach(() => {
  delete (window as typeof window & { desktopIdentity?: unknown }).desktopIdentity;
  document.body.innerHTML = "";
});

describe("useCurrentUserAvatar", () => {
  it("uses refreshed profile data and clears it after sign-out", async () => {
    const listeners = new Set<(state: DesktopIdentityState) => void>();
    const signedIn: DesktopIdentityState = {
      status: "signed-in",
      account: { id: "user-1", email: "zee@example.test", name: "Zee", image: "state-avatar" },
      deviceId: "device-1",
    };
    const bridge: DesktopIdentityApi = {
      getState: vi.fn().mockResolvedValue(signedIn),
      signIn: vi.fn(),
      signOut: vi.fn(),
      listDeviceSessions: vi.fn(),
      revokeDeviceSession: vi.fn(),
      getProfile: vi.fn().mockResolvedValue({ ...signedIn.account, image: "profile-avatar" }),
      updateProfile: vi.fn(),
      onStateChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    (window as typeof window & { desktopIdentity?: DesktopIdentityApi }).desktopIdentity = bridge;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AvatarProbe />));
    await act(async () => undefined);
    expect(container.firstElementChild?.getAttribute("data-avatar-url")).toBe("profile-avatar");

    act(() => listeners.forEach((listener) => listener({ status: "signed-out" })));
    expect(container.firstElementChild?.getAttribute("data-avatar-url")).toBe("");
    act(() => root.unmount());
  });

  it("shares one Desktop subscription across simultaneous consumers", async () => {
    const signedIn: DesktopIdentityState = {
      status: "signed-in",
      account: { id: "user-1", email: "zee@example.test", name: "Zee", image: "shared-avatar" },
      deviceId: "device-1",
    };
    const unsubscribe = vi.fn();
    const bridge: DesktopIdentityApi = {
      getState: vi.fn().mockResolvedValue(signedIn),
      signIn: vi.fn(),
      signOut: vi.fn(),
      listDeviceSessions: vi.fn(),
      revokeDeviceSession: vi.fn(),
      getProfile: vi.fn().mockResolvedValue(signedIn.account),
      updateProfile: vi.fn(),
      onStateChanged: vi.fn(() => unsubscribe),
    };
    (window as typeof window & { desktopIdentity?: DesktopIdentityApi }).desktopIdentity = bridge;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<><AvatarProbe /><AvatarProbe /></>));
    await act(async () => undefined);

    expect(bridge.getState).toHaveBeenCalledOnce();
    expect(bridge.getProfile).toHaveBeenCalledOnce();
    expect(bridge.onStateChanged).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('[data-avatar-url="shared-avatar"]')).toHaveLength(2);

    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not restore a stale initial avatar after a newer sign-out event", async () => {
    const listeners = new Set<(state: DesktopIdentityState) => void>();
    const signedIn: DesktopIdentityState = {
      status: "signed-in",
      account: { id: "user-1", email: "zee@example.test", name: "Zee", image: "stale-avatar" },
      deviceId: "device-1",
    };
    let resolveInitialState: ((state: DesktopIdentityState) => void) | null = null;
    const bridge: DesktopIdentityApi = {
      getState: vi.fn(() => new Promise<DesktopIdentityState>((resolve) => { resolveInitialState = resolve; })),
      signIn: vi.fn(),
      signOut: vi.fn(),
      listDeviceSessions: vi.fn(),
      revokeDeviceSession: vi.fn(),
      getProfile: vi.fn(),
      updateProfile: vi.fn(),
      onStateChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    (window as typeof window & { desktopIdentity?: DesktopIdentityApi }).desktopIdentity = bridge;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AvatarProbe />));
    act(() => listeners.forEach((listener) => listener({ status: "signed-out" })));
    await act(async () => resolveInitialState?.(signedIn));

    expect(container.firstElementChild?.getAttribute("data-avatar-url")).toBe("");
    expect(bridge.getProfile).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("stays empty when the Desktop identity bridge is unavailable", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<AvatarProbe />));
    expect(container.firstElementChild?.getAttribute("data-avatar-url")).toBe("");
    act(() => root.unmount());
  });
});
