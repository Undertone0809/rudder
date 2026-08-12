// @vitest-environment jsdom

import type { DesktopIdentityApi, DesktopIdentityState } from "@/lib/desktop-identity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceProfileSettings } from "./InstanceProfileSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mutate = vi.hoisted(() => vi.fn());
const profileSettings = vi.hoisted(() => ({
  nickname: "Zee",
  moreAboutYou: "Existing profile context.",
}));
const profileQueryState = vi.hoisted(() => ({
  isLoading: false,
  error: null as Error | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: profileSettings,
    isLoading: profileQueryState.isLoading,
    error: profileQueryState.error,
  }),
  useMutation: () => ({
    mutate,
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const translate = vi.hoisted(() => {
  const messages: Record<string, string> = {
    "common.systemSettings": "System settings",
    "common.profile": "Profile",
    "profile.title": "Profile",
    "profile.loadFailed": "Failed to load profile settings.",
    "profile.updateFailed": "Failed to update profile settings.",
    "profile.toastSaved.title": "Profile saved",
    "profile.toastSaved.body": "Your operator profile has been updated.",
    "profile.toastSaveFailed.title": "Failed to save profile",
    "profile.about.title": "About you",
    "profile.nickname.label": "Your nickname",
    "profile.nickname.placeholder": "What should Rudder call you?",
    "profile.moreAboutYou.label": "More about you",
    "profile.moreAboutYou.placeholder": "Share standing context.",
    "profile.moreAboutYou.help": "More about you help",
    "profile.import.helper.title": "Import memories from another AI",
    "profile.import.helper.description": "Copy this prompt into another AI provider, then paste the exported memory below.",
    "profile.import.copyPrompt": "Copy memory import prompt",
    "profile.import.copiedButton": "Copied",
    "profile.import.copied.title": "Prompt copied",
    "profile.import.copied.body": "Paste the result into More about you, then edit and save.",
    "profile.import.copyFailed.title": "Prompt was not copied",
    "profile.import.copyFailed.body": "Select the prompt text and copy it manually.",
    "profile.save": "Save profile",
    "profile.saving": "Saving...",
    "account.desktopOnly.title": "Rudder Account",
    "account.desktopOnly.status": "Desktop app only",
    "account.desktopOnly.description": "Open this setting in Rudder Desktop.",
    "account.status.title": "Rudder Account",
    "account.signedIn.description": "This device is connected.",
    "account.signOut": "Sign out",
    "account.signingOut": "Signing out...",
    "account.sessions.title": "Device sessions",
    "account.sessions.description": "Review devices.",
    "account.sessions.empty": "No device sessions reported",
    "account.sessions.emptyDescription": "No active devices.",
    "account.avatar.change": "Change avatar",
    "account.avatar.changing": "Changing avatar...",
    "account.avatar.saveFailed": "Unable to save your avatar.",
  };
  return (key: string) => messages[key] ?? key;
});

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ t: translate }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  mutate.mockReset();
  profileQueryState.isLoading = false;
  profileQueryState.error = null;
  delete (window as typeof window & { desktopIdentity?: unknown }).desktopIdentity;
});

function installSignedInBridge() {
  const signedIn: DesktopIdentityState = {
    status: "signed-in",
    account: {
      id: "account_zeeland",
      email: "zee@rudderhq.dev",
      name: "OAuth Provider Name",
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    },
    deviceId: "device_current",
  };
  const signedOut: DesktopIdentityState = { status: "signed-out" };
  const bridge: DesktopIdentityApi = {
    getState: vi.fn(async () => signedIn),
    signIn: vi.fn(async () => signedIn),
    signOut: vi.fn(async () => signedOut),
    listDeviceSessions: vi.fn(async () => []),
    revokeDeviceSession: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => {
      throw new Error("Unable to load Rudder Account profile (404)");
    }),
    updateProfile: vi.fn(async ({ image }) => ({ ...signedIn.account, email: signedIn.account.email!, image })),
    onStateChanged: vi.fn(() => () => undefined),
  };
  (window as typeof window & { desktopIdentity?: DesktopIdentityApi }).desktopIdentity = bridge;
  return bridge;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value");
  descriptor?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(element: Element) {
  (element as HTMLElement).click();
}

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(<InstanceProfileSettings />);
  });

  return container;
}

describe("InstanceProfileSettings", () => {
  it("places the Rudder Account avatar with the nickname without showing a second name", async () => {
    installSignedInBridge();
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const identityRow = container.querySelector('[data-testid="profile-identity-row"]');
    expect(identityRow?.querySelector("#profile-nickname")).not.toBeNull();
    expect(identityRow?.querySelector("img")).not.toBeNull();
    expect(identityRow?.textContent).toContain("Change avatar");
    expect(container.textContent).not.toContain("OAuth Provider Name");
    expect(container.textContent).not.toContain("Unable to load Rudder Account profile (404)");
    expect(container.textContent).toContain("zee@rudderhq.dev");
  });

  it("does not restore a stale account profile after sign-out", async () => {
    const profileResult = deferred<Awaited<ReturnType<DesktopIdentityApi["getProfile"]>>>();
    const signedIn: Extract<DesktopIdentityState, { status: "signed-in" }> = {
      status: "signed-in",
      account: {
        id: "account_old",
        email: "old@rudderhq.dev",
        name: "Old account",
        image: "data:image/svg+xml;base64,b2xk",
      },
      deviceId: "device_old",
    };
    const listeners = new Set<(state: DesktopIdentityState) => void>();
    const bridge = installSignedInBridge();
    bridge.getState = vi.fn(async () => signedIn);
    bridge.getProfile = vi.fn(() => profileResult.promise);
    bridge.onStateChanged = vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });

    const container = renderPage();
    await act(async () => Promise.resolve());
    expect(container.querySelector('[data-testid="profile-identity-row"] img')).not.toBeNull();

    await act(async () => {
      listeners.forEach((listener) => listener({ status: "signed-out" }));
      profileResult.resolve({ ...signedIn.account, email: signedIn.account.email!, image: "data:image/svg+xml;base64,c3RhbGU=" });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="profile-identity-row"] img')).toBeNull();
    expect(container.querySelector('[data-testid="profile-identity-row"]')?.textContent).not.toContain("Change avatar");
  });

  it("does not apply a stale avatar update after switching accounts", async () => {
    const updateResult = deferred<Awaited<ReturnType<DesktopIdentityApi["updateProfile"]>>>();
    const listeners = new Set<(state: DesktopIdentityState) => void>();
    const bridge = installSignedInBridge();
    bridge.updateProfile = vi.fn(() => updateResult.promise);
    bridge.onStateChanged = vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const container = renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>('[data-testid="account-avatar-input"]');
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    const file = new File([png], "avatar.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(bridge.updateProfile).toHaveBeenCalledOnce());
    });

    const nextImage = "data:image/svg+xml;base64,bmV3";
    await act(async () => {
      listeners.forEach((listener) => listener({
        status: "signed-in",
        account: { id: "account_new", email: "new@rudderhq.dev", name: "New account", image: nextImage },
        deviceId: "device_new",
      }));
      updateResult.resolve({ id: "account_zeeland", email: "zee@rudderhq.dev", name: "Old account", image: "data:image/svg+xml;base64,c3RhbGU=" });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="profile-identity-row"] img')?.getAttribute("src")).toBe(nextImage);
  });

  it("copies the import prompt and keeps pasted provider memory in the editable profile field", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Import memories from another AI");
    expect(container.textContent).toContain("paste the exported memory below");
    expect(container.textContent).toContain("Rudder Account");
    expect(container.textContent).toContain("Desktop app only");
    expect(container.textContent).not.toContain("Profile and account description");
    expect(container.textContent).not.toContain("About section");
    expect(container.textContent).not.toContain("Nickname help");

    const copyButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Copy memory import prompt"));
    expect(copyButton).toBeTruthy();

    await act(async () => {
      click(copyButton!);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain("Export all of my stored memories");
    expect(copyButton?.textContent).toContain("Copied");

    const providerExport = [
      "## Instructions",
      "[unknown] - Always answer concisely.",
      "",
      "## Projects",
      "[2026-05-01] - Rudder: agent orchestration Rudder.",
    ].join("\n");

    const profileTextarea = container.querySelector("#profile-more-about-you") as HTMLTextAreaElement | null;
    expect(profileTextarea).toBeTruthy();

    act(() => {
      setControlValue(profileTextarea!, providerExport);
    });

    expect(profileTextarea?.value).toContain("[unknown] - Always answer concisely.");
    expect(profileTextarea?.value).toContain("Rudder: agent orchestration Rudder.");

    const saveButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Save profile")) as HTMLButtonElement | undefined;
    expect(saveButton).toBeTruthy();
    expect(saveButton?.disabled).toBe(false);

    await act(async () => {
      click(saveButton!);
      await Promise.resolve();
    });

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("keeps Rudder Account controls available when profile loading fails", () => {
    profileQueryState.error = new Error("Profile service unavailable");

    const container = renderPage();

    expect(container.textContent).toContain("Profile service unavailable");
    expect(container.textContent).toContain("Rudder Account");
    expect(container.textContent).toContain("Desktop app only");
  });
});
