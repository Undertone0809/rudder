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
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  const activeIds = focused
    ? activeMarkdownPreviewBlockIds(
      blocks,
      activeRangesOverride ?? activeSelectionRanges(state),
    )
    : new Set<string>();
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
    // Atomic token activation is owned by the widget's native listener. It
    // runs after React's delegated handler and keeps the same DOM alive across
    // mousedown/click, while this return prevents MarkdownBody's ordinary-link
    // behavior from competing with that activation.
    return true;
  };
}

function PortalMarkdownBody({
  descriptor,
  propsRef,
  skillReferences,
}: {
  descriptor: MarkdownPortalDescriptor;
  propsRef: { current: CodeMirrorMarkdownEditorProps };
  skillReferences: MarkdownSkillReferencePreview[];
}) {
  const keyboardScopeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const scope = keyboardScopeRef.current;
    if (!scope) return;
    for (const token of scope.querySelectorAll<HTMLElement>(
      "[data-skill-token='true']:not(a)",
    )) {
      token.tabIndex = 0;
      token.setAttribute("role", "link");
    }
  }, [descriptor.key]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
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
      >
        {descriptor.type === "block"
          ? descriptor.previewMarkdown
          : descriptor.reference.markdown}
      </MarkdownBody>
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
    placeholder,
    className,
    contentClassName,
    bordered = true,
  } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  const currentValueRef = useRef(value);
  const pendingTitlesRef = useRef(new Map<number, PendingTitleUpgrade>());
  const pendingImageUploadsRef = useRef(new Map<number, PendingImageUpload>());
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
  const lineSeparatorRef = useRef(sourceLineSeparator(value));
  const mountedRef = useRef(false);
  const [portals, setPortals] = useState<PortalDescriptor[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mentionState, setMentionState] = useState<CodeMirrorMentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
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
      if (!view) return false;
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
      return view ? undo(view) : false;
    },
    redo: () => {
      const view = viewRef.current;
      return view ? redo(view) : false;
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
    setPreviewFocusRef.current = (view, focused) => {
      view.dispatch({ effects: setPreviewFocus.of(focused) });
    };
    const activateBlock = (block: MarkdownPreviewBlock, view: EditorView) => {
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

        if (pointerSelecting) {
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

    const handleImageUpload = async (file: File, view: EditorView, from: number, to: number) => {
      const upload = propsRef.current.imageUploadHandler;
      if (!upload) return;
      const requestId = ++imageUploadRequestIdRef.current;
      pendingImageUploadsRef.current.set(requestId, {
        from,
        to,
        empty: from === to,
        expectedSource: view.state.sliceDoc(from, to),
      });
      setUploadError(null);
      try {
        const url = await upload(file);
        const pending = pendingImageUploadsRef.current.get(requestId);
        pendingImageUploadsRef.current.delete(requestId);
        if (
          !pending
          || viewRef.current !== view
          || view.state.sliceDoc(pending.from, pending.to) !== pending.expectedSource
        ) {
          return;
        }
        const label = file.name || "image";
        const markdownImage = `![${label.replace(/([\[\]\\])/gu, "\\$1")}](${url})`;
        view.dispatch({
          changes: { from: pending.from, to: pending.to, insert: markdownImage },
          selection: { anchor: pending.from + markdownImage.length },
          userEvent: "input.paste",
        });
      } catch (error) {
        pendingImageUploadsRef.current.delete(requestId);
        setUploadError(error instanceof Error ? error.message : "Image upload failed.");
      }
    };

    const handleSmartPaste = (event: ClipboardEvent, view: EditorView) => {
      const imageFile = Array.from(event.clipboardData?.files ?? [])
        .find((file) => file.type.startsWith("image/"));
      if (imageFile && propsRef.current.imageUploadHandler) {
        event.preventDefault();
        const range = view.state.selection.main;
        void handleImageUpload(imageFile, view, range.from, range.to);
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
          const pointerTarget = event.target instanceof HTMLElement ? event.target : null;
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
        "aria-label": placeholder ? `${placeholder} Markdown editor` : "Markdown editor",
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
          const file = Array.from(event.dataTransfer?.files ?? [])
            .find((candidate) => candidate.type.startsWith("image/"));
          if (!file || !propsRef.current.imageUploadHandler) return false;
          event.preventDefault();
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            ?? view.state.selection.main.head;
          void handleImageUpload(file, view, position, position);
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
      pendingTitlesRef.current.clear();
      pendingImageUploadsRef.current.clear();
      viewRef.current = null;
      setPreviewFocusRef.current = null;
      lineSeparatorCompartmentRef.current = null;
      testEditorViews.delete(rootElement);
      view.destroy();
    };
  }, [
    registerPortal,
    setActiveMentionIndex,
    unregisterPortal,
    updateMentionState,
  ]);

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

  return (
    <div
      ref={rootRef}
      data-editor-engine="codemirror-live-preview"
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
              propsRef={propsRef}
              skillReferences={skillReferences}
            />
          ),
        descriptor.host,
        descriptor.key,
      ))}
      {uploadError ? (
        <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>
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
