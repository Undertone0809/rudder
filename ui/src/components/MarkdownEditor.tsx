import { useMarkdownMentions } from "@/context/MarkdownMentionsContext";
import type { AgentRole } from "@rudderhq/shared";
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import type { AtomicInlineTokenElement } from "../lib/inline-token-dom";
import { resolveMarkdownEditorEngine } from "../lib/markdown-editor-engine";

export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project" | "issue" | "automation" | "chat" | "library_doc" | "library_entry" | "library_file" | "library_directory" | "plugin" | "skill";
  searchText?: string;
  agentId?: string;
  agentIcon?: string | null;
  agentRole?: AgentRole | null;
  projectId?: string;
  projectColor?: string | null;
  projectIcon?: string | null;
  issueId?: string;
  issueIdentifier?: string | null;
  issueStatus?: string | null;
  issueProjectName?: string | null;
  issueProjectColor?: string | null;
  issueProjectIcon?: string | null;
  issueAssigneeName?: string | null;
  issueAssigneeIcon?: string | null;
  issueAssigneeRole?: AgentRole | null;
  automationId?: string;
  automationTitle?: string | null;
  automationStatus?: string | null;
  chatConversationId?: string;
  chatTitle?: string | null;
  chatStatus?: string | null;
  chatSummary?: string | null;
  chatUpdatedAt?: Date | string | null;
  libraryDocumentId?: string;
  libraryDocumentTitle?: string | null;
  libraryDocumentUpdatedAt?: Date | string | null;
  libraryDocumentPath?: string | null;
  libraryEntryId?: string | null;
  libraryFilePath?: string | null;
  libraryDirectoryPath?: string | null;
  skillRefLabel?: string | null;
  skillMarkdownTarget?: string | null;
  skillDisplayName?: string | null;
  skillDescription?: string | null;
  skillCategoryLabel?: string | null;
  skillLocationLabel?: string | null;
  skillDetailsHref?: string | null;
  pluginId?: string;
  pluginDescription?: string | null;
  pluginCapabilityLabel?: string | null;
}

export interface InlineTokenClickEvent {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  onBlur?: () => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  bordered?: boolean;
  mentions?: MentionOption[];
  onMentionQueryChange?: (query: string | null) => void;
  agentMentionIntent?: "reference" | "wake";
  mentionMenuAnchorRef?: RefObject<HTMLElement | null>;
  mentionMenuPlacement?: "caret" | "container";
  mentionMenuSize?: "default" | "compact";
  onSubmit?: () => void;
  submitShortcut?: "mod-enter" | "enter";
  plainText?: boolean;
  onInlineTokenClick?: (token: AtomicInlineTokenElement, event: InlineTokenClickEvent) => void;
  activateInlineTokensOnPlainClick?: boolean;
  documentIdentity?: string;
  engine?: "legacy" | "milkdown" | "codemirror";
}

export interface MarkdownEditorRef {
  focus: () => void;
  insertTextAtSelection: (text: string) => boolean;
  getMarkdown?: () => string;
  undo?: () => boolean;
  redo?: () => boolean;
  canUndo?: () => boolean;
  canRedo?: () => boolean;
  revealLine?: (line: number) => void;
}

const LegacyMarkdownEditor = lazy(() => import("./LegacyMarkdownEditor").then((module) => ({ default: module.LegacyMarkdownEditor })));
const CodeMirrorMarkdownEditor = lazy(() => import("./CodeMirrorMarkdownEditor").then((module) => ({ default: module.CodeMirrorMarkdownEditor })));
const MilkdownMarkdownEditor = lazy(() => import("./MilkdownMarkdownEditor").then((module) => ({ default: module.MilkdownMarkdownEditor })));

function mergeMentionOptions(globalMentions: MentionOption[], localMentions: MentionOption[] | undefined) {
  if (!localMentions || localMentions.length === 0) return globalMentions;
  if (globalMentions.length === 0) return localMentions;
  const merged = new Map<string, MentionOption>();
  const identity = (mention: MentionOption) => mention.kind === "skill" && mention.skillMarkdownTarget
    ? `skill-target:${mention.skillMarkdownTarget}`
    : `id:${mention.id}`;
  for (const mention of globalMentions) merged.set(identity(mention), mention);
  for (const mention of localMentions) merged.set(identity(mention), mention);
  return Array.from(merged.values());
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor(props, forwardedRef) {
  const editorRef = useRef<MarkdownEditorRef | null>(null);
  const pendingFocusRef = useRef(false);
  const globalMentions = useMarkdownMentions();
  const mergedMentions = useMemo(
    () => mergeMentionOptions(globalMentions.mentions, props.mentions),
    [globalMentions.mentions, props.mentions],
  );
  const handleMentionQueryChange = useCallback((query: string | null) => {
    globalMentions.onMentionQueryChange(query);
    props.onMentionQueryChange?.(query);
  }, [globalMentions, props.onMentionQueryChange]);
  const editorProps = {
    ...props,
    mentions: mergedMentions,
    onMentionQueryChange: handleMentionQueryChange,
  };
  const resolvedEngine = resolveMarkdownEditorEngine(props);
  const Editor = resolvedEngine === "codemirror"
    ? CodeMirrorMarkdownEditor
    : resolvedEngine === "milkdown"
      ? MilkdownMarkdownEditor
      : LegacyMarkdownEditor;
  const attachEditorRef = useCallback((editor: MarkdownEditorRef | null) => {
    editorRef.current = editor;
    if (editor && pendingFocusRef.current) {
      pendingFocusRef.current = false;
      editor.focus();
    }
  }, []);
  useImperativeHandle(forwardedRef, () => ({
    focus() {
      if (editorRef.current) editorRef.current.focus();
      else pendingFocusRef.current = true;
    },
    insertTextAtSelection(text) {
      return editorRef.current?.insertTextAtSelection(text) ?? false;
    },
    getMarkdown() {
      return editorRef.current?.getMarkdown?.() ?? props.value;
    },
    undo() {
      return editorRef.current?.undo?.() ?? false;
    },
    redo() {
      return editorRef.current?.redo?.() ?? false;
    },
    canUndo() {
      return editorRef.current?.canUndo?.() ?? false;
    },
    canRedo() {
      return editorRef.current?.canRedo?.() ?? false;
    },
    revealLine(line) {
      editorRef.current?.revealLine?.(line);
    },
  }), [props.value]);
  return (
    <Suspense fallback={<div className="min-h-20 animate-pulse rounded border bg-muted/30" aria-hidden="true" />}>
      <Editor {...editorProps} ref={attachEditorRef} />
    </Suspense>
  );
});
