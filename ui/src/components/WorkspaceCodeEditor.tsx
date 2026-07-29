import {
  CHAT_FILE_ANNOTATION_LOCATE_EVENT,
  consumePendingChatFileAnnotationLocation,
  readPendingChatFileAnnotationLocation,
  type ChatFileAnnotationLocateDetail,
} from "@/lib/chat-file-annotation-events";
import { hashChatAnnotationSource } from "@/lib/chat-response-annotation-selection";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useMemo, useRef } from "react";

type WorkspaceCodeLanguage =
  | "javascript"
  | "json"
  | "jsonl"
  | "python"
  | "typescript"
  | "yaml";

type WorkspaceCodeEditorProps = {
  "data-testid"?: string;
  ariaLabel?: string;
  annotationSource?: {
    surface: "workspace_file" | "local_file";
    sourceFilePath: string;
  };
  filePath: string | null;
  value: string;
  onChange?: (value: string) => void;
  onSelectionChange?: (selection: {
    start: number;
    end: number;
    selectedText: string;
    anchorRect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;
  } | null) => void;
  readOnly?: boolean;
  scrollRef?: (element: HTMLDivElement | null) => void;
};

const ignoreWorkspaceCodeChange = () => {};

const WORKSPACE_CODE_LANGUAGE_EXTENSIONS: Record<string, WorkspaceCodeLanguage> = {
  js: "javascript",
  jsx: "javascript",
  json: "json",
  jsonl: "jsonl",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

const workspaceCodeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "color-mix(in oklab, var(--accent-strong) 70%, #6f42c1)" },
  { tag: [tags.string, tags.special(tags.string)], color: "color-mix(in oklab, #16835b 82%, var(--foreground))" },
  { tag: [tags.number, tags.bool, tags.null], color: "color-mix(in oklab, var(--foreground) 70%, #9a6700)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted-foreground)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "color-mix(in oklab, var(--foreground) 70%, #0969da)" },
  { tag: [tags.typeName, tags.className], color: "color-mix(in oklab, var(--foreground) 70%, #8250df)" },
  { tag: tags.propertyName, color: "color-mix(in oklab, #0969da 76%, var(--foreground))" },
  { tag: [tags.operator, tags.punctuation], color: "color-mix(in oklab, var(--foreground) 72%, var(--muted-foreground))" },
  { tag: [tags.invalid, tags.deleted], color: "var(--destructive)" },
]);

const workspaceCodeTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace",
    fontSize: "0.875rem",
    lineHeight: "1.5rem",
  },
  ".cm-content": {
    minHeight: "280px",
    padding: "1rem",
    caretColor: "var(--foreground)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-gutters": {
    backgroundColor: "color-mix(in oklab, var(--surface-page) 65%, transparent)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.75rem",
    paddingLeft: "0.75rem",
    paddingRight: "0.75rem",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklab, var(--accent) 38%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--accent-base) 22%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--accent-base) 32%, transparent)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklab, var(--accent) 52%, transparent)",
    color: "var(--foreground)",
    outline: "none",
  },
  ".cm-nonmatchingBracket": {
    color: "var(--destructive)",
  },
});

function getWorkspaceCodeExtension(filePath: string | null) {
  const name = filePath?.split("/").at(-1) ?? "";
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() : null;
  return extension ? WORKSPACE_CODE_LANGUAGE_EXTENSIONS[extension] ?? null : null;
}

function languageSupportFor(language: WorkspaceCodeLanguage | null): LanguageSupport | null {
  switch (language) {
    case "javascript":
      return javascript({ jsx: true });
    case "json":
    case "jsonl":
      return json();
    case "python":
      return python();
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "yaml":
      return yaml();
    default:
      return null;
  }
}

function workspaceCodeLanguageLabel(language: WorkspaceCodeLanguage | null) {
  switch (language) {
    case "javascript":
      return "JavaScript";
    case "json":
      return "JSON";
    case "jsonl":
      return "JSONL";
    case "python":
      return "Python";
    case "typescript":
      return "TypeScript";
    case "yaml":
      return "YAML";
    default:
      return "Text";
  }
}

export function getWorkspaceCodeLanguageLabel(filePath: string | null) {
  return workspaceCodeLanguageLabel(getWorkspaceCodeExtension(filePath));
}

export function isWorkspaceCodeFilePath(filePath: string | null) {
  return getWorkspaceCodeExtension(filePath) !== null;
}

export function WorkspaceCodeEditor({
  "data-testid": testId,
  ariaLabel = "Code editor",
  annotationSource,
  filePath,
  value,
  onChange = ignoreWorkspaceCodeChange,
  onSelectionChange,
  readOnly = false,
  scrollRef,
}: WorkspaceCodeEditorProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const applyingControlledValueRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const language = getWorkspaceCodeExtension(filePath);
  const languageExtension = useMemo(() => languageSupportFor(language), [language]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    valueRef.current = value;
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue === value) return;
    applyingControlledValueRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    } finally {
      applyingControlledValueRef.current = false;
    }
  }, [value]);

  useEffect(() => {
    const handleLocation = (detail: ChatFileAnnotationLocateDetail | null) => {
      const view = viewRef.current;
      if (
        !view
        || !detail
        || !annotationSource
        || detail.sourceRenderMode !== "text"
        || detail.surface !== annotationSource.surface
        || detail.sourceFilePath !== annotationSource.sourceFilePath
      ) return;
      const currentValue = view.state.doc.toString();
      void hashChatAnnotationSource(currentValue).then((sourceHash) => {
        if (
          sourceHash !== detail.sourceHash
          || detail.start < 0
          || detail.end <= detail.start
          || detail.end > view.state.doc.length
        ) return;
        const canMeasureRange = !navigator.userAgent.toLowerCase().includes("jsdom")
          && typeof document.createRange().getClientRects === "function";
        if (canMeasureRange) {
          view.dispatch({
            selection: { anchor: detail.start, head: detail.end },
            effects: EditorView.scrollIntoView(detail.start, { y: "center" }),
          });
          view.focus();
        }
        if (parentRef.current) {
          parentRef.current.dataset.annotationLocationStart = String(detail.start);
          parentRef.current.dataset.annotationLocationEnd = String(detail.end);
        }
        consumePendingChatFileAnnotationLocation(detail);
      });
    };
    const listener = (event: Event) => {
      handleLocation((event as CustomEvent<ChatFileAnnotationLocateDetail>).detail);
    };
    window.addEventListener(CHAT_FILE_ANNOTATION_LOCATE_EVENT, listener);
    handleLocation(readPendingChatFileAnnotationLocation());
    return () => window.removeEventListener(CHAT_FILE_ANNOTATION_LOCATE_EVENT, listener);
  }, [annotationSource]);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const extensions: Extension[] = [
      basicSetup,
      workspaceCodeTheme,
      syntaxHighlighting(workspaceCodeHighlightStyle),
      keymap.of([]),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const nextValue = update.state.doc.toString();
          valueRef.current = nextValue;
          if (!applyingControlledValueRef.current) {
            onChangeRef.current(nextValue);
          }
        }
        if (update.selectionSet || update.focusChanged || update.docChanged) {
          const selection = update.state.selection.main;
          if (selection.empty || !update.view.hasFocus) {
            onSelectionChangeRef.current?.(null);
          } else {
            const start = Math.min(selection.from, selection.to);
            const end = Math.max(selection.from, selection.to);
            const startRect = update.view.coordsAtPos(start);
            const endRect = update.view.coordsAtPos(end);
            if (startRect && endRect) {
              const left = Math.min(startRect.left, endRect.left);
              const right = Math.max(startRect.right, endRect.right);
              const top = Math.min(startRect.top, endRect.top);
              const bottom = Math.max(startRect.bottom, endRect.bottom);
              onSelectionChangeRef.current?.({
                start,
                end,
                selectedText: update.state.doc.sliceString(start, end),
                anchorRect: {
                  left,
                  right,
                  top,
                  bottom,
                  width: Math.max(1, right - left),
                  height: Math.max(1, bottom - top),
                },
              });
            }
          }
        }
      }),
    ];
    if (languageExtension) {
      extensions.push(languageExtension);
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        extensions,
      }),
      parent,
    });
    viewRef.current = view;
    const scroller = view.scrollDOM instanceof HTMLDivElement ? view.scrollDOM : null;
    scrollRef?.(scroller);

    return () => {
      scrollRef?.(null);
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
      }
    };
  }, [ariaLabel, languageExtension, readOnly, scrollRef]);

  return (
    <div
      ref={parentRef}
      data-testid={testId}
      data-workspace-code-language={workspaceCodeLanguageLabel(language)}
      data-workspace-code-read-only={readOnly ? "true" : "false"}
      className="min-h-[280px] flex-1 overflow-hidden bg-transparent"
    />
  );
}
