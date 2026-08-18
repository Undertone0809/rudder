import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { basicSetup } from "codemirror";
import {
  Code2,
  List,
  ListOrdered,
  MoreHorizontal,
  Square,
  type LucideIcon,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { sourceDrivenMarkdownPreview } from "../lib/codemirror-markdown-live-preview";
import {
  focusAdjacentEditorControl,
  markdownMentionCompletion,
  mentionStateAtSelection,
  sameMentionState,
  type CodeMirrorMentionState,
} from "../lib/codemirror-markdown-mentions";
import {
  emitInlineTokenClick,
  isPrimaryPlainMouseEvent,
  markdownPointerPosition,
  MarkdownPortalWidget,
  openDecoratedMarkdownLink,
  sourceReferenceForTarget,
  type PortalDescriptor,
  type PortalRegistration,
  type PortalRegistry,
} from "../lib/codemirror-markdown-portals";
import {
  codeMirrorMarkdownEditorTheme,
  codeMirrorMarkdownHighlightStyle,
} from "../lib/codemirror-markdown-theme";
import {
  applyMarkdownBlockAction,
  markdownBlockActionDisabled,
  type MarkdownBlockAction,
} from "../lib/markdown-block-actions";
import { alignMarkdownSourceLine } from "../lib/markdown-editor-scroll";
import {
  activeMarkdownPreviewBlockIds,
  buildMarkdownLink,
  escapeMarkdownLinkLabel,
  findAtomicMarkdownReferences,
  getMarkdownPreviewDocument,
  markdownPreviewSource,
  provisionalWebsiteLabel,
  readSingleHttpUrl,
  type MarkdownPreviewBlock,
  type MarkdownPreviewDocument,
} from "../lib/markdown-live-preview";
import { filterMentionOptions } from "../lib/mention-filter";
import {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
} from "../lib/mention-menu-position";
import { cn } from "../lib/utils";
import { getWebsiteMetadata } from "../lib/website-metadata-cache";
import { MarkdownBody, WebsiteLinkIcon } from "./MarkdownBody";
import type {
  MarkdownEditorProps,
  MarkdownEditorRef,
  MentionOption
} from "./MarkdownEditor";
import { MarkdownMentionMenu } from "./MarkdownMentionMenu";
import type { MarkdownSkillReferencePreview } from "./SkillReferenceToken";

type CodeMirrorMarkdownEditorProps = MarkdownEditorProps;

const markdownBlockActions: Array<{
  action: MarkdownBlockAction;
  label: string;
  shortcut?: string;
  icon?: LucideIcon;
  marker?: string;
}> = [
  { action: "display", label: "Display", shortcut: "#", marker: "01" },
  { action: "headline", label: "Headline", shortcut: "##", marker: "02" },
  { action: "subheader", label: "Subheader", shortcut: "###", marker: "03" },
  { action: "body", label: "Body", shortcut: "Mod-4", marker: "04" },
  { action: "task", label: "Task", shortcut: "Mod-T", icon: Square },
  { action: "list", label: "List", shortcut: "Mod-L", icon: List },
  { action: "number-list", label: "Number list", shortcut: "Shift-Mod-L", icon: ListOrdered },
  { action: "code-block", label: "Code block", shortcut: "Shift-Mod-C", icon: Code2 },
];

interface MarkdownBlockHoverState {
  line: number;
  sourceFrom: number;
  top: number;
  left: number;
}

function MarkdownBlockHoverMenu({
  anchor,
  block,
  open,
  onAction,
  onClose,
  onKeepOpen,
  onOpen,
  onScheduleClose,
  overlayRef,
}: {
  anchor: MarkdownBlockHoverState;
  block: MarkdownPreviewBlock | null;
  open: boolean;
  onAction: (action: MarkdownBlockAction) => void;
  onClose: () => void;
  onKeepOpen: () => void;
  onOpen: () => void;
  onScheduleClose: () => void;
  overlayRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `markdown-block-menu-${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;

  useEffect(() => {
    if (!open) return;
    const firstEnabled = menuRef.current?.querySelector<HTMLButtonElement>(
      "[role='menuitem']:not(:disabled)",
    );
    firstEnabled?.focus();
  }, [open]);

  const focusMenuItem = (current: HTMLElement, direction: 1 | -1) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']:not(:disabled)",
      ) ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(current as HTMLButtonElement);
    items[(index + direction + items.length) % items.length]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [onClose, open]);

  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const menuTop = Math.min(Math.max(8, anchor.top + 32), Math.max(8, viewportHeight - 430));
  const menuLeft = Math.min(Math.max(8, anchor.left + 32), Math.max(8, viewportWidth - 372));

  return createPortal(
    <div
      ref={(node) => {
        menuRef.current = node;
        overlayRef.current = node;
      }}
      data-markdown-block-hover-overlay="true"
      data-open={open ? "true" : "false"}
      className="motion-markdown-block-hover"
      onMouseEnter={onKeepOpen}
      onMouseLeave={onScheduleClose}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        transform: `translate3d(${anchor.left}px, ${anchor.top}px, 0)`,
        zIndex: 80,
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="markdown-block-menu-trigger"
        aria-label={`Open block actions for line ${anchor.line}`}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
          triggerRef.current?.focus();
        }}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Block actions for line ${anchor.line}`}
          data-testid="markdown-block-menu"
          className="w-[min(22rem,calc(100vw-1rem))] rounded-xl border border-border/60 bg-popover p-2 text-popover-foreground shadow-xl"
          style={{
            position: "fixed",
            top: menuTop,
            left: menuLeft,
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            focusMenuItem(event.target as HTMLElement, event.key === "ArrowDown" ? 1 : -1);
          }}
        >
          {markdownBlockActions.map(({ action, icon: Icon, label, marker, shortcut }, index) => {
            const disabled = !block || markdownBlockActionDisabled(block.markdown, action, block.kind);
            return (
              <div key={action}>
                {index === 4 ? <div className="my-2 h-px bg-border/70" role="separator" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  data-markdown-block-action={action}
                  disabled={disabled}
                  className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-45 focus-visible:bg-accent focus-visible:outline-none"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!disabled) onAction(action);
                  }}
                >
                  {Icon ? (
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <span className="w-4 shrink-0 text-center text-xs font-semibold text-muted-foreground">
                      {marker}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {shortcut ? <span className="shrink-0 text-xs text-muted-foreground">{shortcut}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

interface PendingTitleUpgrade {
  requestId: number;
  historyTime: number;
  documentIdentity?: string;
  from: number;
  to: number;
  labelFrom: number;
  labelTo: number;
  url: string;
  provisionalMarkdown: string;
}

interface PendingImageUpload {
  from: number;
  to: number;
  empty: boolean;
  expectedSource: string;
}

function clipboardImageFiles(clipboardData: DataTransfer | null) {
  if (!clipboardData) return [];
  const files = Array.from(clipboardData.files).filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) return files;
  return Array.from(clipboardData.items).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

function markdownImageForUpload(file: File, url: string) {
  const label = file.name || "image";
  return `![${label.replace(/([\[\]\\])/gu, "\\$1")}](${url})`;
}

interface MarkdownTableCellEdit {
  column: number;
  element: HTMLTableCellElement;
  from: number;
  height: number;
  left: number;
  row: number;
  sourceFrom: number;
  top: number;
  to: number;
  value: string;
  width: number;
}

interface MarkdownTableCellCommit {
  from: number;
  nextCellFrom: number | null;
  to: number;
  value: string;
}

function isUnescapedTablePipe(source: string, index: number) {
  if (source[index] !== "|") return false;
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 0;
}

function escapeMarkdownTableCellPipes(value: string) {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    if (isUnescapedTablePipe(value, index)) escaped += "\\";
    escaped += value[index];
  }
  return escaped;
}

function markdownTableCellContentRange(raw: string, rawFrom: number) {
  let start = 0;
  let end = raw.length;
  while (start < end && /[ \t]/u.test(raw[start]!)) start += 1;
  if (start < end && isUnescapedTablePipe(raw, start)) start += 1;
  while (start < end && /[ \t]/u.test(raw[start]!)) start += 1;
  while (end > start && /[ \t]/u.test(raw[end - 1]!)) end -= 1;
  if (end > start && isUnescapedTablePipe(raw, end - 1)) end -= 1;
  while (end > start && /[ \t]/u.test(raw[end - 1]!)) end -= 1;
  return { from: rawFrom + start, to: rawFrom + end };
}

const externalValueSync = Annotation.define<boolean>();
const titleUpgradeTransaction = Annotation.define<boolean>();
const markdownListItemLine = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/u;

function selectionIsOnMarkdownListItem(view: EditorView) {
  return view.state.selection.ranges.every((range) => {
    const lastPosition = range.empty ? range.to : Math.max(range.from, range.to - 1);
    let line = view.state.doc.lineAt(range.from);
    const lastLine = view.state.doc.lineAt(lastPosition).number;
    while (line.number <= lastLine) {
      if (!markdownListItemLine.test(line.text)) return false;
      if (line.number === lastLine) break;
      line = view.state.doc.line(line.number + 1);
    }
    return true;
  });
}

function moveMarkdownCursorVertically(view: EditorView, forward: boolean) {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const current = selection.main;
  const currentLine = view.state.doc.lineAt(current.head);
  const adjacentLineNumber = currentLine.number + (forward ? 1 : -1);
  if (adjacentLineNumber < 1 || adjacentLineNumber > view.state.doc.lines) return false;

  const nativeTarget = view.moveVertically(current, forward);
  const nativeLine = view.state.doc.lineAt(nativeTarget.head);
  const skippedSourceLine = forward
    ? nativeLine.number > adjacentLineNumber
    : nativeLine.number < adjacentLineNumber;

  if (!skippedSourceLine) {
    view.dispatch({
      selection: nativeTarget,
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  }

  const adjacentLine = view.state.doc.line(adjacentLineNumber);
  const sourceColumn = current.head - currentLine.from;
  view.dispatch({
    selection: EditorSelection.cursor(
      adjacentLine.from + Math.min(sourceColumn, adjacentLine.length),
    ),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}
const testEditorViews = new WeakMap<Element, EditorView>();

function sourceLineSeparator(source: string) {
  // Keep CRLF's `\r` as source text and use `\n` as CodeMirror's structural
  // separator. A single global separator cannot otherwise round-trip a
  // document that mixes CRLF and LF endings.
  if (source.includes("\n")) return "\n";
  if (source.includes("\r")) return "\r";
  return "\n";
}

function sourceMarkdown(state: EditorState) {
  return state.sliceDoc(0, state.doc.length);
}

function markdownBlockForLine(source: string, lineNumber: number) {
  const document = getMarkdownPreviewDocument(source);
  const blockIndex = document.blocks.findIndex((block) => (
    block.startLine <= lineNumber && block.endLine >= lineNumber
  ));
  if (blockIndex < 0) return null;
  const block = document.blocks[blockIndex]!;
  if (block.kind !== "list") return block;

  let first = blockIndex;
  let last = blockIndex;
  while (first > 0 && document.blocks[first - 1]!.kind === "list"
    && document.blocks[first - 1]!.endLine + 1 >= document.blocks[first]!.startLine) {
    first -= 1;
  }
  while (last + 1 < document.blocks.length && document.blocks[last + 1]!.kind === "list"
    && document.blocks[last]!.endLine + 1 >= document.blocks[last + 1]!.startLine) {
    last += 1;
  }
  const firstBlock = document.blocks[first]!;
  const lastBlock = document.blocks[last]!;
  return {
    ...block,
    id: `${firstBlock.id}:${lastBlock.id}`,
    from: firstBlock.from,
    to: lastBlock.to,
    startLine: firstBlock.startLine,
    endLine: lastBlock.endLine,
    markdown: source.slice(firstBlock.from, lastBlock.to),
  };
}

export function __getCodeMirrorMarkdownViewForTests(root: Element | null): EditorView | null {
  if (!root) return null;
  const editorRoot = root.matches('[data-editor-engine="codemirror-live-preview"]')
    ? root
    : root.querySelector('[data-editor-engine="codemirror-live-preview"]');
  return editorRoot ? testEditorViews.get(editorRoot) ?? null : null;
}

function activeSelectionRanges(state: EditorState) {
  return state.selection.ranges.map((range) => ({
    from: range.from,
    to: range.to,
  }));
}

function richPreviewBlockIds(
  state: EditorState,
  blocks: readonly MarkdownPreviewBlock[],
) {
  const ids = new Set(
    blocks
      .filter((block) => block.kind === "table" || block.kind === "indented-code")
      .map((block) => block.id),
  );
  let blockIndex = 0;
  syntaxTree(state).iterate({
    enter(node) {
      const richNode = node.name === "Image"
        || node.name === "LinkReference"
        || node.name === "LinkLabel"
        || (
          node.name === "CodeInfo"
          && state.sliceDoc(node.from, node.to).trim().toLowerCase() === "mermaid"
        );
      if (!richNode) return;
      while (blockIndex < blocks.length && blocks[blockIndex].to <= node.from) {
        blockIndex += 1;
      }
      const block = blocks[blockIndex];
      if (block && block.from <= node.from && block.to >= node.to) {
        ids.add(block.id);
      }
    },
  });
  return ids;
}

function imageOnlyPreviewBlockIds(
  state: EditorState,
  blocks: readonly MarkdownPreviewBlock[],
) {
  const imageRanges = new Map<string, Array<{ from: number; to: number }>>();
  let blockIndex = 0;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Image") return;
      while (blockIndex < blocks.length && blocks[blockIndex]!.to <= node.from) {
        blockIndex += 1;
      }
      const block = blocks[blockIndex];
      if (!block || block.from > node.from || block.to < node.to) return;
      const ranges = imageRanges.get(block.id) ?? [];
      ranges.push({ from: node.from, to: node.to });
      imageRanges.set(block.id, ranges);
    },
  });

  const ids = new Set<string>();
  for (const block of blocks) {
    const ranges = imageRanges.get(block.id);
    if (!ranges || ranges.length === 0) continue;
    let cursor = block.from;
    const onlyImages = ranges.every((range) => {
      if (state.sliceDoc(cursor, range.from).trim()) return false;
      cursor = range.to;
      return true;
    }) && !state.sliceDoc(cursor, block.to).trim();
    if (onlyImages) ids.add(block.id);
  }
  return ids;
}

function markdownPreviewDecorations(
  state: EditorState,
  document: MarkdownPreviewDocument,
  focused: boolean,
  registry: PortalRegistry,
  propsRef: { current: CodeMirrorMarkdownEditorProps },
  activateBlock: (block: MarkdownPreviewBlock, view: EditorView) => void,
  activeRangesOverride?: Array<{ from: number; to: number }>,
): { decorations: DecorationSet; atomic: DecorationSet } {
  const { blocks, referenceDefinitions } = document;
  const selectionRanges = activeRangesOverride ?? activeSelectionRanges(state);
  const activeIds = focused
    ? activeMarkdownPreviewBlockIds(
      blocks,
      selectionRanges,
    )
    : new Set<string>();
  const imageOnlyIds = imageOnlyPreviewBlockIds(state, blocks);
  for (const block of blocks) {
    if (!imageOnlyIds.has(block.id) || !activeIds.has(block.id)) continue;
    const intersectingSelections = selectionRanges.filter((selection) => (
      block.from <= Math.max(selection.from, selection.to)
      && block.to >= Math.min(selection.from, selection.to)
    ));
    if (
      intersectingSelections.length > 0
      && intersectingSelections.every((selection) => (
        selection.from === selection.to && selection.from === block.to
      ))
    ) {
      activeIds.delete(block.id);
    }
  }
  const decorations: Range<Decoration>[] = [];
  const atomicDecorations: Range<Decoration>[] = [];
  const sourceDrivenBlocks: MarkdownPreviewBlock[] = [];
  const portalBlocks: MarkdownPreviewBlock[] = [];
  const richBlockIds = richPreviewBlockIds(state, blocks);

  for (const block of blocks) {
    if (
      block.previewable
      && !activeIds.has(block.id)
      && richBlockIds.has(block.id)
    ) {
      portalBlocks.push(block);
    } else {
      sourceDrivenBlocks.push(block);
    }
  }

  const references = document.atomicReferences;
  const sourceDriven = sourceDrivenMarkdownPreview(
    state,
    sourceDrivenBlocks,
    activeIds,
    references,
  );
  decorations.push(...sourceDriven.decorations);

  for (const reference of references) {
    if (portalBlocks.some((block) => (
      block.from <= reference.from && block.to >= reference.to
    ))) {
      continue;
    }
    const key = `atomic:${reference.from}:${reference.to}:${reference.markdown}`;
    const replacement = Decoration.replace({
      widget: new MarkdownPortalWidget(
        {
          type: "atomic",
          key,
          reference,
        },
        registry,
        propsRef,
        activateBlock,
      ),
      inclusive: false,
    }).range(reference.from, reference.to);
    decorations.push(replacement);
    atomicDecorations.push(replacement);
  }

  for (const link of sourceDriven.websiteLinks) {
    const key = `website:${link.from}:${link.to}:${link.href}`;
    const widget = Decoration.widget({
      widget: new MarkdownPortalWidget(
        { type: "website", key, link },
        registry,
        propsRef,
        activateBlock,
      ),
      side: -1,
    }).range(link.labelFrom);
    decorations.push(widget);
  }

  for (const block of portalBlocks) {
    if (block.to <= block.from) continue;
    const previewMarkdown = markdownPreviewSource(block, referenceDefinitions);
    const key = `block:${block.id}:${previewMarkdown}`;
    const replacement = Decoration.replace({
      widget: new MarkdownPortalWidget(
        { type: "block", key, block, previewMarkdown },
        registry,
        propsRef,
        activateBlock,
      ),
      inclusive: false,
    }).range(block.from, block.to);
    decorations.push(replacement);
    atomicDecorations.push(replacement);
  }

  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomicDecorations, true),
  };
}

export function previewDocumentForTransaction(
  current: MarkdownPreviewDocument,
  transaction: Transaction,
) {
  if (!transaction.docChanged) return current;
  return getMarkdownPreviewDocument(
    transaction.state.doc.toString(),
    current,
  );
}

function isSmartPasteExcluded(state: EditorState, from: number, to: number) {
  const positions: Array<{ position: number; side: -1 | 1 }> = from === to
    ? [{ position: from, side: 1 }]
    : [
      { position: from, side: 1 },
      { position: Math.max(from, to - 1), side: -1 },
    ];
  if (positions.some(({ position, side }) => {
    let node = syntaxTree(state).resolveInner(position, side);
    while (node) {
      if (/(?:Code|HTML|Link|URL|Autolink)/iu.test(node.name)) return true;
      if (!node.parent) break;
      node = node.parent;
    }
    return false;
  })) {
    return true;
  }
  if (from === to) return false;
  let containsExcludedSyntax = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (/(?:Code|HTML|Link|URL|Autolink)/iu.test(node.name)) {
        containsExcludedSyntax = true;
        return false;
      }
      return undefined;
    },
  });
  return containsExcludedSyntax;
}

function adjacentAtomicReference(
  state: EditorState,
  direction: "backward" | "forward",
) {
  const selection = state.selection.main;
  if (!selection.empty) return null;
  const references = findAtomicMarkdownReferences(state.doc.toString());
  return references.find((reference) => (
    direction === "backward"
      ? reference.to === selection.head
      : reference.from === selection.head
  )) ?? null;
}

type MarkdownPortalDescriptor = Exclude<PortalDescriptor, { type: "website" }>;

function portalLinkClickHandler(descriptor: MarkdownPortalDescriptor) {
  return ({ event }: { event: ReactMouseEvent<HTMLAnchorElement> }) => {
    const tokenElement = event.currentTarget.querySelector<HTMLElement>(
      "[data-mention-kind], [data-skill-token='true']",
    ) ?? event.currentTarget;
    if (descriptor.type === "block") {
      const isToken = tokenElement !== event.currentTarget
        || event.currentTarget.matches("[data-mention-kind], [data-skill-token='true']");
      if (!isToken) return false;
    }
    if (!isPrimaryPlainMouseEvent(event.nativeEvent)) return false;
    // Atomic token activation is owned by the widget's native listener. It
    // runs after React's delegated handler and keeps the same DOM alive across
    // mousedown/click, while this return prevents MarkdownBody's ordinary-link
    // behavior from competing with that activation.
    return true;
  };
}

function PortalMarkdownBody({
  descriptor,
  onTableCellCommit,
  propsRef,
  readSourceRange,
  skillReferences,
}: {
  descriptor: MarkdownPortalDescriptor;
  onTableCellCommit: (commit: MarkdownTableCellCommit) => void;
  propsRef: { current: CodeMirrorMarkdownEditorProps };
  readSourceRange: (from: number, to: number) => string;
  skillReferences: MarkdownSkillReferencePreview[];
}) {
  const keyboardScopeRef = useRef<HTMLSpanElement | null>(null);
  const tableCellInputRef = useRef<HTMLInputElement | null>(null);
  const [tableCellEdit, setTableCellEdit] = useState<MarkdownTableCellEdit | null>(null);
  const tableCellEditRef = useRef<MarkdownTableCellEdit | null>(null);
  tableCellEditRef.current = tableCellEdit;
  const tableCellEditIdentity = tableCellEdit?.sourceFrom ?? null;

  const liveTableCellForEdit = useCallback((edit: MarkdownTableCellEdit) => (
    keyboardScopeRef.current?.querySelector<HTMLTableCellElement>(
      `th[data-markdown-source-start="${edit.sourceFrom}"], td[data-markdown-source-start="${edit.sourceFrom}"]`,
    ) ?? (edit.element.isConnected ? edit.element : null)
  ), []);

  useLayoutEffect(() => {
    const edit = tableCellEditRef.current;
    if (!edit) return;
    const element = liveTableCellForEdit(edit);
    element?.classList.add("rudder-markdown-table-cell--editing");
    tableCellInputRef.current?.focus();
    tableCellInputRef.current?.select();
    return () => {
      element?.classList.remove("rudder-markdown-table-cell--editing");
    };
  }, [liveTableCellForEdit, tableCellEditIdentity]);

  useEffect(() => {
    if (tableCellEditIdentity === null) return;
    let frame: number | null = null;
    const reposition = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const edit = tableCellEditRef.current;
        const element = edit ? liveTableCellForEdit(edit) : null;
        const input = tableCellInputRef.current;
        if (!element || !input) return;
        element.classList.add("rudder-markdown-table-cell--editing");
        const rect = element.getBoundingClientRect();
        input.style.setProperty("height", `${rect.height}px`);
        input.style.setProperty("left", `${rect.left}px`);
        input.style.setProperty("top", `${rect.top}px`);
        input.style.setProperty("width", `${rect.width}px`);
      });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [liveTableCellForEdit, tableCellEditIdentity]);

  const beginTableCellEdit = useCallback((target: EventTarget | null) => {
    if (descriptor.type !== "block" || descriptor.block.kind !== "table") return false;
    const element = target instanceof Element
      ? target.closest<HTMLTableCellElement>(
        "th[data-markdown-source-start][data-markdown-source-end], td[data-markdown-source-start][data-markdown-source-end]",
      )
      : null;
    if (!element || !keyboardScopeRef.current?.contains(element)) return false;
    const rawFrom = Number(element.dataset.markdownSourceStart);
    const rawTo = Number(element.dataset.markdownSourceEnd);
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo) || rawTo < rawFrom) return false;
    const raw = readSourceRange(rawFrom, rawTo);
    const { from, to } = markdownTableCellContentRange(raw, rawFrom);
    const rowElement = element.parentElement;
    const tableElement = element.closest("table");
    const rows = tableElement ? Array.from(tableElement.rows) : [];
    const rect = element.getBoundingClientRect();
    setTableCellEdit({
      column: element.cellIndex + 1,
      element,
      from,
      height: rect.height,
      left: rect.left,
      row: rowElement instanceof HTMLTableRowElement ? rows.indexOf(rowElement) + 1 : 1,
      sourceFrom: rawFrom,
      top: rect.top,
      to,
      value: readSourceRange(from, to),
      width: rect.width,
    });
    return true;
  }, [descriptor, readSourceRange]);

  useEffect(() => {
    const scope = keyboardScopeRef.current;
    if (!scope) return;
    for (const token of scope.querySelectorAll<HTMLElement>(
      "[data-skill-token='true']:not(a)",
    )) {
      token.tabIndex = 0;
      token.setAttribute("role", "link");
    }
    if (descriptor.type === "block" && descriptor.block.kind === "table") {
      for (const cell of scope.querySelectorAll<HTMLTableCellElement>(
        "th[data-markdown-source-start], td[data-markdown-source-start]",
      )) {
        cell.tabIndex = 0;
      }
    }
    const handleTableCellEdit = (event: Event) => {
      beginTableCellEdit(event.target);
    };
    scope.addEventListener("rudder:markdown-table-cell-edit", handleTableCellEdit);
    return () => scope.removeEventListener("rudder:markdown-table-cell-edit", handleTableCellEdit);
  }, [beginTableCellEdit, descriptor]);

  const finishTableCellEdit = (direction: -1 | 0 | 1, inputValue?: string) => {
    const current = tableCellEdit;
    if (!current) return;
    const currentElement = liveTableCellForEdit(current) ?? current.element;
    const cells = Array.from(
      currentElement.closest("table")?.querySelectorAll<HTMLTableCellElement>(
        "th[data-markdown-source-start], td[data-markdown-source-start]",
      ) ?? [],
    );
    const currentIndex = cells.indexOf(currentElement);
    const nextCell = direction === 0 ? null : cells[currentIndex + direction] ?? null;
    const nextSourceStart = Number(nextCell?.dataset.markdownSourceStart);
    const value = escapeMarkdownTableCellPipes(
      (inputValue ?? current.value).replace(/[\r\n]+/gu, " "),
    );
    const changeDelta = value.length - (current.to - current.from);
    onTableCellCommit({
      from: current.from,
      nextCellFrom: Number.isFinite(nextSourceStart)
        ? nextSourceStart + (nextSourceStart > current.to ? changeDelta : 0)
        : null,
      to: current.to,
      value,
    });
    setTableCellEdit(null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (
      event.key === "Enter"
      && beginTableCellEdit(event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      event.key !== "Enter"
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    const tokenElement = target?.closest<HTMLElement>("[data-skill-token='true']");
    if (!tokenElement || tokenElement.closest("a")) return;
    const reference = descriptor.type === "block"
      ? sourceReferenceForTarget(descriptor.block, tokenElement)
      : descriptor.reference;
    if (!reference) return;
    emitInlineTokenClick(
      propsRef.current,
      reference,
      tokenElement,
      event.nativeEvent,
    );
  };

  return (
    <span
      ref={keyboardScopeRef}
      className="contents"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (!beginTableCellEdit(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <MarkdownBody
        className={cn(
          "rudder-codemirror-markdown-rendered",
          descriptor.type === "atomic" && "rudder-codemirror-markdown-rendered--atomic",
        )}
        onLinkClick={portalLinkClickHandler(descriptor)}
        skillReferences={skillReferences}
        copyMarkdownOnCopy
        enableCodeBlockCopy
        sourceOffsetBase={descriptor.type === "block" ? descriptor.block.from : descriptor.reference.from}
      >
        {descriptor.type === "block"
          ? descriptor.previewMarkdown
          : descriptor.reference.markdown}
      </MarkdownBody>
      {tableCellEdit ? createPortal(
        <input
          ref={tableCellInputRef}
          type="text"
          value={tableCellEdit.value}
          aria-label={`Edit table cell row ${tableCellEdit.row} column ${tableCellEdit.column}`}
          data-testid="markdown-table-cell-editor"
          className="rudder-markdown-table-cell-editor"
          style={{
            height: tableCellEdit.height,
            left: tableCellEdit.left,
            top: tableCellEdit.top,
            width: tableCellEdit.width,
          }}
          onBlur={(event) => finishTableCellEdit(0, event.currentTarget.value)}
          onChange={(event) => {
            const value = event.target.value;
            setTableCellEdit((current) => current ? { ...current, value } : current);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              const cell = liveTableCellForEdit(tableCellEdit) ?? tableCellEdit.element;
              setTableCellEdit(null);
              requestAnimationFrame(() => cell.focus());
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              finishTableCellEdit(0, event.currentTarget.value);
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              finishTableCellEdit(event.shiftKey ? -1 : 1, event.currentTarget.value);
            }
          }}
          onMouseDown={(event) => event.stopPropagation()}
        />,
        document.body,
      ) : null}
    </span>
  );
}

function PortalWebsiteIcon({
  descriptor,
}: {
  descriptor: Extract<PortalDescriptor, { type: "website" }>;
}) {
  let url: URL;
  try {
    url = new URL(descriptor.link.href);
  } catch {
    return null;
  }
  return <WebsiteLinkIcon url={url} />;
}

const CodeMirrorMarkdownEditorInstance = forwardRef<
  MarkdownEditorRef,
  CodeMirrorMarkdownEditorProps
>(function CodeMirrorMarkdownEditor(props, forwardedRef) {
  const {
    value,
    onChange,
    ariaLabel,
    placeholder,
    className,
    contentClassName,
    bordered = true,
  } = props;
  const editorAriaLabel = ariaLabel ?? (placeholder ? `${placeholder} Markdown editor` : "Markdown editor");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  const currentValueRef = useRef(value);
  const pendingTitlesRef = useRef(new Map<number, PendingTitleUpgrade>());
  const pendingImageUploadsRef = useRef(new Map<number, PendingImageUpload>());
  const pendingTableCellFocusRef = useRef<number | null>(null);
  const [tableCellFocusRequest, setTableCellFocusRequest] = useState(0);
  const imageUploadRequestIdRef = useRef(0);
  const titleRequestIdRef = useRef(0);
  const mentionStateRef = useRef<CodeMirrorMentionState | null>(null);
  const compositionActiveRef = useRef(false);
  const dismissedMentionStateRef = useRef<CodeMirrorMentionState | null>(null);
  const mentionIndexRef = useRef(0);
  const filteredMentionsRef = useRef<MentionOption[]>([]);
  const selectMentionRef = useRef<(option: MentionOption) => void>(() => undefined);
  const setPreviewFocusRef = useRef<((view: EditorView, focused: boolean) => void) | null>(null);
  const lineSeparatorCompartmentRef = useRef<Compartment | null>(null);
  const readOnlyCompartmentRef = useRef<Compartment | null>(null);
  const lineSeparatorRef = useRef(sourceLineSeparator(value));
  const mountedRef = useRef(false);
  const markdownBlockHoverRef = useRef<MarkdownBlockHoverState | null>(null);
  const markdownBlockHoverElementRef = useRef<HTMLElement | null>(null);
  const markdownBlockHoverOverlayRef = useRef<HTMLDivElement | null>(null);
  const markdownBlockRefreshFrameRef = useRef<number | null>(null);
  const markdownBlockCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [portals, setPortals] = useState<PortalDescriptor[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mentionState, setMentionState] = useState<CodeMirrorMentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [markdownBlockHover, setMarkdownBlockHover] = useState<MarkdownBlockHoverState | null>(null);
  const [markdownBlockMenuOpen, setMarkdownBlockMenuOpen] = useState(false);
  const mentionListboxId = `markdown-reference-suggestions-${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;
  propsRef.current = props;

  const registerPortal = useCallback((registration: PortalRegistration, host: HTMLElement) => {
    if (!mountedRef.current) return;
    setPortals((current) => {
      const existing = current.find((portal) => portal.key === registration.key && portal.host === host);
      if (existing) return current;
      return [
        ...current.filter((portal) => portal.key !== registration.key),
        { ...registration, host } as PortalDescriptor,
      ];
    });
  }, []);

  const unregisterPortal = useCallback((key: string, host: HTMLElement) => {
    if (!mountedRef.current) return;
    setPortals((current) => current.filter((portal) => portal.key !== key || portal.host !== host));
  }, []);

  const clearMarkdownBlockCloseTimeout = useCallback(() => {
    if (markdownBlockCloseTimeoutRef.current === null) return;
    clearTimeout(markdownBlockCloseTimeoutRef.current);
    markdownBlockCloseTimeoutRef.current = null;
  }, []);

  const closeMarkdownBlockHover = useCallback(() => {
    clearMarkdownBlockCloseTimeout();
    markdownBlockHoverRef.current = null;
    markdownBlockHoverElementRef.current = null;
    setMarkdownBlockMenuOpen(false);
    setMarkdownBlockHover(null);
  }, [clearMarkdownBlockCloseTimeout]);

  const scheduleMarkdownBlockClose = useCallback(() => {
    clearMarkdownBlockCloseTimeout();
    markdownBlockCloseTimeoutRef.current = setTimeout(() => {
      markdownBlockCloseTimeoutRef.current = null;
      closeMarkdownBlockHover();
    }, 160);
  }, [clearMarkdownBlockCloseTimeout, closeMarkdownBlockHover]);

  const keepMarkdownBlockOpen = useCallback(() => {
    clearMarkdownBlockCloseTimeout();
  }, [clearMarkdownBlockCloseTimeout]);

  const openMarkdownBlockMenu = useCallback(() => {
    clearMarkdownBlockCloseTimeout();
    setMarkdownBlockMenuOpen(true);
  }, [clearMarkdownBlockCloseTimeout]);

  const updateMarkdownBlockHover = useCallback((element: HTMLElement, lineNumber: number, sourceFrom: number) => {
    const rect = element.getBoundingClientRect();
    const anchorOffset = Math.min(16, Math.max(0, (Math.min(rect.height, 64) - 32) / 2));
    const nextHover = {
      line: lineNumber,
      sourceFrom,
      top: Math.max(8, rect.top + anchorOffset),
      left: Math.max(8, rect.left - 40),
    };
    keepMarkdownBlockOpen();
    markdownBlockHoverElementRef.current = element;
    const previous = markdownBlockHoverRef.current;
    if (
      previous?.line === nextHover.line
      && previous.sourceFrom === nextHover.sourceFrom
    ) {
      markdownBlockHoverRef.current = nextHover;
      if (previous.top !== nextHover.top || previous.left !== nextHover.left) {
        markdownBlockHoverOverlayRef.current?.style.setProperty(
          "transform",
          `translate3d(${nextHover.left}px, ${nextHover.top}px, 0)`,
        );
      }
      return;
    }
    markdownBlockHoverRef.current = nextHover;
    setMarkdownBlockHover(nextHover);
  }, [keepMarkdownBlockOpen]);

  const handleMarkdownEditorMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const view = viewRef.current;
    if (!target || !view) return;
    const renderedBlock = target.closest<HTMLElement>([
      "th[data-markdown-source-start]",
      "td[data-markdown-source-start]",
      "p[data-markdown-source-start]",
      "h1[data-markdown-source-start]",
      "h2[data-markdown-source-start]",
      "h3[data-markdown-source-start]",
      "h4[data-markdown-source-start]",
      "h5[data-markdown-source-start]",
      "h6[data-markdown-source-start]",
      "li[data-markdown-source-start]",
      "pre[data-markdown-source-start]",
      "table[data-markdown-source-start]",
    ].join(", "));
    const sourceFrom = Number(renderedBlock?.dataset.markdownSourceStart);
    if (
      renderedBlock
      && rootRef.current?.contains(renderedBlock)
      && Number.isFinite(sourceFrom)
    ) {
      const lineNumber = view.state.doc.lineAt(
        Math.max(0, Math.min(view.state.doc.length, sourceFrom)),
      ).number;
      updateMarkdownBlockHover(renderedBlock, lineNumber, sourceFrom);
      return;
    }
    const line = target?.closest<HTMLElement>(
      ".cm-line[data-source-line-start]",
    );
    const parsedLine = Number(line?.dataset.sourceLineStart);
    if (!line || !Number.isFinite(parsedLine)) return;
    const lineNumber = Math.max(1, Math.min(view.state.doc.lines, parsedLine));
    updateMarkdownBlockHover(line, lineNumber, view.state.doc.line(lineNumber).from);
  }, [updateMarkdownBlockHover]);

  const refreshMarkdownBlockHover = useCallback(() => {
    const current = markdownBlockHoverRef.current;
    const view = viewRef.current;
    if (!current || !view) return;
    const renderedElement = markdownBlockHoverElementRef.current;
    if (renderedElement?.isConnected) {
      updateMarkdownBlockHover(renderedElement, current.line, current.sourceFrom);
      return;
    }
    const line = view.contentDOM.querySelector<HTMLElement>(`.cm-line[data-source-line-start="${current.line}"]`);
    if (line) updateMarkdownBlockHover(line, current.line, current.sourceFrom);
  }, [updateMarkdownBlockHover]);

  const scheduleMarkdownBlockHoverRefresh = useCallback(() => {
    if (markdownBlockRefreshFrameRef.current !== null) return;
    markdownBlockRefreshFrameRef.current = requestAnimationFrame(() => {
      markdownBlockRefreshFrameRef.current = null;
      refreshMarkdownBlockHover();
    });
  }, [refreshMarkdownBlockHover]);

  useEffect(() => {
    if (!markdownBlockHover) return;
    window.addEventListener("resize", scheduleMarkdownBlockHoverRefresh);
    window.addEventListener("scroll", scheduleMarkdownBlockHoverRefresh, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", scheduleMarkdownBlockHoverRefresh);
      window.removeEventListener("scroll", scheduleMarkdownBlockHoverRefresh, true);
      if (markdownBlockRefreshFrameRef.current !== null) {
        cancelAnimationFrame(markdownBlockRefreshFrameRef.current);
        markdownBlockRefreshFrameRef.current = null;
      }
    };
  }, [markdownBlockHover, scheduleMarkdownBlockHoverRefresh]);

  const markdownBlockTarget = (() => {
    if (!markdownBlockHover || !viewRef.current) return null;
    return markdownBlockForLine(
      sourceMarkdown(viewRef.current.state),
      markdownBlockHover.line,
    );
  })();

  const handleMarkdownBlockAction = useCallback((action: MarkdownBlockAction) => {
    if (propsRef.current.readOnly) return;
    const view = viewRef.current;
    const hover = markdownBlockHoverRef.current;
    if (!view || !hover) return;
    const block = markdownBlockForLine(sourceMarkdown(view.state), hover.line);
    if (!block || markdownBlockActionDisabled(block.markdown, action, block.kind)) return;
    const replacement = applyMarkdownBlockAction(block.markdown, action, block.kind);
    if (replacement === block.markdown) return;
    view.dispatch({
      changes: { from: block.from, to: block.to, insert: replacement },
      selection: { anchor: block.from + replacement.length },
      userEvent: "input.format",
    });
    view.focus();
    setPreviewFocusRef.current?.(view, true);
    closeMarkdownBlockHover();
  }, [closeMarkdownBlockHover]);

  const readSourceRange = useCallback((from: number, to: number) => {
    const view = viewRef.current;
    if (!view) return "";
    const safeFrom = Math.max(0, Math.min(view.state.doc.length, from));
    const safeTo = Math.max(safeFrom, Math.min(view.state.doc.length, to));
    return view.state.sliceDoc(safeFrom, safeTo);
  }, []);

  const handleTableCellCommit = useCallback((commit: MarkdownTableCellCommit) => {
    if (propsRef.current.readOnly) return;
    const view = viewRef.current;
    if (!view) return;
    const from = Math.max(0, Math.min(view.state.doc.length, commit.from));
    const to = Math.max(from, Math.min(view.state.doc.length, commit.to));
    pendingTableCellFocusRef.current = commit.nextCellFrom;
    if (commit.nextCellFrom !== null) {
      setTableCellFocusRequest((current) => current + 1);
    }
    view.dispatch({
      changes: { from, to, insert: commit.value },
      userEvent: "input",
    });
  }, []);

  useEffect(() => {
    const sourceFrom = pendingTableCellFocusRef.current;
    if (sourceFrom === null) return;
    let frame: number | null = null;
    let attempts = 0;
    const focusPendingCell = () => {
      const cell = rootRef.current?.querySelector<HTMLTableCellElement>(
        `th[data-markdown-source-start="${sourceFrom}"], td[data-markdown-source-start="${sourceFrom}"]`,
      );
      if (!cell && attempts < 3) {
        attempts += 1;
        frame = requestAnimationFrame(focusPendingCell);
        return;
      }
      if (!cell) return;
      pendingTableCellFocusRef.current = null;
      cell.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    };
    frame = requestAnimationFrame(focusPendingCell);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [portals, tableCellFocusRequest]);

  const filteredMentions = useMemo(() => {
    if (!mentionState) return [];
    return filterMentionOptions(
      props.mentions,
      mentionState.trigger,
      mentionState.query,
    );
  }, [mentionState, props.mentions]);
  filteredMentionsRef.current = filteredMentions;
  const skillReferences = useMemo<MarkdownSkillReferencePreview[]>(() => (
    (props.mentions ?? []).flatMap((option) => {
      if (
        option.kind !== "skill"
        || !option.skillMarkdownTarget
      ) {
        return [];
      }
      return [{
        href: option.skillMarkdownTarget,
        label: option.skillRefLabel,
        displayName: option.skillDisplayName ?? option.name,
        description: option.skillDescription,
        categoryLabel: option.skillCategoryLabel,
        locationLabel: option.skillLocationLabel,
        detailsHref: option.skillDetailsHref,
      }];
    })
  ), [props.mentions]);

  const setActiveMentionIndex = useCallback((nextIndex: number) => {
    mentionIndexRef.current = nextIndex;
    setMentionIndex(nextIndex);
  }, []);

  const updateMentionState = useCallback((view: EditorView) => {
    if (compositionActiveRef.current || view.composing) return;
    const candidateState = view.hasFocus ? mentionStateAtSelection(view) : null;
    const dismissedState = dismissedMentionStateRef.current;
    const nextState = dismissedState && sameMentionState(dismissedState, candidateState)
      ? null
      : candidateState;
    if (!sameMentionState(dismissedState, candidateState)) {
      dismissedMentionStateRef.current = null;
    }
    if (sameMentionState(mentionStateRef.current, nextState)) return;
    const previous = mentionStateRef.current;
    mentionStateRef.current = nextState;
    setMentionState(nextState);
    if (
      !nextState
      || !previous
      || previous.trigger !== nextState.trigger
      || previous.query !== nextState.query
      || previous.from !== nextState.from
    ) {
      setActiveMentionIndex(0);
    }
  }, [setActiveMentionIndex]);

  const selectMention = useCallback((option: MentionOption) => {
    if (propsRef.current.readOnly) return;
    const view = viewRef.current;
    const state = mentionStateRef.current;
    if (!view || !state) return;
    if (
      view.state.sliceDoc(state.from, state.to)
      !== `${state.trigger}${state.query}`
    ) {
      updateMentionState(view);
      return;
    }
    const insert = markdownMentionCompletion(
      option,
      propsRef.current.agentMentionIntent,
    );
    if (!insert) return;
    mentionStateRef.current = null;
    setMentionState(null);
    view.dispatch({
      changes: { from: state.from, to: state.to, insert },
      selection: { anchor: state.from + insert.length },
      userEvent: "input.complete",
    });
    view.focus();
  }, [updateMentionState]);
  selectMentionRef.current = selectMention;

  useEffect(() => {
    props.onMentionQueryChange?.(
      mentionState?.trigger === "@" ? mentionState.query : null,
    );
  }, [mentionState?.query, mentionState?.trigger, props.onMentionQueryChange]);

  useEffect(() => {
    if (filteredMentions.length === 0) {
      if (mentionIndexRef.current !== 0) setActiveMentionIndex(0);
      return;
    }
    if (mentionIndexRef.current >= filteredMentions.length) {
      setActiveMentionIndex(filteredMentions.length - 1);
    }
  }, [filteredMentions.length, setActiveMentionIndex]);

  useEffect(() => {
    if (!mentionState) return;
    const reposition = () => {
      const view = viewRef.current;
      if (view) updateMentionState(view);
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [mentionState, updateMentionState]);

  const mentionMenuPosition = useMemo<CSSProperties | null>(() => {
    if (!mentionState || typeof window === "undefined") return null;
    if (props.mentionMenuPlacement === "container") {
      const anchor = props.mentionMenuAnchorRef?.current ?? rootRef.current;
      const rect = anchor?.getBoundingClientRect();
      if (rect) {
        return getMentionPanelPositionForViewport(
          {
            viewportTop: rect.top,
            viewportBottom: rect.bottom,
            viewportLeft: rect.left,
            viewportRight: rect.right,
          },
          window.innerWidth,
          window.innerHeight,
          { maxWidth: 520 },
        );
      }
    }
    const editorRect = rootRef.current?.getBoundingClientRect();
    return getMentionMenuPositionForViewport(
      mentionState,
      window.innerWidth,
      window.innerHeight,
      {
        ...(props.mentionMenuSize === "compact"
          ? { width: 320, maxHeight: 180 }
          : {}),
        boundaryBottom: editorRect?.bottom,
      },
    );
  }, [
    mentionState,
    props.mentionMenuAnchorRef,
    props.mentionMenuPlacement,
    props.mentionMenuSize,
  ]);
  const mentionMenuOpen = Boolean(
    mentionState && filteredMentions.length > 0 && mentionMenuPosition,
  );
  useEffect(() => {
    const content = viewRef.current?.contentDOM;
    if (!content) return;
    content.setAttribute("aria-expanded", String(mentionMenuOpen));
    if (!mentionMenuOpen) {
      content.removeAttribute("aria-controls");
      content.removeAttribute("aria-activedescendant");
      return;
    }
    content.setAttribute("aria-controls", mentionListboxId);
    content.setAttribute(
      "aria-activedescendant",
      `${mentionListboxId}-option-${mentionIndex}`,
    );
  }, [mentionIndex, mentionListboxId, mentionMenuOpen]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      setPreviewFocusRef.current?.(view, true);
    },
    insertTextAtSelection: (text: string) => {
      const view = viewRef.current;
      if (!view || propsRef.current.readOnly) return false;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
      setPreviewFocusRef.current?.(view, true);
      return true;
    },
    getMarkdown: () => {
      const view = viewRef.current;
      return view ? sourceMarkdown(view.state) : currentValueRef.current;
    },
    undo: () => {
      const view = viewRef.current;
      return view && !propsRef.current.readOnly ? undo(view) : false;
    },
    redo: () => {
      const view = viewRef.current;
      return view && !propsRef.current.readOnly ? redo(view) : false;
    },
    canUndo: () => {
      const view = viewRef.current;
      return Boolean(view && undoDepth(view.state) > 0);
    },
    canRedo: () => {
      const view = viewRef.current;
      return Boolean(view && redoDepth(view.state) > 0);
    },
    revealLine: (sourceLine: number) => {
      const view = viewRef.current;
      if (!view) return;
      const lineNumber = Math.max(1, Math.min(view.state.doc.lines, sourceLine));
      const position = view.state.doc.line(lineNumber).from;
      const documentBeforeReveal = view.state.doc;
      const selectionBeforeReveal = view.state.selection;
      view.focus();
      view.dispatch({
        selection: EditorSelection.cursor(position),
        effects: EditorView.scrollIntoView(position, { y: "start" }),
      });
      setPreviewFocusRef.current?.(view, true);
      requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        if (
          view.state.doc === documentBeforeReveal
          && view.state.selection.eq(selectionBeforeReveal)
        ) {
          view.dispatch({ selection: EditorSelection.cursor(position) });
        }
        requestAnimationFrame(() => {
          if (viewRef.current !== view) return;
          alignMarkdownSourceLine(view, lineNumber);
        });
      });
    },
  }), []);

  useEffect(() => {
    mountedRef.current = true;
    const parent = mountRef.current;
    const rootElement = rootRef.current;
    if (!parent || !rootElement) return;

    const registry: PortalRegistry = {
      register: registerPortal,
      unregister: unregisterPortal,
    };
    const setPreviewFocus = StateEffect.define<boolean>();
    const setPreviewComposition = StateEffect.define<boolean>();
    const setPreviewPointerSelection = StateEffect.define<boolean>();
    const lineSeparatorCompartment = new Compartment();
    lineSeparatorCompartmentRef.current = lineSeparatorCompartment;
    const readOnlyCompartment = new Compartment();
    readOnlyCompartmentRef.current = readOnlyCompartment;
    setPreviewFocusRef.current = (view, focused) => {
      view.dispatch({ effects: setPreviewFocus.of(focused) });
    };
    const activateBlock = (block: MarkdownPreviewBlock, view: EditorView) => {
      if (propsRef.current.readOnly) return;
      view.focus();
      view.dispatch({
        selection: EditorSelection.cursor(block.from),
        effects: EditorView.scrollIntoView(block.from, { y: "nearest" }),
      });
      view.dispatch({ effects: setPreviewFocus.of(true) });
    };

    type PreviewFieldValue = {
      decorations: DecorationSet;
      atomic: DecorationSet;
      document: MarkdownPreviewDocument;
      focused: boolean;
      composing: boolean;
      compositionRanges: Array<{ from: number; to: number }> | null;
      pointerSelecting: boolean;
    };
    const previewField = StateField.define<PreviewFieldValue>({
      create(state) {
        const document = getMarkdownPreviewDocument(state.doc.toString());
        const result = markdownPreviewDecorations(
          state,
          document,
          false,
          registry,
          propsRef,
          activateBlock,
        );
        return {
          ...result,
          document,
          focused: false,
          composing: false,
          compositionRanges: null,
          pointerSelecting: false,
        };
      },
      update(current, transaction) {
        let focused = current.focused;
        let composing = current.composing;
        let compositionRanges = current.compositionRanges;
        const wasComposing = current.composing;
        let pointerSelecting = current.pointerSelecting;
        let effectChanged = false;
        for (const effect of transaction.effects) {
          if (effect.is(setPreviewFocus)) {
            focused = effect.value;
            effectChanged = true;
          }
          if (effect.is(setPreviewComposition)) {
            composing = effect.value;
            compositionRanges = effect.value
              ? activeSelectionRanges(transaction.startState)
              : null;
            effectChanged = true;
          }
          if (effect.is(setPreviewPointerSelection)) {
            pointerSelecting = effect.value;
            effectChanged = true;
          }
        }

        if (composing) {
          const mappedCompositionRanges = (
            compositionRanges ?? activeSelectionRanges(transaction.startState)
          ).map((range) => ({
            from: transaction.changes.mapPos(range.from, -1),
            to: transaction.changes.mapPos(range.to, 1),
          }));
          const document = previewDocumentForTransaction(
            current.document,
            transaction,
          );
          const result = markdownPreviewDecorations(
            transaction.state,
            document,
            true,
            registry,
            propsRef,
            activateBlock,
            mappedCompositionRanges,
          );
          return {
            ...result,
            document,
            focused,
            composing,
            compositionRanges: mappedCompositionRanges,
            pointerSelecting,
          };
        }

        if (pointerSelecting && !transaction.docChanged) {
          return {
            decorations: current.decorations.map(transaction.changes),
            atomic: current.atomic.map(transaction.changes),
            document: current.document,
            focused,
            composing,
            compositionRanges,
            pointerSelecting,
          };
        }

        const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
        if (!transaction.docChanged && !selectionChanged && !effectChanged) {
          return current;
        }
        const document = wasComposing && !composing
          ? getMarkdownPreviewDocument(transaction.state.doc.toString())
          : previewDocumentForTransaction(
            current.document,
            transaction,
          );
        const result = markdownPreviewDecorations(
          transaction.state,
          document,
          focused,
          registry,
          propsRef,
          activateBlock,
        );
        return {
          ...result,
          document,
          focused,
          composing,
          compositionRanges,
          pointerSelecting,
        };
      },
      provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
    });

    const handleImageUploads = async (files: File[], view: EditorView, from: number, to: number) => {
      if (propsRef.current.readOnly) return;
      const upload = propsRef.current.imageUploadHandler;
      if (!upload || files.length === 0) return;
      const requestId = ++imageUploadRequestIdRef.current;
      pendingImageUploadsRef.current.set(requestId, {
        from,
        to,
        empty: from === to,
        expectedSource: view.state.sliceDoc(from, to),
      });
      setUploadError(null);
      const results = await Promise.allSettled(files.map((file) => upload(file)));
      const pending = pendingImageUploadsRef.current.get(requestId);
      pendingImageUploadsRef.current.delete(requestId);
      if (
        !pending
        || propsRef.current.readOnly
        || viewRef.current !== view
        || view.state.sliceDoc(pending.from, pending.to) !== pending.expectedSource
      ) {
        return;
      }
      const uploaded = results.flatMap((result, index) => (
        result.status === "fulfilled"
          ? [markdownImageForUpload(files[index]!, result.value)]
          : []
      ));
      const failureCount = results.length - uploaded.length;
      if (uploaded.length > 0) {
        const markdownImages = uploaded.join("\n");
        view.dispatch({
          changes: { from: pending.from, to: pending.to, insert: markdownImages },
          selection: { anchor: pending.from + markdownImages.length },
          userEvent: "input.paste",
        });
      }
      if (failureCount > 0) {
        const firstFailure = results.find((result) => result.status === "rejected");
        const reason = firstFailure?.status === "rejected" && firstFailure.reason instanceof Error
          ? ` ${firstFailure.reason.message}`
          : "";
        setUploadError(`${failureCount} of ${files.length} images failed to upload.${reason}`);
      }
    };

    const handleSmartPaste = (event: ClipboardEvent, view: EditorView) => {
      if (propsRef.current.readOnly) {
        event.preventDefault();
        return true;
      }
      const imageFiles = clipboardImageFiles(event.clipboardData);
      if (imageFiles.length > 0 && propsRef.current.imageUploadHandler) {
        event.preventDefault();
        const range = view.state.selection.main;
        void handleImageUploads(imageFiles, view, range.from, range.to);
        return true;
      }

      const url = readSingleHttpUrl(event.clipboardData?.getData("text/plain") ?? "");
      if (!url || view.state.selection.ranges.length !== 1) return false;
      const range = view.state.selection.main;
      if (isSmartPasteExcluded(view.state, range.from, range.to)) return false;

      event.preventDefault();
      const selected = view.state.sliceDoc(range.from, range.to);
      const label = selected || provisionalWebsiteLabel(url);
      const link = buildMarkdownLink(label, url);
      const historyTime = Date.now();
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: link },
        selection: { anchor: range.from + link.length },
        annotations: Transaction.time.of(historyTime),
        userEvent: "input.type.paste",
      });

      if (selected) return true;
      const requestId = ++titleRequestIdRef.current;
      pendingTitlesRef.current.set(requestId, {
        requestId,
        historyTime,
        documentIdentity: propsRef.current.documentIdentity,
        from: range.from,
        to: range.from + link.length,
        labelFrom: range.from + 1,
        labelTo: range.from + 1 + escapeMarkdownLinkLabel(label).length,
        url,
        provisionalMarkdown: link,
      });
      void Promise.resolve(getWebsiteMetadata(url, "authoring"))
        .then((metadata) => {
          const pending = pendingTitlesRef.current.get(requestId);
          pendingTitlesRef.current.delete(requestId);
          const currentView = viewRef.current;
          const title = metadata?.pageTitle?.trim();
          if (
            !pending
            || pending.requestId !== requestId
            || pending.url !== url
            || pending.documentIdentity !== propsRef.current.documentIdentity
            || !currentView
            || currentView !== view
            || !title
          ) {
            return;
          }
          if (
            currentView.state.sliceDoc(pending.from, pending.to)
            !== pending.provisionalMarkdown
          ) {
            return;
          }
          const escapedTitle = escapeMarkdownLinkLabel(title);
          if (
            currentView.state.sliceDoc(pending.labelFrom, pending.labelTo)
            === escapedTitle
          ) {
            return;
          }
          currentView.dispatch({
            changes: {
              from: pending.labelFrom,
              to: pending.labelTo,
              insert: escapedTitle,
            },
            annotations: [
              titleUpgradeTransaction.of(true),
              Transaction.time.of(pending.historyTime),
            ],
            userEvent: "input.type.paste",
          });
        })
        .catch(() => {
          pendingTitlesRef.current.delete(requestId);
        });
      return true;
    };

    const deleteAtomic = (view: EditorView, direction: "backward" | "forward") => {
      const reference = adjacentAtomicReference(view.state, direction);
      if (!reference) return false;
      view.dispatch({
        changes: { from: reference.from, to: reference.to, insert: "" },
        selection: { anchor: reference.from },
        userEvent: "delete",
      });
      return true;
    };

    const extensions: Extension[] = [
      basicSetup,
      history({
        joinToEvent: (transaction) => (
          transaction.annotation(titleUpgradeTransaction) === true
        ),
      }),
      markdown({ extensions: GFM }),
      codeMirrorMarkdownEditorTheme(),
      syntaxHighlighting(codeMirrorMarkdownHighlightStyle),
      EditorView.lineWrapping,
      previewField,
      lineSeparatorCompartment.of(
        EditorState.lineSeparator.of(lineSeparatorRef.current),
      ),
      readOnlyCompartment.of([
        EditorState.readOnly.of(Boolean(propsRef.current.readOnly)),
        EditorView.editable.of(!propsRef.current.readOnly),
      ]),
      EditorView.atomicRanges.of((view) => (
        view.state.field(previewField).atomic
      )),
      Prec.highest(EditorView.domEventHandlers({
        keydown: (event, view) => {
          const target = event.target instanceof HTMLElement ? event.target : null;
          const focusedLink = target?.closest<HTMLElement>("[data-markdown-link-href]");
          const focusedHref = focusedLink?.dataset.markdownLinkHref;
          if (
            event.key === "Enter"
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && !event.shiftKey
            && focusedHref
          ) {
            event.preventDefault();
            event.stopPropagation();
            openDecoratedMarkdownLink(focusedHref);
            return true;
          }
          if (!mentionStateRef.current) return false;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            dismissedMentionStateRef.current = mentionStateRef.current;
            mentionStateRef.current = null;
            setMentionState(null);
            return true;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            const option = !event.shiftKey
              ? filteredMentionsRef.current[mentionIndexRef.current]
              : undefined;
            if (option) {
              selectMentionRef.current(option);
              return true;
            }
            dismissedMentionStateRef.current = mentionStateRef.current;
            mentionStateRef.current = null;
            setMentionState(null);
            requestAnimationFrame(() => {
              focusAdjacentEditorControl(view.contentDOM, event.shiftKey);
            });
            return true;
          }
          return false;
        },
        mousedown: (event, view) => {
          const pointerTarget = event.target instanceof Element ? event.target : null;
          if (
            event.button === 0
            && (event.metaKey || event.ctrlKey)
            && pointerTarget?.closest("[data-markdown-link-href]")
          ) {
            event.preventDefault();
            return true;
          }
          if (!isPrimaryPlainMouseEvent(event)) return false;
          const target = pointerTarget;
          if (
            target?.closest(
              "[data-markdown-atomic-reference='true'], [data-markdown-website-icon='true']",
            )
          ) {
            return false;
          }
          // Let the image preview trigger receive the click. Activating the
          // source line first would replace the image before InspectableImage
          // can open the global preview dialog.
          if (target?.closest(".rudder-inspectable-image-trigger")) {
            event.preventDefault();
            return true;
          }
          const previewLine = target?.closest<HTMLElement>(
            ".cm-line[data-markdown-preview-state='preview'][data-source-line-start]",
          );
          if (!previewLine) return false;

          const sourceLine = Number(previewLine.dataset.sourceLineStart);
          const fallbackPosition = Number.isFinite(sourceLine)
            ? view.state.doc.line(
              Math.max(1, Math.min(view.state.doc.lines, sourceLine)),
            ).from
            : view.state.selection.main.head;
          const anchor = markdownPointerPosition(view, event) ?? fallbackPosition;
          event.preventDefault();
          view.focus();
          view.dispatch({
            selection: EditorSelection.cursor(anchor),
            effects: setPreviewPointerSelection.of(true),
          });

          const extendPointerSelection = (pointerEvent: MouseEvent) => {
            if ((pointerEvent.buttons & 1) === 0 || viewRef.current !== view) return;
            const head = markdownPointerPosition(view, pointerEvent);
            if (head == null) return;
            view.dispatch({
              selection: EditorSelection.range(anchor, head),
            });
          };
          const finishPointerSelection = (pointerEvent: MouseEvent) => {
            window.removeEventListener("mousemove", extendPointerSelection);
            if (viewRef.current !== view) return;
            const head = markdownPointerPosition(view, pointerEvent) ?? anchor;
            view.dispatch({
              selection: EditorSelection.range(anchor, head),
              effects: setPreviewPointerSelection.of(false),
            });
          };
          window.addEventListener("mousemove", extendPointerSelection);
          window.addEventListener("mouseup", finishPointerSelection, {
            once: true,
          });
          return true;
        },
        click: (event) => {
          if (
            event.button !== 0
            || (!event.metaKey && !event.ctrlKey)
          ) {
            return false;
          }
          const target = event.target instanceof HTMLElement ? event.target : null;
          const link = target?.closest<HTMLElement>("[data-markdown-link-href]");
          const href = link?.dataset.markdownLinkHref;
          if (!href) return false;
          event.preventDefault();
          event.stopPropagation();
          openDecoratedMarkdownLink(href);
          return true;
        },
      })),
      Prec.highest(keymap.of([
        {
          key: "Tab",
          run: (view) => {
            const option = filteredMentionsRef.current[mentionIndexRef.current];
            if (mentionStateRef.current && option) {
              selectMentionRef.current(option);
              return true;
            }
            return !mentionStateRef.current
              && selectionIsOnMarkdownListItem(view)
              && indentMore(view);
          },
        },
        {
          key: "Shift-Tab",
          run: (view) => (
            !mentionStateRef.current
            && selectionIsOnMarkdownListItem(view)
            && indentLess(view)
          ),
        },
        {
          key: "ArrowDown",
          run: (view) => {
            const options = filteredMentionsRef.current;
            if (mentionStateRef.current && options.length > 0) {
              setActiveMentionIndex(
                (mentionIndexRef.current + 1) % options.length,
              );
              return true;
            }
            return moveMarkdownCursorVertically(view, true);
          },
        },
        {
          key: "ArrowUp",
          run: (view) => {
            const options = filteredMentionsRef.current;
            if (mentionStateRef.current && options.length > 0) {
              setActiveMentionIndex(
                (mentionIndexRef.current - 1 + options.length) % options.length,
              );
              return true;
            }
            return moveMarkdownCursorVertically(view, false);
          },
        },
        {
          key: "Enter",
          run: () => {
            const option = filteredMentionsRef.current[mentionIndexRef.current];
            if (!mentionStateRef.current || !option) return false;
            selectMentionRef.current(option);
            return true;
          },
        },
        {
          key: "Backspace",
          run: (view) => deleteAtomic(view, "backward"),
        },
        {
          key: "Delete",
          run: (view) => deleteAtomic(view, "forward"),
        },
        {
          key: "Mod-Enter",
          run: () => {
            if (!propsRef.current.onSubmit) return false;
            propsRef.current.onSubmit();
            return true;
          },
        },
        ...(propsRef.current.submitShortcut === "enter"
          ? [{
            key: "Enter",
            run: () => {
              if (!propsRef.current.onSubmit) return false;
              propsRef.current.onSubmit();
              return true;
            },
          }]
          : []),
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.contentAttributes.of({
        "aria-label": editorAriaLabel,
        "aria-autocomplete": "list",
        "aria-expanded": "false",
        "data-markdown-source-editor": "true",
        spellcheck: "true",
      }),
      Prec.highest(EditorView.domEventHandlers({
        focus: (_event, view) => {
          view.dispatch({ effects: setPreviewFocus.of(true) });
          updateMentionState(view);
          return false;
        },
        blur: (_event, view) => {
          view.dispatch({ effects: setPreviewFocus.of(false) });
          propsRef.current.onBlur?.();
          mentionStateRef.current = null;
          dismissedMentionStateRef.current = null;
          setMentionState(null);
          return false;
        },
        compositionstart: (_event, view) => {
          compositionActiveRef.current = true;
          mentionStateRef.current = null;
          dismissedMentionStateRef.current = null;
          setMentionState(null);
          view.dispatch({ effects: setPreviewComposition.of(true) });
          return false;
        },
        compositionend: (_event, view) => {
          compositionActiveRef.current = false;
          queueMicrotask(() => {
            if (viewRef.current === view) {
              view.dispatch({ effects: setPreviewComposition.of(false) });
              updateMentionState(view);
            }
          });
          return false;
        },
        paste: handleSmartPaste,
        dragover: (event) => {
          if (propsRef.current.readOnly) return false;
          if (
            propsRef.current.imageUploadHandler
            && Array.from(event.dataTransfer?.items ?? []).some((item) => (
              item.kind === "file" && item.type.startsWith("image/")
            ))
          ) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        drop: (event, view) => {
          if (propsRef.current.readOnly) return false;
          const files = Array.from(event.dataTransfer?.files ?? [])
            .filter((candidate) => candidate.type.startsWith("image/"));
          if (files.length === 0 || !propsRef.current.imageUploadHandler) return false;
          event.preventDefault();
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            ?? view.state.selection.main.head;
          void handleImageUploads(files, view, position, position);
          return true;
        },
      })),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          for (const pending of pendingImageUploadsRef.current.values()) {
            if (pending.empty) {
              const anchor = update.changes.mapPos(pending.from, -1);
              pending.from = anchor;
              pending.to = anchor;
            } else {
              pending.from = update.changes.mapPos(pending.from, 1);
              pending.to = update.changes.mapPos(pending.to, -1);
            }
          }
          for (const [requestId, pending] of pendingTitlesRef.current) {
            let touchedInsertedLink = false;
            update.changes.iterChangedRanges((from, to) => {
              const intersects = from === to
                ? from > pending.from && from < pending.to
                : from < pending.to && to > pending.from;
              if (intersects) touchedInsertedLink = true;
            });
            if (touchedInsertedLink) {
              pendingTitlesRef.current.delete(requestId);
              continue;
            }
            pending.from = update.changes.mapPos(pending.from, 1);
            pending.to = update.changes.mapPos(pending.to, -1);
            pending.labelFrom = update.changes.mapPos(pending.labelFrom, 1);
            pending.labelTo = update.changes.mapPos(pending.labelTo, -1);
          }
          const nextValue = sourceMarkdown(update.state);
          currentValueRef.current = nextValue;
          const isExternal = update.transactions.some((transaction) => (
            transaction.annotation(externalValueSync)
          ));
          if (!isExternal) {
            propsRef.current.onChange(nextValue);
          }
        }
        updateMentionState(update.view);
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({
        doc: currentValueRef.current,
        extensions,
      }),
      parent,
    });
    viewRef.current = view;
    testEditorViews.set(rootElement, view);

    return () => {
      mountedRef.current = false;
      clearMarkdownBlockCloseTimeout();
      markdownBlockHoverRef.current = null;
      pendingTitlesRef.current.clear();
      pendingImageUploadsRef.current.clear();
      viewRef.current = null;
      setPreviewFocusRef.current = null;
      lineSeparatorCompartmentRef.current = null;
      readOnlyCompartmentRef.current = null;
      testEditorViews.delete(rootElement);
      view.destroy();
    };
  }, [
    clearMarkdownBlockCloseTimeout,
    registerPortal,
    setActiveMentionIndex,
    unregisterPortal,
    updateMentionState,
  ]);

  useEffect(() => {
    const content = viewRef.current?.contentDOM;
    if (!content) return;
    content.setAttribute("aria-label", editorAriaLabel);
  }, [editorAriaLabel]);

  useEffect(() => {
    const view = viewRef.current;
    currentValueRef.current = value;
    if (!view) return;
    const current = sourceMarkdown(view.state);
    const nextLineSeparator = sourceLineSeparator(value);
    const lineSeparatorChanged = nextLineSeparator !== lineSeparatorRef.current;
    if (current === value && !lineSeparatorChanged) return;
    pendingTitlesRef.current.clear();
    pendingImageUploadsRef.current.clear();
    const lineSeparatorCompartment = lineSeparatorCompartmentRef.current;
    lineSeparatorRef.current = nextLineSeparator;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      effects: lineSeparatorChanged && lineSeparatorCompartment
        ? lineSeparatorCompartment.reconfigure(
          EditorState.lineSeparator.of(nextLineSeparator),
        )
        : undefined,
      annotations: [
        externalValueSync.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    if (!view || !readOnlyCompartment) return;
    if (props.readOnly) {
      pendingTitlesRef.current.clear();
      pendingImageUploadsRef.current.clear();
      mentionStateRef.current = null;
      dismissedMentionStateRef.current = null;
      setMentionState(null);
      closeMarkdownBlockHover();
    }
    view.dispatch({
      effects: readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(Boolean(props.readOnly)),
        EditorView.editable.of(!props.readOnly),
      ]),
    });
  }, [closeMarkdownBlockHover, props.readOnly]);

  return (
    <div
      ref={rootRef}
      data-editor-engine="codemirror-live-preview"
      data-read-only={props.readOnly ? "true" : undefined}
      onMouseMove={handleMarkdownEditorMouseMove}
      onMouseLeave={scheduleMarkdownBlockClose}
      className={cn(
        "rudder-codemirror-markdown-editor relative",
        bordered && "rudder-codemirror-markdown-editor--bordered",
        className,
      )}
    >
      <div
        ref={mountRef}
        className={cn("rudder-codemirror-markdown-content", contentClassName)}
      />
      {portals.map((descriptor) => createPortal(
        descriptor.type === "website"
          ? <PortalWebsiteIcon descriptor={descriptor} />
          : (
            <PortalMarkdownBody
              descriptor={descriptor}
              onTableCellCommit={handleTableCellCommit}
              propsRef={propsRef}
              readSourceRange={readSourceRange}
              skillReferences={skillReferences}
            />
          ),
        descriptor.host,
        descriptor.key,
      ))}
      {uploadError ? (
        <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>
      ) : null}
      {markdownBlockHover ? (
        <MarkdownBlockHoverMenu
          anchor={markdownBlockHover}
          block={markdownBlockTarget}
          onAction={handleMarkdownBlockAction}
          onClose={closeMarkdownBlockHover}
          onKeepOpen={keepMarkdownBlockOpen}
          onOpen={openMarkdownBlockMenu}
          onScheduleClose={scheduleMarkdownBlockClose}
          open={markdownBlockMenuOpen}
          overlayRef={markdownBlockHoverOverlayRef}
        />
      ) : null}
      {mentionState && filteredMentions.length > 0 && mentionMenuPosition ? (
        <MarkdownMentionMenu
          activeIndex={mentionIndex}
          id={mentionListboxId}
          onActiveIndexChange={setActiveMentionIndex}
          onSelect={selectMention}
          options={filteredMentions}
          placement={props.mentionMenuPlacement ?? "caret"}
          style={mentionMenuPosition}
        />
      ) : null}
      {placeholder && !currentValueRef.current ? (
        <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
          {placeholder}
        </span>
      ) : null}
    </div>
  );
});

export const CodeMirrorMarkdownEditor = forwardRef<
  MarkdownEditorRef,
  CodeMirrorMarkdownEditorProps
>(function CodeMirrorMarkdownEditor(props, forwardedRef) {
  return (
    <CodeMirrorMarkdownEditorInstance
      key={props.documentIdentity ?? "__default__"}
      {...props}
      ref={forwardedRef}
    />
  );
});
