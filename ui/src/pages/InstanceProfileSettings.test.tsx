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
    t: (key: string, params?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.profile": "Profile",
        "common.cancel": "Cancel",
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
        "profile.import.entry.title": "Import profile context",
        "profile.import.entry.description": "Import context description",
        "profile.import.open": "Import from another AI",
        "profile.import.title": "Import profile context",
        "profile.import.description": "Import dialog description",
        "profile.import.copyStep.title": "Copy this prompt to the other AI",
        "profile.import.copy": "Copy",
        "profile.import.copied": "Copied",
        "profile.import.promptLabel": "Memory export prompt",
        "profile.import.copyFailed.title": "Prompt was not copied",
        "profile.import.copyFailed.body": "Select the prompt text and copy it manually.",
        "profile.import.pasteStep.title": "Paste the result",
        "profile.import.paste.label": "Imported profile context",
        "profile.import.paste.placeholder": "Paste the exported memories or profile context here.",
        "profile.import.paste.help": "Paste help",
        "profile.import.review.title": "Review import",
        "profile.import.review.count": `${params?.count ?? 0} sections found`,
        "profile.import.category.instructions": "Instructions",
        "profile.import.category.identity": "Identity",
        "profile.import.category.career": "Career",
        "profile.import.category.projects": "Projects",
        "profile.import.category.preferences": "Preferences",
        "profile.import.category.other": "Imported context",
        "profile.import.mode.append": "Append to current profile",
        "profile.import.mode.append.description": "Append description",
        "profile.import.mode.replace": "Replace More about you",
        "profile.import.mode.replace.description": "Replace description",
        "profile.import.draft.label": "Profile draft",
        "profile.import.draft.help": "Draft help",
        "profile.import.tooLong": "Too long",
        "profile.import.apply": "Apply to profile",
        "profile.import.applied.title": "Import applied",
        "profile.import.applied.body": "Review the profile field, then save when it looks right.",
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
  it("imports selected provider memory into the editable profile field", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const openButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Import from another AI"));
    expect(openButton).toBeTruthy();

    act(() => {
      click(openButton!);
    });

    const pastedExport = [
      "## Instructions",
      "[unknown] - Always answer concisely.",
      "",
      "## Projects",
      "[2026-05-01] - Rudder: agent orchestration control plane.",
    ].join("\n");

    const importTextarea = document.querySelector(
      'textarea[aria-label="Imported profile context"]',
    ) as HTMLTextAreaElement | null;
    expect(importTextarea).toBeTruthy();

    act(() => {
      setControlValue(importTextarea!, pastedExport);
    });

    const draftTextarea = document.querySelector("#profile-import-draft") as HTMLTextAreaElement | null;
    expect(draftTextarea?.value).toContain("Instructions:");
    expect(draftTextarea?.value).toContain("Projects:");

    const applyButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Apply to profile"));
    expect(applyButton).toBeTruthy();
    expect((applyButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      click(applyButton!);
      await Promise.resolve();
    });

    const profileTextarea = container.querySelector("#profile-more-about-you") as HTMLTextAreaElement | null;
    expect(profileTextarea?.value).toContain("Existing profile context.");
    expect(profileTextarea?.value).toContain("Instructions:\n[unknown] - Always answer concisely.");
    expect(profileTextarea?.value).toContain("Projects:\n[2026-05-01] - Rudder: agent orchestration control plane.");
  });
});
