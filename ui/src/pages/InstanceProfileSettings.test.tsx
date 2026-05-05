// @vitest-environment jsdom

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

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: profileSettings,
    isLoading: false,
    error: null,
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

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.profile": "Profile",
        "profile.title": "Profile",
        "profile.description": "Profile description",
        "profile.loadFailed": "Failed to load profile settings.",
        "profile.updateFailed": "Failed to update profile settings.",
        "profile.toastSaved.title": "Profile saved",
        "profile.toastSaved.body": "Your operator profile has been updated.",
        "profile.toastSaveFailed.title": "Failed to save profile",
        "profile.about.title": "About you",
        "profile.about.description": "About section",
        "profile.nickname.label": "Your nickname",
        "profile.nickname.placeholder": "What should Rudder call you?",
        "profile.nickname.help": "Nickname help",
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
      };
      return messages[key] ?? key;
    },
  }),
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
});

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
      "[2026-05-01] - Rudder: agent orchestration control plane.",
    ].join("\n");

    const profileTextarea = container.querySelector("#profile-more-about-you") as HTMLTextAreaElement | null;
    expect(profileTextarea).toBeTruthy();

    act(() => {
      setControlValue(profileTextarea!, providerExport);
    });

    expect(profileTextarea?.value).toContain("[unknown] - Always answer concisely.");
    expect(profileTextarea?.value).toContain("Rudder: agent orchestration control plane.");

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
});
