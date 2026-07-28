// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUDDER_DISCORD_URL } from "@/lib/product-links";
import {
  MESSENGER_DISCORD_CTA_STORAGE_KEY,
  MessengerDiscordCta,
} from "./MessengerDiscordCta";

describe("MessengerDiscordCta", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  function renderCta() {
    act(() => root.render(<MessengerDiscordCta />));
  }

  it("links to the official Discord invite in a safe new window", () => {
    renderCta();

    const link = container.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe(RUDDER_DISCORD_URL);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(link?.getAttribute("aria-label")).toContain("Join our Discord");
    expect(link?.querySelector("[data-testid='discord-logo']")).not.toBeNull();
  });

  it("persists dismissal and stays hidden after remounting", () => {
    renderCta();

    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss Discord invitation"]',
    );
    act(() => dismiss?.click());

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).toBeNull();
    expect(window.localStorage.getItem(MESSENGER_DISCORD_CTA_STORAGE_KEY)).toBe("dismissed");

    act(() => root.unmount());
    root = createRoot(container);
    renderCta();

    expect(container.querySelector("[data-testid='messenger-discord-cta']")).toBeNull();
  });
});
