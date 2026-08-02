import type { EditorView } from "@codemirror/view";
import {
  buildAgentMentionHref,
  buildAutomationMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryEntryMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";
import type { MentionOption } from "../components/MarkdownEditor";
import { buildMarkdownLink } from "./markdown-live-preview";

export interface CodeMirrorMentionState {
  trigger: "@" | "$";
  query: string;
  from: number;
  to: number;
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
}

export function markdownMentionCompletion(
  option: MentionOption,
  intent?: "reference" | "wake",
) {
  if (option.kind === "skill") {
    if (!option.skillMarkdownTarget || !option.skillRefLabel) return "";
    return `${buildMarkdownLink(option.skillRefLabel, option.skillMarkdownTarget)} `;
  }
  if (option.kind === "issue" && option.issueId) {
    return `${buildMarkdownLink(option.name, buildIssueMentionHref(option.issueId, option.issueIdentifier ?? null, null, option.issueStatus ?? null))} `;
  }
  if (option.kind === "automation" && option.automationId) {
    const title = option.automationTitle ?? option.name;
    return `${buildMarkdownLink(title, buildAutomationMentionHref(option.automationId, title))} `;
  }
  if (option.kind === "chat" && option.chatConversationId) {
    return `${buildMarkdownLink(option.name, buildChatMentionHref(option.chatConversationId, option.chatTitle ?? option.name))} `;
  }
  if (option.kind === "library_doc" && option.libraryDocumentId) {
    return `${buildMarkdownLink(option.name, buildLibraryDocMentionHref(option.libraryDocumentId, option.libraryDocumentTitle ?? option.name))} `;
  }
  if (option.kind === "library_file" && option.libraryFilePath) {
    const href = option.libraryEntryId
      ? buildLibraryEntryMentionHref(option.libraryEntryId, option.name, option.libraryFilePath)
      : buildLibraryFileMentionHref(option.libraryFilePath, option.name);
    return `${buildMarkdownLink(option.name, href)} `;
  }
  if (option.kind === "library_directory" && option.libraryDirectoryPath) {
    return `${buildMarkdownLink(option.name, buildLibraryDirectoryMentionHref(option.libraryDirectoryPath, option.name))} `;
  }
  if (option.kind === "project" && option.projectId) {
    return `${buildMarkdownLink(option.name, buildProjectMentionHref(option.projectId, option.projectColor ?? null, option.projectIcon ?? null))} `;
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/u, "");
  return `${buildMarkdownLink(option.name, buildAgentMentionHref(agentId, option.agentIcon ?? null, intent))} `;
}

export function mentionStateAtSelection(
  view: EditorView,
): CodeMirrorMentionState | null {
  const selection = view.state.selection.main;
  if (!selection.empty) return null;
  const line = view.state.doc.lineAt(selection.head);
  const before = view.state.sliceDoc(line.from, selection.head);
  const match = before.match(/(?:^|[\s([{>])([@$])([^\s@$]*)$/u);
  const trigger = match?.[1];
  if (trigger !== "@" && trigger !== "$") return null;
  const query = match?.[2] ?? "";
  const from = selection.head - query.length - 1;
  const coords = view.coordsAtPos(from)
    ?? view.contentDOM.getBoundingClientRect();
  return {
    trigger,
    query,
    from,
    to: selection.head,
    viewportTop: coords.top,
    viewportBottom: coords.bottom,
    viewportLeft: coords.left,
  };
}

export function sameMentionState(
  left: CodeMirrorMentionState | null,
  right: CodeMirrorMentionState | null,
) {
  return left === right || Boolean(
    left
    && right
    && left.trigger === right.trigger
    && left.query === right.query
    && left.from === right.from
    && left.to === right.to
    && left.viewportTop === right.viewportTop
    && left.viewportBottom === right.viewportBottom
    && left.viewportLeft === right.viewportLeft
  );
}

export function focusAdjacentEditorControl(
  editor: HTMLElement,
  backwards: boolean,
) {
  const scope = editor.closest('[role="dialog"]') ?? editor.ownerDocument;
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>([
    "button:not([disabled])",
    "a[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(","))).filter((candidate) => (
    !candidate.hidden
    && candidate.getAttribute("aria-hidden") !== "true"
    && !candidate.classList.contains("hidden")
  ));
  const currentIndex = candidates.indexOf(editor);
  if (currentIndex < 0) return;
  const editorRoot = editor.closest('[data-editor-engine="codemirror-live-preview"]');
  const direction = backwards ? -1 : 1;
  for (
    let index = currentIndex + direction;
    index >= 0 && index < candidates.length;
    index += direction
  ) {
    const candidate = candidates[index]!;
    if (editorRoot?.contains(candidate)) continue;
    candidate.focus();
    break;
  }
}
