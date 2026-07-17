// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeCustomGroupIconValue,
  CustomGroupEditor,
  CustomGroupIcon,
  CustomGroupIconPicker,
  CustomGroupRenameForm,
  customGroupColorFor,
  customGroupStyle,
  isProjectIconName,
  splitCustomGroupIconValue,
} from "./MessengerCustomGroupVisuals";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function change(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("custom group visual values", () => {
  it("normalizes legacy glyphs and round-trips glyph/color values", () => {
    expect(splitCustomGroupIconValue(null)).toEqual({ glyph: "folder", color: null });
    expect(splitCustomGroupIconValue("  brain::teal  ")).toEqual({ glyph: "brain", color: "teal" });
    expect(splitCustomGroupIconValue("spark::unknown")).toEqual({ glyph: "spark", color: null });
    expect(composeCustomGroupIconValue("  ", "rose")).toBe("folder::rose");
    expect(composeCustomGroupIconValue("brain", null)).toBe("brain");
    expect(isProjectIconName(" BRAIN ")).toBe(true);
    expect(isProjectIconName("not-a-project-icon")).toBe(false);
  });

  it("prefers an encoded color and otherwise derives a stable tone and CSS variables", () => {
    expect(customGroupColorFor({ id: "group-a", icon: "brain::amber", sortOrder: 1 })).toBe("amber");
    expect(customGroupColorFor({ id: "group-a", icon: "brain", sortOrder: -2 })).toBe("sky");

    const style = customGroupStyle({ id: "group-a", icon: "brain::teal", sortOrder: 0 });
    expect(style["--messenger-group-bg" as keyof typeof style]).toBe("#dff4ed");
    expect(style["--messenger-group-text-dark" as keyof typeof style]).toBe("#d9fff5");
  });
});

describe("CustomGroupIcon", () => {
  it("renders project, emoji, and compact text glyph variants", () => {
    const container = render(
      <div>
        <CustomGroupIcon icon="brain::teal" />
        <CustomGroupIcon icon="🚀::rose" />
        <CustomGroupIcon icon="Roadmap::sky" />
      </div>,
    );

    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toContain("🚀");
    expect(container.textContent).toContain("Ro");
    expect(container.textContent).not.toContain("Roadmap");
  });
});

describe("CustomGroupIconPicker", () => {
  it("exposes the current selection and emits project and emoji choices", () => {
    const onIconChange = vi.fn();
    const container = render(
      <CustomGroupIconPicker icon="brain::indigo" ariaLabel="Choose group icon" onIconChange={onIconChange} />,
    );

    const brain = container.querySelector<HTMLButtonElement>('[aria-label="Select brain project icon"]');
    const emoji = container.querySelector<HTMLButtonElement>('[aria-label$="group emoji"]');
    expect(brain?.getAttribute("aria-pressed")).toBe("true");
    expect(emoji).toBeTruthy();

    act(() => {
      brain?.click();
      emoji?.click();
    });
    expect(onIconChange).toHaveBeenNthCalledWith(1, "brain");
    expect(onIconChange).toHaveBeenNthCalledWith(2, emoji?.textContent);
  });
});

describe("custom group forms", () => {
  it("emits editor changes and actions while guarding blank or pending submissions", () => {
    const handlers = {
      onNameChange: vi.fn(),
      onIconChange: vi.fn(),
      onColorChange: vi.fn(),
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    };
    const container = render(
      <CustomGroupEditor name="Platform" icon="folder" color="slate" pending={false} {...handlers} />,
    );

    change(container.querySelector<HTMLInputElement>('[aria-label="Group name"]')!, "Runtime");
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Use teal group color"]')?.click();
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel")?.click();
      container.querySelector<HTMLFormElement>("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(handlers.onNameChange).toHaveBeenCalledWith("Runtime");
    expect(handlers.onColorChange).toHaveBeenCalledWith("teal");
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(handlers.onSubmit).toHaveBeenCalledOnce();

    act(() => root?.render(<CustomGroupEditor name="  " icon="folder" color={null} pending={false} {...handlers} />));
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Create")?.disabled).toBe(true);
    act(() => root?.render(<CustomGroupEditor name="Ready" icon="folder" color={null} pending {...handlers} />));
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Create")?.disabled).toBe(true);
  });

  it("supports rename editing, cancellation, submission, and blank-name protection", () => {
    const onNameChange = vi.fn();
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const container = render(
      <CustomGroupRenameForm
        name="Inbox"
        pending={false}
        onNameChange={onNameChange}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );

    change(container.querySelector<HTMLInputElement>("input")!, "Priority");
    act(() => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel")?.click();
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onNameChange).toHaveBeenCalledWith("Priority");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();

    act(() => root?.render(
      <CustomGroupRenameForm name="" pending={false} onNameChange={onNameChange} onCancel={onCancel} onSubmit={onSubmit} />,
    ));
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Save")?.disabled).toBe(true);
  });
});
