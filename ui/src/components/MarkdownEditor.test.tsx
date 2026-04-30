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
    },
    ref: React.ForwardedRef<{ focus: () => void; setMarkdown: (value: string) => void }>,
  ) {
    const [, setMarkdown] = React.useState(props.markdown);
    React.useImperativeHandle(ref, () => ({
      focus: () => undefined,
      setMarkdown: (value: string) => {
        setMarkdown(value);
      },
    }));

    const match = props.markdown.match(/!\[([^\]]*)\]\(([^)]+)\)/);

    return (
      <div className={props.className}>
        <div contentEditable className={props.contentEditableClassName} onBlur={props.onBlur}>
          {match ? <img src={match[2]} alt={match[1]} /> : props.markdown}
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
    linkDialogPlugin: () => ({}),
    linkDialogState$: Symbol("linkDialogState$"),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    realmPlugin: () => () => ({}),
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
  };
});

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  mdxEditorMocks.imagePlugin.mockClear();
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
      bottom: 84,
      maxHeight: 200,
      maxWidth: 1256,
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
      left: 1088,
      top: 222,
      maxHeight: 200,
      maxWidth: 1256,
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

  it("renders issue mention options with status, project, and assignee metadata", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
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

    cleanupFn = () => {
      Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
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
    const textNode = editable?.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

    await act(async () => {
      const range = document.createRange();
      range.setStart(textNode!, 4);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const menu = document.body.querySelector('[data-testid="markdown-mention-menu"]');
    expect(menu?.textContent).toContain("RUD-28 Add icon for opening a file in IDE");
    expect(menu?.textContent).toContain("Todo");
    expect(menu?.textContent).toContain("rudder dev");
    expect(menu?.textContent).toContain("Ella");
    expect(menu?.querySelector('[aria-label="Status: Todo"]')?.className).toContain("text-blue-600");
  });
});
