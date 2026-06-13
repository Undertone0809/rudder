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

    expect(container.querySelector('[aria-label="Project identity"]')).toBeTruthy();
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
    const planeButton = container.querySelector<HTMLButtonElement>('[aria-label="Select plane project icon"]');

    act(() => {
      colorButtons[1]?.click();
      planeButton?.click();
    });

    expect(onColorChange).toHaveBeenCalledWith(PROJECT_COLORS[1]);
    expect(onIconChange).toHaveBeenCalledWith("plane");
    act(() => root.unmount());
  });
});
