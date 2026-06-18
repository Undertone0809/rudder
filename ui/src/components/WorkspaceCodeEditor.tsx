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
  filePath: string | null;
  value: string;
  onChange: (value: string) => void;
  scrollRef?: (element: HTMLDivElement | null) => void;
};

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
  filePath,
  value,
  onChange,
  scrollRef,
}: WorkspaceCodeEditorProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const language = getWorkspaceCodeExtension(filePath);
  const languageExtension = useMemo(() => languageSupportFor(language), [language]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    valueRef.current = value;
    const view = viewRef.current;
    if (!view) return;
    const currentValue = view.state.doc.toString();
    if (currentValue === value) return;
    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const extensions: Extension[] = [
      basicSetup,
      workspaceCodeTheme,
      syntaxHighlighting(workspaceCodeHighlightStyle),
      keymap.of([]),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const nextValue = update.state.doc.toString();
        valueRef.current = nextValue;
        onChangeRef.current(nextValue);
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
  }, [ariaLabel, languageExtension, scrollRef]);

  return (
    <div
      ref={parentRef}
      data-testid={testId}
      data-workspace-code-language={workspaceCodeLanguageLabel(language)}
      className="min-h-[280px] flex-1 overflow-hidden bg-transparent"
    />
  );
}
