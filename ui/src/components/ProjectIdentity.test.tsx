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
      root.render(<ProjectIcon color={PROJECT_COLORS[0]} icon={null} label="Project identity" />);
    });

    const projectIcon = container.querySelector<HTMLElement>('[aria-label="Project identity"]');
    expect(projectIcon).toBeTruthy();
    expect(projectIcon?.style.getPropertyValue("--project-accent-color")).toBe("#6366f1");
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

    act(() => {
      colorButtons[1]?.click();
      stethoscopeButton?.click();
    });

    expect(onColorChange).toHaveBeenCalledWith(PROJECT_COLORS[1]);
    expect(onIconChange).toHaveBeenCalledWith("stethoscope");
    act(() => root.unmount());
  });
});
