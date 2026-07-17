// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CsvWorkspaceEditor, LegacyHeartbeatInstructionsDialog } from "./WorkspaceDocumentEditors";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceDocumentEditors", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps legacy heartbeat cleanup explicit and disabled while deletion is pending", () => {
    const onKeep = vi.fn();
    const onDeleteAll = vi.fn();
    act(() => root.render(
      <LegacyHeartbeatInstructionsDialog
        open
        filePath="agents/ada/HEARTBEAT.md"
        isDeleting={false}
        onKeep={onKeep}
        onDeleteAll={onDeleteAll}
      />,
    ));
    expect(document.body.textContent).toContain("agents/ada/HEARTBEAT.md");
    act(() => button("Keep files for now").click());
    expect(onKeep).toHaveBeenCalledOnce();

    act(() => root.render(
      <LegacyHeartbeatInstructionsDialog
        open
        filePath="agents/ada/HEARTBEAT.md"
        isDeleting
        onKeep={onKeep}
        onDeleteAll={onDeleteAll}
      />,
    ));
    expect(button("Keep files for now").disabled).toBe(true);
    expect(button("Deleting...").disabled).toBe(true);
  });

  it("edits CSV cells and delegates row and column operations with the current file path", () => {
    const onChange = vi.fn();
    const onModeChange = vi.fn();
    act(() => root.render(
      <CsvWorkspaceEditor
        content={"a,b\n1,2"}
        filePath="data.csv"
        mode="table"
        onChange={onChange}
        onModeChange={onModeChange}
        scrollRef={vi.fn()}
      />,
    ));

    changeValue(document.querySelector<HTMLTextAreaElement>("[data-testid='org-workspaces-csv-cell-0-0']")!, "A");
    expect(onChange).toHaveBeenLastCalledWith("data.csv", "A,b\n1,2");
    act(() => button("Column").click());
    expect(onChange).toHaveBeenLastCalledWith("data.csv", "a,b,\n1,2,");
    act(() => button("Row").click());
    expect(onChange).toHaveBeenLastCalledWith("data.csv", "a,b\n1,2\n,");
    act(() => button("Remove CSV row 2").click());
    expect(onChange).toHaveBeenLastCalledWith("data.csv", "a,b");
    act(() => button("Remove CSV column 2").click());
    expect(onChange).toHaveBeenLastCalledWith("data.csv", "a\n1");
    act(() => button("Source").click());
    expect(onModeChange).toHaveBeenCalledWith("source");
  });

  it("delegates source edits without changing the selected file", () => {
    const onChange = vi.fn();
    act(() => root.render(
      <CsvWorkspaceEditor
        content="a,b"
        filePath="data.csv"
        mode="source"
        onChange={onChange}
        onModeChange={vi.fn()}
        scrollRef={vi.fn()}
      />,
    ));
    changeValue(document.querySelector<HTMLTextAreaElement>("[data-testid='org-workspaces-csv-source-textarea']")!, "x,y");
    expect(onChange).toHaveBeenCalledWith("data.csv", "x,y");
  });
});

function button(label: string) {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function changeValue(element: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
