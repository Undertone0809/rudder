// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceLocatorField, suggestResourceNameFromLocator } from "./ResourceLocatorField";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const desktopShellMock = {
  pickPath: vi.fn(),
};

let desktopShellValue: typeof desktopShellMock | null = null;
let cleanupFn: (() => void) | null = null;

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => desktopShellValue,
}));

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  desktopShellValue = null;
  desktopShellMock.pickPath.mockReset();
});

function renderField(element: ReactElement) {
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

describe("ResourceLocatorField", () => {
  it("shows browse for local path resources in the desktop shell and writes the picked path", async () => {
    desktopShellValue = desktopShellMock;
    desktopShellMock.pickPath.mockResolvedValue({
      canceled: false,
      path: "/Users/zeeland/projects/rudder",
    });

    const onChange = vi.fn();
    const onPickedPath = vi.fn();
    const container = renderField(
      <ResourceLocatorField
        kind="directory"
        value=""
        onChange={onChange}
        onPickedPath={onPickedPath}
      />,
    );

    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Browse");

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(desktopShellMock.pickPath).toHaveBeenCalledWith({
      kind: "directory",
      title: "Choose directory",
      buttonLabel: "Choose directory",
      defaultPath: undefined,
    });
    expect(onChange).toHaveBeenCalledWith("/Users/zeeland/projects/rudder");
    expect(onPickedPath).toHaveBeenCalledWith("/Users/zeeland/projects/rudder");
  });

  it("does not show browse for URL resources", () => {
    desktopShellValue = desktopShellMock;
    const container = renderField(
      <ResourceLocatorField
        kind="url"
        value=""
        onChange={() => {}}
      />,
    );

    expect(container.querySelector("button")).toBeNull();
  });
});

describe("suggestResourceNameFromLocator", () => {
  it("extracts a readable name from file system locators", () => {
    expect(suggestResourceNameFromLocator("/Users/zeeland/projects/rudder")).toBe("rudder");
    expect(suggestResourceNameFromLocator("C:\\work\\docs\\SPEC.md")).toBe("SPEC.md");
  });
});
