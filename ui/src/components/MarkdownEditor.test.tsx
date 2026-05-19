// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
  MarkdownEditor,
} from "./MarkdownEditor";

const mdxEditorMocks = vi.hoisted(() => ({
  imagePlugin: vi.fn(() => ({})),
  linkDialogPlugin: vi.fn(() => ({})),
  lastEditorProps: null as null | {
    translation?: (key: string, defaultValue: string, interpolations?: Record<string, unknown>) => string;
  },
  focusCalls: [] as Array<{
    defaultSelection?: "rootStart" | "rootEnd";
    preventScroll?: boolean;
  } | undefined>,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string) => key,
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: import("react").ReactNode;
  }) => (open ? <div data-testid="mock-dialog-root">{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children: import("react").ReactNode;
    showCloseButton?: boolean;
  }) => <div data-slot="dialog-content" {...props}>{children}</div>,
  DialogClose: ({
    children,
    ...props
  }: {
    children: import("react").ReactNode;
  }) => <button data-slot="dialog-close" {...props}>{children}</button>,
  DialogTitle: ({ children }: { children: import("react").ReactNode }) => <div>{children}</div>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("../lib/mention-chips", () => ({
  applyMentionChipDecoration: vi.fn(),
  clearMentionChipDecoration: vi.fn(),
  parseMentionChipHref: () => null,
  stripMentionChipLabelPrefix: (value: string) => value.replace(/^@(?=\S)/, ""),
}));

vi.mock("../lib/mention-aware-link-node", () => ({
  MentionAwareLinkNode: function MentionAwareLinkNode() {
    return null;
  },
  mentionAwareLinkNodeReplacement: {},
}));

vi.mock("../lib/mention-deletion", () => ({
  mentionDeletionPlugin: () => ({}),
}));

vi.mock("../lib/mention-token-node", () => ({
  $createMentionTokenNode: (label: string) => ({ label }),
  mentionTokenPlugin: () => ({}),
}));

vi.mock("../lib/skill-reference", () => ({
  applySkillTokenDecoration: vi.fn(),
  clearSkillTokenDecoration: vi.fn(),
  parseSkillReference: () => null,
  removeSkillReferenceFromMarkdown: (markdown: string) => markdown,
}));

vi.mock("../lib/skill-token-dom", () => ({
  findAdjacentSkillTokenElement: () => null,
}));

vi.mock("../lib/skill-token-node", () => ({
  $createSkillTokenNode: (label: string) => ({ label }),
  skillTokenPlugin: () => ({}),
}));

vi.mock("@mdxeditor/editor", async () => {
  const React = await import("react");

  const MockEditor = React.forwardRef(function MockEditor(
    props: {
      markdown: string;
      className?: string;
      contentEditableClassName?: string;
      onBlur?: () => void;
      translation?: (key: string, defaultValue: string, interpolations?: Record<string, unknown>) => string;
    },
    ref: React.ForwardedRef<{
      focus: () => void;
      insertMarkdown: (value: string) => void;
      setMarkdown: (value: string) => void;
    }>,
  ) {
    mdxEditorMocks.lastEditorProps = props;
    const [markdown, setMarkdown] = React.useState(props.markdown);
    React.useEffect(() => {
      setMarkdown(props.markdown);
    }, [props.markdown]);
    React.useImperativeHandle(ref, () => ({
      focus: (_callbackFn?: () => void, opts?: { defaultSelection?: "rootStart" | "rootEnd"; preventScroll?: boolean }) => {
        mdxEditorMocks.focusCalls.push(opts);
      },
      insertMarkdown: (value: string) => {
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        if (anchorNode?.nodeType === Node.TEXT_NODE && typeof selection?.anchorOffset === "number") {
          const offset = selection.anchorOffset;
          const text = anchorNode.textContent ?? "";
          let atPos = -1;
          for (let i = offset - 1; i >= 0; i -= 1) {
            if (text[i] === "@" || text[i] === "$") {
              atPos = i;
              break;
            }
            if (/\s/.test(text[i] ?? "")) break;
          }
          if (atPos !== -1) {
            const replaceLength = value.endsWith(" ") && text[offset] === " "
              ? offset - atPos + 1
              : offset - atPos;
            setMarkdown(text.slice(0, atPos) + value + text.slice(atPos + replaceLength));
            return;
          }
        }
        setMarkdown((current) => current + value);
      },
      setMarkdown: (value: string) => {
        setMarkdown(value);
      },
    }));

    const imageMatch = markdown.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    const linkMatch = markdown.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const mentionLinkMatch = linkMatch && /^(agent|project|issue):\/\//.test(linkMatch[2])
      ? linkMatch
      : null;

    return (
      <div className={props.className}>
        <div contentEditable className={props.contentEditableClassName} onBlur={props.onBlur}>
          {imageMatch ? (
            <img src={imageMatch[2]} alt={imageMatch[1]} />
          ) : mentionLinkMatch ? (
            <>
              {markdown.slice(0, mentionLinkMatch.index)}
              <span
                contentEditable={false}
                data-mention-href={mentionLinkMatch[2]}
                data-mention-kind={mentionLinkMatch[2].split("://")[0]}
              >
                {mentionLinkMatch[1]}
              </span>
              {markdown.slice((mentionLinkMatch.index ?? 0) + mentionLinkMatch[0].length)}
            </>
          ) : linkMatch ? (
            <>
              {markdown.slice(0, linkMatch.index)}
              <a href={linkMatch[2]}>{linkMatch[1]}</a>
              {markdown.slice((linkMatch.index ?? 0) + linkMatch[0].length)}
            </>
          ) : markdown}
        </div>
      </div>
    );
  });

  return {
    CodeMirrorEditor: () => null,
    MDXEditor: MockEditor,
    codeBlockPlugin: () => ({}),
    codeMirrorPlugin: () => ({}),
    headingsPlugin: () => ({}),
    imagePlugin: mdxEditorMocks.imagePlugin,
    linkDialogPlugin: mdxEditorMocks.linkDialogPlugin,
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    createRootEditorSubscription$: Symbol("createRootEditorSubscription"),
    realmPlugin: (plugin: unknown) => () => plugin,
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
  };
});

let cleanupFn: (() => void) | null = null;

function stubCaretRect() {
  const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () => ({
    x: 120,
    y: 240,
    width: 1,
    height: 18,
    top: 240,
    right: 121,
    bottom: 258,
    left: 120,
    toJSON: () => undefined,
  });
  return () => {
    Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  };
}

async function placeCaretAndOpenMentionMenu(editable: Element, offset: number) {
  const textNode = editable.firstChild;
  expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

  await act(async () => {
    const range = document.createRange();
    range.setStart(textNode!, offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

async function chooseMentionOption(optionId: string) {
  const option = document.body.querySelector(`[data-testid="markdown-mention-option-${optionId}"]`);
  expect(option).toBeTruthy();

  await act(async () => {
    option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

async function flushAnimationFrames(count = 4) {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  }
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  mdxEditorMocks.imagePlugin.mockClear();
  mdxEditorMocks.linkDialogPlugin.mockClear();
  mdxEditorMocks.lastEditorProps = null;
  mdxEditorMocks.focusCalls = [];
  document.body.innerHTML = "";
});

describe("MarkdownEditor", () => {
  it("opens upward when the composer is close to the viewport bottom", () => {
    const position = getMentionMenuPositionForViewport(
      {
        viewportTop: 640,
        viewportBottom: 658,
        viewportLeft: 540,
      },
      1280,
      720,
    );

    expect(position).toMatchObject({
      left: 540,
      width: 520,
      bottom: 84,
      maxHeight: 200,
    });
    expect("top" in position).toBe(false);
  });

  it("clamps horizontally when the caret is close to the viewport edge", () => {
    const position = getMentionMenuPositionForViewport(
      {
        viewportTop: 200,
        viewportBottom: 218,
        viewportLeft: 1180,
      },
      1280,
      720,
    );

    expect(position).toMatchObject({
      left: 748,
      width: 520,
      top: 222,
      maxHeight: 200,
    });
    expect("bottom" in position).toBe(false);
  });

  it("anchors the wide mention panel above the composer surface", () => {
    const position = getMentionPanelPositionForViewport(
      {
        viewportTop: 520,
        viewportBottom: 672,
        viewportLeft: 420,
        viewportRight: 1180,
      },
      1280,
      720,
    );

    expect(position).toMatchObject({
      left: 420,
      width: 760,
      bottom: 210,
      maxHeight: 360,
    });
    expect("top" in position).toBe(false);
  });

  it("opens an image preview dialog when an inline image is double-clicked", () => {
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
      root.render(
        <MarkdownEditor
          value="![Architecture diagram](/api/attachments/test/content)"
          onChange={() => undefined}
        />,
      );
    });

    const image = container.querySelector("img");
    expect(image).toBeTruthy();

    act(() => {
      image?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    const previewRoot = document.body.querySelector('[data-testid="markdown-editor-image-preview-dialog"]');
    const preview = previewRoot?.querySelector("img");
    expect(preview).toBeTruthy();
    expect(new URL(preview?.getAttribute("src") ?? "", "http://localhost:3000").pathname).toBe(
      "/api/attachments/test/content",
    );
    const dialogContent = previewRoot?.closest('[data-slot="dialog-content"]');
    expect(dialogContent?.className).toContain("border-0");
    expect(dialogContent?.className).toContain("bg-transparent");
    expect(dialogContent?.className).toContain("p-0");
    expect(dialogContent?.className).toContain("shadow-none");
    const closeButton = previewRoot?.querySelector('[data-slot="dialog-close"]');
    expect(closeButton).toBeTruthy();
    expect(closeButton?.parentElement).toBe(previewRoot);
    expect(document.body.textContent).toContain("Architecture diagram");
  });

  it("disables the default inline image toolbar when image uploads are enabled", () => {
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
      root.render(
        <MarkdownEditor
          value=""
          onChange={() => undefined}
          imageUploadHandler={async () => "/api/attachments/test/content"}
        />,
      );
    });

    expect(mdxEditorMocks.imagePlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUploadHandler: expect.any(Function),
        EditImageToolbar: expect.any(Function),
      }),
    );
  });

  it("uses the compact Notion-style link dialog labels", () => {
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
      root.render(
        <MarkdownEditor
          value="[Rudder](https://example.com)"
          onChange={() => undefined}
        />,
      );
    });

    expect(mdxEditorMocks.linkDialogPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ showLinkTitleField: false }),
    );
    expect(mdxEditorMocks.lastEditorProps?.translation?.("createLink.url", "URL")).toBe("Page or URL");
    expect(mdxEditorMocks.lastEditorProps?.translation?.("createLink.text", "Anchor text")).toBe("Link title");
    expect(mdxEditorMocks.lastEditorProps?.translation?.("linkPreview.edit", "Edit link URL")).toBe("Edit");
  });

  it("inserts a selected mention at the active mid-text caret position", async () => {
    const restoreCaretRect = stubCaretRect();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="before @rud after"
          onChange={onChange}
          mentions={[
            {
              id: "agent:agent-1",
              name: "Rudder Bot",
              kind: "agent",
              agentId: "agent-1",
              searchText: "rudder bot rud",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "before @rud".length);
    await chooseMentionOption("agent:agent-1");

    expect(onChange).toHaveBeenCalledWith("before [Rudder Bot](agent://agent-1) after");
    await flushAnimationFrames();

    const selection = window.getSelection();
    expect(selection?.anchorNode?.textContent).toBe(" after");
    expect(selection?.anchorOffset).toBe(1);
    expect(mdxEditorMocks.focusCalls).toContainEqual({
      defaultSelection: "rootEnd",
      preventScroll: true,
    });
  });

  it("keeps the caret on an editable boundary after a mention inserted at the end", async () => {
    const restoreCaretRect = stubCaretRect();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="hello @rud"
          onChange={onChange}
          mentions={[
            {
              id: "agent:agent-1",
              name: "Rudder Bot",
              kind: "agent",
              agentId: "agent-1",
              searchText: "rudder bot rud",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "hello @rud".length);
    await chooseMentionOption("agent:agent-1");

    expect(onChange).toHaveBeenCalledWith("hello [Rudder Bot](agent://agent-1) ");
    await flushAnimationFrames();

    const selection = window.getSelection();
    expect(selection?.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(selection?.anchorNode?.textContent).toBe(" ");
    expect(selection?.anchorOffset).toBe(1);

    await act(async () => {
      editable!.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith("hello [Rudder Bot](agent://agent-1) x");
  });

  it("keeps the caret after a mention selected with Tab in a plain text composer", async () => {
    const restoreCaretRect = stubCaretRect();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="asadsad. @ori"
          onChange={onChange}
          plainText
          mentions={[
            {
              id: "agent:agent-1",
              name: "Orion (Product Release Agent)",
              kind: "agent",
              agentId: "agent-1",
              searchText: "orion product release agent ori",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "asadsad. @ori".length);

    await act(async () => {
      editable!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith(
      "asadsad. [Orion (Product Release Agent)](agent://agent-1) ",
    );
    await flushAnimationFrames();

    const selection = window.getSelection();
    expect(selection?.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(selection?.anchorNode?.textContent).toBe(" \u200B");
    expect(selection?.anchorOffset).toBe(1);
    expect(mdxEditorMocks.focusCalls).toContainEqual({
      defaultSelection: "rootEnd",
      preventScroll: true,
    });

    const copyData = {
      setData: vi.fn(),
    };
    const range = document.createRange();
    range.selectNodeContents(editable!);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: copyData,
    });
    editable!.dispatchEvent(copyEvent);

    expect(copyData.setData).toHaveBeenCalled();
    const copiedPlainText = copyData.setData.mock.calls.at(-1)?.[1] as string;
    expect(copiedPlainText).toContain("asadsad. Orion (Product Release Agent) ");
    expect(copiedPlainText).not.toContain("\u200B");
  });

  it("replaces only the active repeated mention query", async () => {
    const restoreCaretRect = stubCaretRect();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="@rud first and @rud second"
          onChange={onChange}
          mentions={[
            {
              id: "project:project-1",
              name: "Rudder Project",
              kind: "project",
              projectId: "project-1",
              searchText: "rudder project rud",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "@rud first and @rud".length);
    await chooseMentionOption("project:project-1");

    expect(onChange).toHaveBeenCalledWith("@rud first and [Rudder Project](project://project-1) second");
  });

  it("uses $ as the active range for skill mentions", async () => {
    const restoreCaretRect = stubCaretRect();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="ask $mem now"
          onChange={onChange}
          mentions={[
            {
              id: "skill:memory",
              name: "Memory",
              kind: "skill",
              skillRefLabel: "memory",
              skillMarkdownTarget: "skill://memory",
              searchText: "memory mem",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "ask $mem".length);
    await chooseMentionOption("skill:memory");

    expect(onChange).toHaveBeenCalledWith("ask [memory](skill://memory) now");
  });

  it("supports keyboard selection and keeps the active mention option visible", async () => {
    const restoreCaretRect = stubCaretRect();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    cleanupFn = () => {
      restoreCaretRect();
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="@rud now"
          onChange={onChange}
          mentions={[
            {
              id: "agent:agent-1",
              name: "Rudder One",
              kind: "agent",
              agentId: "agent-1",
              searchText: "rudder one rud",
            },
            {
              id: "agent:agent-2",
              name: "Rudder Two",
              kind: "agent",
              agentId: "agent-2",
              searchText: "rudder two rud",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "@rud".length);

    const menu = document.body.querySelector('[data-testid="markdown-mention-menu"]');
    expect(menu?.className).toContain("scrollbar-auto-hide");
    expect(menu?.getAttribute("role")).toBe("listbox");

    await act(async () => {
      editable!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });

    const secondOption = document.body.querySelector('[data-testid="markdown-mention-option-agent:agent-2"]');
    expect(secondOption?.getAttribute("aria-selected")).toBe("true");
    expect(menu?.getAttribute("aria-activedescendant")).toBe("markdown-mention-option-agent:agent-2");
    expect(scrollIntoView).toHaveBeenCalled();

    await act(async () => {
      editable!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith("[Rudder Two](agent://agent-2) now");
  });

  it("includes skill options in @ mention results", async () => {
    const restoreCaretRect = stubCaretRect();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="@build"
          onChange={() => undefined}
          mentions={[
            {
              id: "skill:build-advisor",
              name: "build-advisor",
              kind: "skill",
              skillRefLabel: "build-advisor",
              skillMarkdownTarget: "/skills/build-advisor/SKILL.md",
              searchText: "build advisor",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "@build".length);

    const menu = document.body.querySelector('[data-testid="markdown-mention-menu"]');
    expect(menu?.textContent).toContain("build-advisor");
    expect(document.body.querySelector('[data-testid="markdown-mention-option-skill:build-advisor"]')).not.toBeNull();
  });

  it("keeps entity options out of $ mention results", async () => {
    const restoreCaretRect = stubCaretRect();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="$rud"
          onChange={() => undefined}
          mentions={[
            {
              id: "agent:agent-1",
              name: "Rudder Bot",
              kind: "agent",
              agentId: "agent-1",
              searchText: "rudder bot",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, "$rud".length);

    expect(document.body.querySelector('[data-testid="markdown-mention-menu"]')).toBeNull();
  });

  it("renders container skill mentions with chat composer styling", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const restoreCaretRect = stubCaretRect();

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="$build"
          onChange={() => undefined}
          mentionMenuPlacement="container"
          mentions={[
            {
              id: "skill:build-advisor",
              name: "build-advisor",
              kind: "skill",
              skillRefLabel: "build-advisor",
              skillMarkdownTarget: "/skills/build-advisor/SKILL.md",
              skillDisplayName: "Build Advisor",
              skillDescription: "Professional diagnosis for weak product or implementation results.",
              skillCategoryLabel: "Org",
              searchText: "build advisor product implementation",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, 6);

    const menu = document.body.querySelector('[data-testid="markdown-mention-menu"]');
    expect(menu?.className).toContain("chat-composer-context-menu");
    expect(menu?.getAttribute("role")).toBe("menu");

    const option = document.body.querySelector('[data-testid="markdown-mention-option-skill:build-advisor"]');
    expect(option?.className).toContain("chat-composer-menu-row");
    expect(option?.getAttribute("role")).toBe("menuitem");
    expect(option?.getAttribute("data-chat-composer-menu-item")).toBe("true");
    expect(option?.textContent).toContain("Build Advisor");
    expect(option?.textContent).toContain("Org");
    expect(option?.textContent).toContain("Professional diagnosis");
    expect(option?.textContent).not.toContain("Skill");
  });

  it("renders issue mention options with status, project, and assignee metadata", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const restoreCaretRect = stubCaretRect();

    cleanupFn = () => {
      restoreCaretRect();
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <MarkdownEditor
          value="@rud"
          onChange={() => undefined}
          mentionMenuPlacement="container"
          mentions={[
            {
              id: "issue:issue-1",
              name: "RUD-28 Add icon for opening a file in IDE",
              kind: "issue",
              issueId: "issue-1",
              issueIdentifier: "RUD-28",
              issueStatus: "todo",
              issueProjectName: "rudder dev",
              issueProjectColor: "#3b82f6",
              issueAssigneeName: "Ella",
              issueAssigneeIcon: "sparkles",
              searchText: "RUD-28 Add icon rudder dev Ella todo",
            },
          ]}
        />,
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).toBeTruthy();
    await placeCaretAndOpenMentionMenu(editable!, 4);

    const menu = document.body.querySelector('[data-testid="markdown-mention-menu"]');
    expect(menu?.textContent).toContain("RUD-28 Add icon for opening a file in IDE");
    expect(menu?.textContent).toContain("Todo");
    expect(menu?.textContent).toContain("rudder dev");
    expect(menu?.textContent).toContain("Ella");
    expect(menu?.querySelector('[aria-label="Status: Todo"]')?.className).toContain("text-blue-600");
  });
});
