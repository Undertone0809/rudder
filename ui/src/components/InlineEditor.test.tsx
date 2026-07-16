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
  currentMarkdown: null as null | string,
  onChange: null as null | ((value: string) => void),
  onSubmit: null as null | (() => void),
  submitShortcut: null as null | string,
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="markdown-body" className={className}>
      {children}
      <button type="button" data-testid="markdown-action">Preview image</button>
    </div>
  ),
}));

vi.mock("./MarkdownEditor", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    MarkdownEditor: forwardRef(function MarkdownEditorMock({ value, onChange, onSubmit, contentClassName, submitShortcut }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    contentClassName?: string;
    submitShortcut?: string;
  }, ref) {
    markdownEditorHarness.currentMarkdown = value;
    markdownEditorHarness.onChange = (nextValue) => {
      markdownEditorHarness.currentMarkdown = nextValue;
      onChange(nextValue);
    };
    markdownEditorHarness.onSubmit = onSubmit;
    markdownEditorHarness.submitShortcut = submitShortcut ?? null;
    useImperativeHandle(ref, () => ({
      focus: () => undefined,
      getMarkdown: () => markdownEditorHarness.currentMarkdown ?? value,
    }));
    return (
      <textarea
        data-testid="markdown-editor"
        data-content-class-name={contentClassName}
        value={value}
        readOnly
      />
    );
    }),
  };
});

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

  it("keeps empty multiline placeholders visually muted when caller text color is stronger", () => {
    const html = renderToStaticMarkup(
      <InlineEditor
        value=""
        onSave={() => undefined}
        multiline
        className="text-[15px] leading-7 text-foreground"
        placeholder="Add a description..."
      />,
    );

    expect(html).toContain("Add a description...");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("italic");
    expect(html).not.toContain("text-foreground");
  });

  it("renders always-edit multiline markdown directly as an editor", () => {
    const html = renderToStaticMarkup(
      <InlineEditor
        value="Issue context"
        onSave={() => undefined}
        multiline
        alwaysEdit
      />,
    );

    expect(html).toContain("Issue context");
    expect(html).toContain("data-testid=\"markdown-editor\"");
    expect(html).not.toContain("data-testid=\"markdown-body\"");
    expect(html).not.toContain("hover:bg-accent/50");
  });

  it("flushes changed always-edit Markdown on blur without leaving edit mode", async () => {
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="Issue context"
          onSave={onSave}
          multiline
          alwaysEdit
        />,
      );
    });

    expect(host.querySelector("[data-testid='markdown-body']")).toBeNull();
    expect(host.querySelector("[data-testid='markdown-editor']")).toBeTruthy();
    await act(async () => {
      markdownEditorHarness.onChange?.("Issue context\n\nFollow-up detail");
      host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
    });

    expect(onSave).toHaveBeenCalledWith("Issue context\n\nFollow-up detail");
    expect(host.querySelector("[data-testid='markdown-editor']")).toBeTruthy();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("uses the same issue-description markdown rhythm in read and edit modes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value={"## 需求分析\n\n- 第一条\n- 第二条\n\n问题：几号发版？"}
          onSave={() => undefined}
          multiline
          variant="issue-description"
        />,
      );
    });

    const displayBody = host.querySelector("[data-testid='markdown-body']");
    expect(displayBody?.className).toContain("rudder-inline-markdown-body");
    expect(displayBody?.className).toContain("rudder-issue-description-markdown");
    expect(displayBody?.className).toContain("rudder-issue-description-markdown-read");

    const display = host.querySelector(".rudder-inline-markdown-surface");
    await act(async () => {
      display!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const editor = host.querySelector<HTMLTextAreaElement>("[data-testid='markdown-editor']");
    expect(editor?.dataset.contentClassName).toContain("rudder-edit-in-place-content");
    expect(editor?.dataset.contentClassName).toContain("rudder-issue-description-markdown");
    expect(editor?.dataset.contentClassName).toContain("rudder-issue-description-markdown-edit");
    expect(markdownEditorHarness.submitShortcut).toBe("mod-enter");

    await act(async () => {
      root.unmount();
    });
    host.remove();
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

  it("does not replace a multiline Markdown surface when an embedded action is clicked", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="![Evidence](/api/attachments/evidence/content)"
          onSave={() => undefined}
          multiline
        />,
      );
    });

    const action = host.querySelector("[data-testid='markdown-action']");
    await act(async () => {
      action!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.querySelector("[data-testid='markdown-body']")).toBeTruthy();
    expect(host.querySelector("[data-testid='markdown-editor']")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    host.remove();
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
