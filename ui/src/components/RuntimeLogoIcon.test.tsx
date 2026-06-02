// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeLogoIcon, runtimeLogoSources } from "./RuntimeLogoIcon";
import { ADAPTER_DISPLAY_LIST, ENABLED_ADAPTER_TYPES } from "./AgentConfigForm.advanced";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
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
    root.render(element);
  });
  return container;
}

function sha256ForPublicAsset(src: string) {
  const filePath = path.join(process.cwd(), "ui/public", src.replace(/^\//, ""));
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("RuntimeLogoIcon", () => {
  it("renders original brand assets for every enabled local runtime shown in the adapter menu", () => {
    const expectedSources = {
      claude_local: "/brands/claude-logo.svg",
      codex_local: "/brands/openai-logo.svg",
      gemini_local: "/brands/google-gemini-logo.svg",
      pi_local: "/brands/pi-logo.svg",
      cursor: "/brands/cursor-logo.svg",
    };

    expect([...Object.keys(runtimeLogoSources), "opencode_local"].sort()).toEqual([...ENABLED_ADAPTER_TYPES].sort());

    for (const [runtimeType, expectedSrc] of Object.entries(expectedSources)) {
      const container = render(<RuntimeLogoIcon runtimeType={runtimeType} />);
      const source = runtimeLogoSources[runtimeType];
      expect(source?.src).toBe(expectedSrc);
      expect(source?.sourceUrl).toMatch(/^https:\/\//);
      expect(sha256ForPublicAsset(source.src)).toBe(source.sourceSha256);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(expectedSrc);
      cleanupFn?.();
      cleanupFn = null;
      document.body.innerHTML = "";
    }

    const container = render(<RuntimeLogoIcon runtimeType="opencode_local" />);
    expect(Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual([
      "/brands/opencode-logo-light-square.svg",
      "/brands/opencode-logo-dark-square.svg",
    ]);
  });

  it("uses a display label for pi_local instead of the raw key", () => {
    expect(ADAPTER_DISPLAY_LIST.find((item) => item.value === "pi_local")?.label).toBe("Pi (local)");
  });
});
