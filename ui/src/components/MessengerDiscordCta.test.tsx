// @vitest-environment jsdom

import { RUDDER_DISCORD_URL } from "@/lib/product-links";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MESSENGER_DISCORD_CTA_COOLDOWN_MS,
  MESSENGER_DISCORD_CTA_ELIGIBILITY_KEY,
  MESSENGER_DISCORD_CTA_STORAGE_KEY,
  MessengerDiscordCta,
} from "./MessengerDiscordCta";

const agentRunState = vi.hoisted(() => ({
  runs: [] as Array<{ status: string }>,
}));
const desktopShellMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  forceOpenExternal: vi.fn(async () => undefined),
}));
const desktopShellState = vi.hoisted(() => ({
  available: false,
  forceOpenExternalAvailable: true,
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-1" }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: agentRunState.runs }),
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => desktopShellState.available
    ? {
      openExternal: desktopShellMocks.openExternal,
      ...(desktopShellState.forceOpenExternalAvailable
        ? { forceOpenExternal: desktopShellMocks.forceOpenExternal }
        : {}),
    }
    : null,
}));

describe("MessengerDiscordCta", () => {
  const now = Date.parse("2026-07-29T08:00:00.000Z");
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(Date, "now").mockReturnValue(now);
    agentRunState.runs = [];
    desktopShellState.available = false;
    desktopShellState.forceOpenExternalAvailable = true;
    desktopShellMocks.openExternal.mockClear();
    desktopShellMocks.forceOpenExternal.mockClear();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.restoreAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  function renderCta() {
    act(() => root.render(<MessengerDiscordCta />));
  }

  it("stays hidden until the first Agent Run succeeds", () => {
    renderCta();
    expect(container.querySelector("[data-testid='messenger-discord-cta']")).toBeNull();

    agentRunState.runs = [{ status: "succeeded" }];
    renderCta();

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).not.toBeNull();
    expect(window.localStorage.getItem(MESSENGER_DISCORD_CTA_ELIGIBILITY_KEY)).toBe(
      "eligible",
    );
  });

  it("keeps eligibility after the completed Agent Run leaves recent history", () => {
    agentRunState.runs = [{ status: "succeeded" }];
    renderCta();

    act(() => root.unmount());
    root = createRoot(container);
    agentRunState.runs = [];
    renderCta();

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).not.toBeNull();
  });

  it("links to the official Discord invite in a safe new window", () => {
    agentRunState.runs = [{ status: "succeeded" }];
    renderCta();

    const link = container.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe(RUDDER_DISCORD_URL);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(link?.getAttribute("aria-label")).toContain("Join our Discord");
    expect(link?.querySelector("[data-testid='discord-logo']")).not.toBeNull();
  });

  it("stays hidden for 15 days after dismissal", () => {
    agentRunState.runs = [{ status: "succeeded" }];
    renderCta();

    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss Discord invitation"]',
    );
    act(() => dismiss?.click());

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).toBeNull();
    expect(window.localStorage.getItem(MESSENGER_DISCORD_CTA_STORAGE_KEY)).toBe(String(now));

    act(() => root.unmount());
    root = createRoot(container);
    renderCta();

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    window.localStorage.setItem(
      MESSENGER_DISCORD_CTA_STORAGE_KEY,
      String(now - MESSENGER_DISCORD_CTA_COOLDOWN_MS),
    );
    renderCta();

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).not.toBeNull();
  });

  it("migrates legacy dismissals into a new 15-day cooldown", () => {
    agentRunState.runs = [{ status: "succeeded" }];
    window.localStorage.setItem(MESSENGER_DISCORD_CTA_STORAGE_KEY, "dismissed");
    renderCta();

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).toBeNull();
    expect(window.localStorage.getItem(MESSENGER_DISCORD_CTA_STORAGE_KEY)).toBe(String(now));
  });

  it("bypasses built-in link routing and opens Discord in the system browser on desktop", () => {
    agentRunState.runs = [{ status: "succeeded" }];
    desktopShellState.available = true;
    renderCta();

    const link = container.querySelector<HTMLAnchorElement>("a");
    act(() => link?.click());

    expect(desktopShellMocks.forceOpenExternal).toHaveBeenCalledWith(RUDDER_DISCORD_URL);
    expect(desktopShellMocks.openExternal).not.toHaveBeenCalled();
  });

  it("never falls back to the built-in Browser route on older desktop bridges", () => {
    agentRunState.runs = [{ status: "succeeded" }];
    desktopShellState.available = true;
    desktopShellState.forceOpenExternalAvailable = false;
    renderCta();

    const link = container.querySelector<HTMLAnchorElement>("a");
    act(() => link?.click());

    expect(desktopShellMocks.forceOpenExternal).not.toHaveBeenCalled();
    expect(desktopShellMocks.openExternal).not.toHaveBeenCalled();
  });
});
