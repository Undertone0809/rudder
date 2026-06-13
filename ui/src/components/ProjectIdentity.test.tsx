// @vitest-environment jsdom

import { PROJECT_COLORS } from "@rudderhq/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectIcon, ProjectIdentityPicker } from "./ProjectIdentity";

describe("ProjectIdentity", () => {
  it("renders the fallback folder icon for legacy projects", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(<ProjectIcon color={PROJECT_COLORS[0]} icon={null} label="Project identity" size="xs" />);
    });

    const projectIcon = container.querySelector<HTMLElement>('[aria-label="Project identity"]');
    expect(projectIcon).toBeTruthy();
    expect(projectIcon?.style.getPropertyValue("--project-accent-color")).toBe("#6366f1");
    expect(projectIcon?.style.background).toBe("");
    expect(projectIcon?.classList.contains("h-4")).toBe(true);
    expect(projectIcon?.querySelector("svg")?.classList.contains("h-4")).toBe(true);
    act(() => root.unmount());
  });

  it("keeps large project icons visually prominent without a filled tile", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(<ProjectIcon color={PROJECT_COLORS[0]} icon="brain" label="Project identity" size="lg" />);
    });

    const projectIcon = container.querySelector<HTMLElement>('[aria-label="Project identity"]');
    const glyph = projectIcon?.querySelector("svg");
    expect(projectIcon?.classList.contains("h-9")).toBe(true);
    expect(glyph?.classList.contains("h-7")).toBe(true);
    expect(projectIcon?.style.background).toBe("");
    act(() => root.unmount());
  });

  it("emits color and icon selections from the picker", () => {
    const onColorChange = vi.fn();
    const onIconChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <ProjectIdentityPicker
          color={PROJECT_COLORS[0]}
          icon="folder"
          onColorChange={onColorChange}
          onIconChange={onIconChange}
        />,
      );
    });

    const colorButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Select project color"]');
    const stethoscopeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Select stethoscope project icon"]',
    );
    expect(stethoscopeButton?.classList.contains("h-9")).toBe(true);
    expect(stethoscopeButton?.querySelector("svg")?.classList.contains("h-5")).toBe(true);

    act(() => {
      colorButtons[1]?.click();
      stethoscopeButton?.click();
    });

    expect(onColorChange).toHaveBeenCalledWith(PROJECT_COLORS[1]);
    expect(onIconChange).toHaveBeenCalledWith("stethoscope");
    act(() => root.unmount());
  });
});
