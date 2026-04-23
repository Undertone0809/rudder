// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMentionMenuPositionForViewport, MarkdownEditor } from "./MarkdownEditor";

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
    ...props
  }: {
    children: import("react").ReactNode;
  }) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: { children: import("react").ReactNode }) => <div>{children}</div>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("../lib/mention-chips", () => ({
  applyMentionChipDecoration: vi.fn(),
  clearMentionChipDecoration: vi.fn(),
  parseMentionChipHref: () => null,
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
          {match ? <img src={match[2]} alt={match[1]} /> : null}
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
    imagePlugin: () => ({}),
    linkDialogPlugin: () => ({}),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
  };
});

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
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

    const preview = document.body.querySelector('[data-testid="markdown-editor-image-preview-dialog"] img');
    expect(preview).toBeTruthy();
    expect(new URL(preview?.getAttribute("src") ?? "", "http://localhost:3000").pathname).toBe(
      "/api/attachments/test/content",
    );
    expect(document.body.textContent).toContain("Architecture diagram");
  });
});
