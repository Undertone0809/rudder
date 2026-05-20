// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InlineEditor } from "./InlineEditor";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const markdownEditorHarness = vi.hoisted(() => ({
  onChange: null as null | ((value: string) => void),
  onSubmit: null as null | (() => void),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => (
    <div data-testid="markdown-body">{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, onSubmit }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
  }) => {
    markdownEditorHarness.onChange = onChange;
    markdownEditorHarness.onSubmit = onSubmit;
    return (
      <textarea
        data-testid="markdown-editor"
        value={value}
        readOnly
      />
    );
  },
}));

describe("InlineEditor", () => {
  it("renders multiline markdown as a direct editable surface without hover highlight", () => {
    const html = renderToStaticMarkup(
      <InlineEditor
        value="Issue context"
        onSave={() => undefined}
        multiline
      />,
    );

    expect(html).toContain("cursor-text");
    expect(html).toContain("Issue context");
    expect(html).not.toContain("hover:bg-accent/50");
  });

  it("keeps hover feedback for compact single-line fields", () => {
    const html = renderToStaticMarkup(
      <InlineEditor
        value="Issue title"
        onSave={() => undefined}
      />,
    );

    expect(html).toContain("cursor-pointer");
    expect(html).toContain("hover:bg-accent/50");
  });

  it("persists clearing a multiline value", async () => {
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="Existing description"
          onSave={onSave}
          multiline
        />,
      );
    });

    const display = host.querySelector(".rudder-inline-markdown-surface");
    expect(display).toBeTruthy();
    await act(async () => {
      display!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const editor = host.querySelector<HTMLTextAreaElement>("[data-testid='markdown-editor']");
    expect(editor).toBeTruthy();
    await act(async () => {
      markdownEditorHarness.onChange?.("");
    });
    await act(async () => {
      markdownEditorHarness.onSubmit?.();
    });

    expect(onSave).toHaveBeenCalledWith("");
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
