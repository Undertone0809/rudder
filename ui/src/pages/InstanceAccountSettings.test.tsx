// @vitest-environment jsdom

import type {
  DesktopIdentityApi,
  DesktopIdentityState,
} from "@/lib/desktop-identity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceAccountSettings } from "./InstanceAccountSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const translate = vi.hoisted(() => {
  const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.profile": "Profile",
        "profile.title": "Profile",
        "account.title": "Account & security",
        "account.description": "Manage your Rudder Account.",
        "account.desktopOnly.title": "Rudder Account",
        "account.desktopOnly.status": "Desktop app only",
        "account.desktopOnly.description": "Open this setting in Rudder Desktop.",
        "account.status.title": "Rudder Account",
        "account.loading": "Checking your Rudder Account",
        "account.loadingDescription": "Reading account state.",
        "account.loadFailed": "Failed to load your Rudder Account.",
        "account.signedOut.title": "Not signed in",
        "account.signedOut.description": "Sign in to connect this device.",
        "account.signIn": "Sign in",
        "account.signInFailed": "Sign-in failed.",
        "account.signingIn.title": "Complete sign-in in your browser",
        "account.signingIn.description": "Rudder Desktop will return here.",
        "account.signingIn.action": "Signing in...",
        "account.error.title": "Account unavailable",
        "account.tryAgain": "Try again",
        "account.emailUnavailable": "Signed-in account",
        "account.avatar.change": "Change avatar",
        "account.avatar.changing": "Changing avatar...",
        "account.avatar.loadFailed": "Unable to load your account profile.",
        "account.avatar.saveFailed": "Unable to save your avatar.",
        "account.avatar.invalidType": "Choose a JPEG, PNG, or WebP image.",
        "account.avatar.invalidImage": "Choose a valid JPEG, PNG, or WebP image.",
        "account.avatar.tooLarge": "That image is too large. Choose a smaller image.",
        "account.signedIn.description": "This device is connected.",
        "account.signOut": "Sign out",
        "account.signingOut": "Signing out...",
        "account.signOutFailed": "Sign-out failed.",
        "account.sessions.title": "Device sessions",
        "account.sessions.description": "Review devices.",
        "account.sessions.loading": "Loading device sessions...",
        "account.sessions.loadFailed": "Device sessions are unavailable.",
        "account.sessions.empty": "No device sessions reported",
        "account.sessions.emptyDescription": "No active devices.",
        "account.sessions.current": "Current device",
        "account.sessions.lastSeen": "Last seen {{time}}",
        "account.sessions.revoke": "Revoke",
        "account.sessions.revoking": "Revoking...",
        "account.sessions.revokeFailed": "Failed to revoke.",
        "account.sessions.retry": "Retry",
  };
  return (key: string, params?: Record<string, string | number>) =>
    (messages[key] ?? key).replaceAll(/\{\{(\w+)\}\}/g, (_, token: string) =>
      String(params?.[token] ?? `{{${token}}}`),
    );
});

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: translate }),
}));

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  delete (window as typeof window & { desktopIdentity?: unknown }).desktopIdentity;
  document.body.innerHTML = "";
});

function installBridge(overrides: Partial<DesktopIdentityApi> = {}) {
  const signedOut: DesktopIdentityState = { status: "signed-out" };
  const bridge: DesktopIdentityApi = {
    getState: vi.fn(async () => signedOut),
    signIn: vi.fn(async () => signedOut),
    signOut: vi.fn(async () => signedOut),
    listDeviceSessions: vi.fn(async () => []),
    revokeDeviceSession: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => ({
      id: "account_zeeland",
      email: "zee@rudderhq.dev",
      name: "Zee Zeeland",
      image: null,
    })),
    updateProfile: vi.fn(async ({ image }: { image: string | null }) => ({
      id: "account_zeeland",
      email: "zee@rudderhq.dev",
      name: "Zee Zeeland",
      image,
    })),
    onStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
  (window as typeof window & { desktopIdentity?: DesktopIdentityApi }).desktopIdentity = bridge;
  return bridge;
}

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  act(() => {
    root.render(<InstanceAccountSettings />);
  });
  return container;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("InstanceAccountSettings", () => {
  it("shows a truthful Desktop-only state when the identity bridge is absent", () => {
    const container = renderPage();

    expect(container.textContent).toContain("Desktop app only");
    expect(container.textContent).toContain("Open this setting in Rudder Desktop.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("starts sign-in from the signed-out state and renders the returned account", async () => {
    const signedIn: DesktopIdentityState = {
      status: "signed-in",
      account: {
        id: "account_zeeland",
        email: "zee@rudderhq.dev",
        name: "Zee Zeeland",
        image: null,
      },
      deviceId: "device_current",
    };
    const bridge = installBridge({
      signIn: vi.fn(async () => signedIn),
    });
    const container = renderPage();
    await settle();

    const signIn = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Sign in"));
    expect(signIn).toBeDefined();

    await act(async () => {
      signIn?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.signIn).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("zee@rudderhq.dev");
    expect(container.textContent).toContain("Sign out");
  });

  it("lists real device sessions and revokes a non-current device", async () => {
    const signedIn: DesktopIdentityState = {
      status: "signed-in",
      account: {
        id: "account_zeeland",
        email: "zee@rudderhq.dev",
        name: "Zee Zeeland",
        image: null,
      },
      deviceId: "device_current",
    };
    const bridge = installBridge({
      getState: vi.fn(async () => signedIn),
      listDeviceSessions: vi.fn(async () => [
        {
          id: "session_current",
          name: "Zee's MacBook",
          platform: "macOS",
          createdAt: "2026-07-20T10:00:00.000Z",
          lastSeenAt: new Date().toISOString(),
          current: true,
        },
        {
          id: "session_other",
          name: "Build workstation",
          platform: "Linux",
          createdAt: "2026-07-21T10:00:00.000Z",
          lastSeenAt: new Date().toISOString(),
          current: false,
        },
      ]),
    });
    const container = renderPage();
    await settle();

    expect(container.textContent).toContain("Zee's MacBook");
    expect(container.textContent).toContain("Current device");
    expect(container.textContent).toContain("Build workstation");

    const revoke = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Revoke"));
    await act(async () => {
      revoke?.click();
      await Promise.resolve();
    });

    expect(bridge.revokeDeviceSession).toHaveBeenCalledWith("session_other");
    expect(container.textContent).not.toContain("Build workstation");
    expect(container.textContent).toContain("Zee's MacBook");
  });

  it("shows an explicit device-session error instead of placeholder data", async () => {
    const signedIn: DesktopIdentityState = {
      status: "signed-in",
      account: {
        id: "account_zeeland",
        email: null,
        name: "Zee Zeeland",
        image: null,
      },
      deviceId: "device_current",
    };
    installBridge({
      getState: vi.fn(async () => signedIn),
      listDeviceSessions: vi.fn(async () => {
        throw new Error("Device session API is not supported by this desktop build.");
      }),
    });
    const container = renderPage();
    await settle();

    expect(container.textContent).not.toContain("Zee Zeeland");
    expect(container.textContent).toContain("Signed-in account");
    expect(container.textContent).toContain("Device session API is not supported");
    expect(container.textContent).not.toContain("No device sessions reported");
  });

  it("keeps the account section focused on connection state without a second profile name", async () => {
    const signedIn: DesktopIdentityState = {
      status: "signed-in",
      account: {
        id: "account_zeeland",
        email: "zee@rudderhq.dev",
        name: "Zee Zeeland",
        image: null,
      },
      deviceId: "device_current",
    };
    installBridge({
      getState: vi.fn(async () => signedIn),
    });
    const container = renderPage();
    await settle();

    expect(container.textContent).toContain("zee@rudderhq.dev");
    expect(container.textContent).not.toContain("Zee Zeeland");
    expect(container.querySelector("[data-testid='account-avatar-input']")).toBeNull();
  });
});
