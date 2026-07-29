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
  engine: null as null | string,
  onChange: null as null | ((value: string) => void),
  onSubmit: null as null | (() => void),
  submitShortcut: null as null | string,
  focus: vi.fn(),
  activateInlineTokensOnPlainClick: null as null | boolean,
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="markdown-body" className={className}>{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    MarkdownEditor: forwardRef(function MarkdownEditorMock({
      value,
      onChange,
      onSubmit,
      contentClassName,
      engine,
      submitShortcut,
      activateInlineTokensOnPlainClick,
    }: {
      value: string;
      onChange: (value: string) => void;
      onSubmit: () => void;
      contentClassName?: string;
      engine?: string;
      submitShortcut?: string;
      activateInlineTokensOnPlainClick?: boolean;
    }, ref) {
      markdownEditorHarness.currentMarkdown = value;
      markdownEditorHarness.engine = engine ?? null;
      markdownEditorHarness.onChange = (nextValue) => {
        markdownEditorHarness.currentMarkdown = nextValue;
        onChange(nextValue);
      };
      markdownEditorHarness.onSubmit = onSubmit;
      markdownEditorHarness.submitShortcut = submitShortcut ?? null;
      markdownEditorHarness.activateInlineTokensOnPlainClick =
        activateInlineTokensOnPlainClick ?? null;
      useImperativeHandle(ref, () => ({
        focus: markdownEditorHarness.focus,
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

  it("renders CodeMirror document preview directly so a clicked line activates in place", () => {
    const html = renderToStaticMarkup(
      <InlineEditor
        value="# Goal description"
        onSave={() => undefined}
        multiline
        editorEngine="codemirror"
      />,
    );

    expect(html).toContain("data-testid=\"markdown-editor\"");
    expect(html).not.toContain("data-testid=\"markdown-body\"");
  });

  it("activates inline reference links on plain click in issue descriptions", () => {
    renderToStaticMarkup(
      <InlineEditor
        value="Use [brief](library-file://file?p=docs%2Fbrief.md)."
        onSave={() => undefined}
        multiline
        alwaysEdit
        editorEngine="milkdown"
        variant="issue-description"
      />,
    );

    expect(markdownEditorHarness.activateInlineTokensOnPlainClick).toBe(true);
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

  it("routes CodeMirror document descriptions without trimming non-empty Markdown", async () => {
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="Persisted"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });

    expect(markdownEditorHarness.engine).toBe("codemirror");
    await act(async () => {
      markdownEditorHarness.onChange?.("\n  **Exact**  \n");
      markdownEditorHarness.onSubmit?.();
    });

    expect(onSave).toHaveBeenCalledWith("\n  **Exact**  \n");
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("accepts an external CodeMirror value while focused when the draft is unchanged", async () => {
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="Original"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });

    await act(async () => {
      host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
        new FocusEvent("focusin", { bubbles: true }),
      );
      root.render(
        <InlineEditor
          value="Updated externally"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });
    expect(markdownEditorHarness.currentMarkdown).toBe("Updated externally");

    await act(async () => {
      host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
    });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("keeps a dirty CodeMirror draft without saving when an external update arrives", async () => {
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="Original"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });

    await act(async () => {
      host.querySelector<HTMLElement>("[data-testid='markdown-editor']")!.focus();
      markdownEditorHarness.onChange?.("Local draft");
      root.render(
        <InlineEditor
          value="Updated externally"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });
    const conflictStatus = Array.from(host.querySelectorAll("span")).find(
      (element) => element.textContent === "Updated elsewhere — submit to overwrite",
    );
    expect(conflictStatus?.className).toContain("opacity-100");

    await act(async () => {
      host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(markdownEditorHarness.currentMarkdown).toBe("Local draft");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("accepts the external CodeMirror value on Escape without saving the dirty draft", async () => {
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="Original"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });

    const editor = host.querySelector<HTMLElement>("[data-testid='markdown-editor']")!;
    await act(async () => {
      editor.focus();
      markdownEditorHarness.onChange?.("Local draft");
      root.render(
        <InlineEditor
          value="Updated externally"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(markdownEditorHarness.currentMarkdown).toBe("Updated externally");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("allows an explicit CodeMirror submit to overwrite an external update", async () => {
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <InlineEditor
          value="Original"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });

    await act(async () => {
      host.querySelector<HTMLElement>("[data-testid='markdown-editor']")!.focus();
      markdownEditorHarness.onChange?.("Local draft");
      root.render(
        <InlineEditor
          value="Updated externally"
          onSave={onSave}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });
    await act(async () => {
      markdownEditorHarness.onSubmit?.();
    });

    expect(onSave).toHaveBeenCalledWith("Local draft");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("leaves an always-edit CodeMirror document in preview until the user focuses it", async () => {
    markdownEditorHarness.focus.mockClear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <InlineEditor
          value="# Preview first"
          onSave={() => undefined}
          multiline
          alwaysEdit
          editorEngine="codemirror"
        />,
      );
    });

    expect(markdownEditorHarness.focus).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("serializes an in-flight autosave before the latest explicit save", async () => {
    vi.useFakeTimers();
    let resolveFirstSave: (() => void) | undefined;
    let resolveSecondSave: (() => void) | undefined;
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveSecondSave = resolve;
      }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
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

      await act(async () => {
        host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
          new FocusEvent("focusin", { bubbles: true }),
        );
        markdownEditorHarness.onChange?.("Issue context\n\nAutosave draft");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenNthCalledWith(1, "Issue context\n\nAutosave draft");

      await act(async () => {
        markdownEditorHarness.onChange?.("Issue context\n\nNewest draft");
        markdownEditorHarness.onSubmit?.();
      });
      expect(onSave).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirstSave?.();
        await Promise.resolve();
      });
      expect(onSave).toHaveBeenCalledTimes(2);
      expect(onSave).toHaveBeenNthCalledWith(2, "Issue context\n\nNewest draft");

      await act(async () => {
        resolveSecondSave?.();
        await vi.advanceTimersByTimeAsync(1_800);
      });
      expect(onSave).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      vi.useRealTimers();
    }
  });

  it("queues a return to the persisted value behind an in-flight autosave", async () => {
    vi.useFakeTimers();
    let resolveAutosave: (() => void) | undefined;
    let resolveRevert: (() => void) | undefined;
    const onSave = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveAutosave = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveRevert = resolve;
      }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <InlineEditor
            value="Persisted value"
            onSave={onSave}
            multiline
            alwaysEdit
          />,
        );
      });
      await act(async () => {
        host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
          new FocusEvent("focusin", { bubbles: true }),
        );
        markdownEditorHarness.onChange?.("Pending autosave");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(onSave).toHaveBeenNthCalledWith(1, "Pending autosave");

      await act(async () => {
        markdownEditorHarness.onChange?.("Persisted value");
        markdownEditorHarness.onSubmit?.();
      });
      expect(onSave).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveAutosave?.();
        await Promise.resolve();
      });
      expect(onSave).toHaveBeenCalledTimes(2);
      expect(onSave).toHaveBeenNthCalledWith(2, "Persisted value");

      await act(async () => {
        resolveRevert?.();
        await vi.advanceTimersByTimeAsync(1_800);
      });
      expect(onSave).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      vi.useRealTimers();
    }
  });

  it("does not suppress a new edit that matches an earlier explicit save", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <InlineEditor
            value="Initial value"
            onSave={onSave}
            multiline
            alwaysEdit
          />,
        );
      });
      await act(async () => {
        host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
          new FocusEvent("focusin", { bubbles: true }),
        );
        markdownEditorHarness.onChange?.("Earlier explicit value");
        host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
          new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
        );
      });
      expect(onSave).toHaveBeenNthCalledWith(1, "Earlier explicit value");

      await act(async () => {
        root.render(
          <InlineEditor
            value="External update"
            onSave={onSave}
            multiline
            alwaysEdit
          />,
        );
      });
      await act(async () => {
        host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
          new FocusEvent("focusin", { bubbles: true }),
        );
        markdownEditorHarness.onChange?.("Earlier explicit value");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });

      expect(onSave).toHaveBeenCalledTimes(2);
      expect(onSave).toHaveBeenNthCalledWith(2, "Earlier explicit value");
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      vi.useRealTimers();
    }
  });

  it("keeps a failed explicit-save draft available for retry", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValueOnce(undefined);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <InlineEditor
            value="Persisted value"
            onSave={onSave}
            multiline
            alwaysEdit
          />,
        );
      });
      await act(async () => {
        markdownEditorHarness.onChange?.("Unsaved draft");
        host.querySelector("[data-testid='markdown-editor']")!.dispatchEvent(
          new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
        );
        await Promise.resolve();
      });

      expect(onSave).toHaveBeenNthCalledWith(1, "Unsaved draft");
      expect(host.querySelector<HTMLTextAreaElement>("[data-testid='markdown-editor']")?.value)
        .toBe("Unsaved draft");

      await act(async () => {
        markdownEditorHarness.onChange?.("Unsaved draft");
        markdownEditorHarness.onSubmit?.();
        await Promise.resolve();
      });
      expect(onSave).toHaveBeenCalledTimes(2);
      expect(onSave).toHaveBeenNthCalledWith(2, "Unsaved draft");
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
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
