import {
  defaultKeymap,
  history,
  historyKeymap,
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
  WidgetType,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
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
import { basicSetup } from "codemirror";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  codeMirrorMarkdownEditorTheme,
  codeMirrorMarkdownHighlightStyle,
} from "../lib/codemirror-markdown-theme";
import type { AtomicInlineTokenElement } from "../lib/inline-token-dom";
import { alignMarkdownSourceLine } from "../lib/markdown-editor-scroll";
import {
  activeMarkdownPreviewBlockIds,
  buildMarkdownLink,
  escapeMarkdownLinkLabel,
  findAtomicMarkdownReferences,
  getMarkdownPreviewBlocks,
  markdownPreviewSource,
  markdownReferenceDefinitions,
  provisionalWebsiteLabel,
  readSingleHttpUrl,
  type AtomicMarkdownReference,
  type MarkdownPreviewBlock,
} from "../lib/markdown-live-preview";
import {
  mentionChipNavigationPath,
  parseMentionChipHref,
} from "../lib/mention-chips";
import { filterMentionOptions } from "../lib/mention-filter";
import {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
} from "../lib/mention-menu-position";
import {
  applyOrganizationPrefix,
  extractOrganizationPrefixFromPath,
} from "../lib/organization-routes";
import { buildLibrarySkillHref } from "../lib/skill-library-routes";
import { cn } from "../lib/utils";
import { getWebsiteMetadata } from "../lib/website-metadata-cache";
import { MarkdownBody } from "./MarkdownBody";
import type {
  MarkdownEditorProps,
  MarkdownEditorRef,
  MentionOption
} from "./MarkdownEditor";
import { MarkdownMentionMenu } from "./MarkdownMentionMenu";
import type { MarkdownSkillReferencePreview } from "./SkillReferenceToken";

type CodeMirrorMarkdownEditorProps = MarkdownEditorProps;

type PortalDescriptor =
  | {
    type: "block";
    key: string;
    host: HTMLElement;
    block: MarkdownPreviewBlock;
    previewMarkdown: string;
  }
  | {
    type: "atomic";
    key: string;
    host: HTMLElement;
    reference: AtomicMarkdownReference;
  };

type PortalRegistration = PortalDescriptor extends infer Descriptor
  ? Descriptor extends { host: HTMLElement }
    ? Omit<Descriptor, "host">
    : never
  : never;

interface PortalRegistry {
  register: (registration: PortalRegistration, host: HTMLElement) => void;
  unregister: (key: string, host: HTMLElement) => void;
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

interface CodeMirrorMentionState {
  trigger: "@" | "$";
  query: string;
  from: number;
  to: number;
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
}

const externalValueSync = Annotation.define<boolean>();
const titleUpgradeTransaction = Annotation.define<boolean>();
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

function isPrimaryPlainMouseEvent(event: MouseEvent) {
  return event.button === 0
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey;
}

function tokenKind(reference: AtomicMarkdownReference): AtomicInlineTokenElement["kind"] {
  return /(?:SKILL\.md|^skill:\/\/)/iu.test(reference.href) || reference.label.trim().startsWith("$")
    ? "skill"
    : "mention";
}

function toInlineToken(
  reference: AtomicMarkdownReference,
  element: HTMLElement,
): AtomicInlineTokenElement {
  return {
    element,
    href: reference.href,
    kind: tokenKind(reference),
    label: reference.label.replace(/^[@$]/u, ""),
  };
}

function sourceReferenceForTarget(block: MarkdownPreviewBlock, target: HTMLElement) {
  const sourceElement = target.closest<HTMLElement>(
    "[data-markdown-source-start][data-markdown-source-end]",
  );
  const start = Number(sourceElement?.dataset.markdownSourceStart);
  const end = Number(sourceElement?.dataset.markdownSourceEnd);
  const references = findAtomicMarkdownReferences(block.markdown);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    const positioned = references.find((reference) => reference.from === start && reference.to === end);
    if (positioned) return positioned;
  }

  const label = target.textContent?.trim().replace(/^[@$]/u, "") ?? "";
  return references.find((reference) => reference.label.trim().replace(/^[@$]/u, "") === label) ?? null;
}

function emitInlineTokenClick(
  props: CodeMirrorMarkdownEditorProps,
  reference: AtomicMarkdownReference,
  element: HTMLElement,
  event: MouseEvent | KeyboardEvent,
) {
  if (props.onInlineTokenClick) {
    event.preventDefault();
    props.onInlineTokenClick(toInlineToken(reference, element), {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
    return true;
  }

  let target: string | null = null;
  if (tokenKind(reference) === "mention") {
    const mention = parseMentionChipHref(reference.href);
    if (mention) target = mentionChipNavigationPath(mention);
  } else {
    target = (props.mentions ?? []).find((option) => (
      option.kind === "skill"
      && option.skillMarkdownTarget === reference.href
      && option.skillDetailsHref
    ))?.skillDetailsHref ?? null;
    if (!target && /^skill:\/\/org\//iu.test(reference.href)) {
      try {
        const skillUrl = new URL(reference.href);
        const skillId = decodeURIComponent(
          skillUrl.pathname.split("/").filter(Boolean)[0] ?? "",
        );
        if (skillId) target = buildLibrarySkillHref(skillId);
      } catch {
        // A malformed historical token remains inert source data.
      }
    }
  }
  if (!target || typeof window === "undefined") return false;

  event.preventDefault();
  const route = applyOrganizationPrefix(
    target,
    extractOrganizationPrefixFromPath(window.location.pathname),
  );
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (route !== current) {
    window.history.pushState(window.history.state, "", route);
    window.dispatchEvent(new PopStateEvent("popstate", {
      state: window.history.state,
    }));
  }
  return true;
}

class MarkdownPortalWidget extends WidgetType {
  constructor(
    readonly registration: PortalRegistration,
    readonly registry: PortalRegistry,
    readonly propsRef: { current: CodeMirrorMarkdownEditorProps },
    readonly activateBlock: (block: MarkdownPreviewBlock, view: EditorView) => void,
  ) {
    super();
  }

  eq(other: MarkdownPortalWidget) {
    return other.registration.key === this.registration.key;
  }

  toDOM(view: EditorView) {
    const host = document.createElement("span");
    host.className = this.registration.type === "block"
      ? "rudder-codemirror-markdown-preview"
      : "rudder-codemirror-markdown-atomic";
    host.dataset.markdownPreviewState = "preview";

    if (this.registration.type === "block") {
      const { block } = this.registration;
      host.dataset.sourceLineStart = String(block.startLine);
      host.dataset.sourceLineEnd = String(block.endLine);
      host.tabIndex = -1;
      host.addEventListener("mousedown", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const tokenElement = target?.closest<HTMLElement>("[data-mention-kind], [data-skill-token='true']");
        if (
          tokenElement
          || target?.closest(".rudder-code-block-copy-button")
        ) {
          // CodeMirror's pointer handler may otherwise move the selection and
          // replace this widget before mouseup, so the browser never delivers
          // the token's click. Keep the atomic/widget DOM stable for the full
          // pointer sequence.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!isPrimaryPlainMouseEvent(event)) return;
        event.preventDefault();
        this.activateBlock(block, view);
      });
      host.addEventListener("click", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const tokenElement = target?.closest<HTMLElement>("[data-mention-kind], [data-skill-token='true']");
        if (tokenElement) {
          const reference = sourceReferenceForTarget(block, tokenElement);
          if (
            reference
            && emitInlineTokenClick(
              this.propsRef.current,
              reference,
              tokenElement,
              event,
            )
          ) {
            event.stopPropagation();
          }
          return;
        }
        if (
          target?.closest("a")
          && event.detail !== 0
          && isPrimaryPlainMouseEvent(event)
        ) {
          event.preventDefault();
          this.activateBlock(block, view);
        }
      });
      host.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (
          target?.closest(
            "a, [data-mention-kind], [data-skill-token='true'], .rudder-code-block-copy-button",
          )
        ) {
          return;
        }
        event.preventDefault();
        this.activateBlock(block, view);
      });
    } else {
      const { reference } = this.registration;
      host.dataset.markdownAtomicReference = "true";
      host.dataset.sourceStart = String(reference.from);
      host.dataset.sourceEnd = String(reference.to);
      host.addEventListener("mousedown", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (
          event.button === 0
          && target?.closest<HTMLElement>(
            "[data-mention-kind], [data-skill-token='true']",
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      host.addEventListener("click", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const tokenElement = target?.closest<HTMLElement>(
          "[data-mention-kind], [data-skill-token='true']",
        );
        if (!tokenElement) return;
        if (
          emitInlineTokenClick(
            this.propsRef.current,
            reference,
            tokenElement,
            event,
          )
        ) {
          event.stopPropagation();
        }
      });
    }

    queueMicrotask(() => {
      if (host.isConnected) this.registry.register(this.registration, host);
    });
    return host;
  }

  destroy(host: HTMLElement) {
    this.registry.unregister(this.registration.key, host);
  }

  ignoreEvent() {
    return true;
  }
}

function sourceLineDecorations(
  block: MarkdownPreviewBlock,
  state: EditorState,
) {
  const decorations: Range<Decoration>[] = [];
  for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
    const line = state.doc.line(Math.min(lineNumber, state.doc.lines));
    decorations.push(
      Decoration.line({
        attributes: {
          "data-markdown-preview-state": "source",
          "data-markdown-source-kind": block.kind,
          "data-source-line-start": String(lineNumber),
          "data-source-line-end": String(block.endLine),
        },
      }).range(line.from),
    );
  }
  return decorations;
}

function activeSelectionRanges(state: EditorState) {
  return state.selection.ranges.map((range) => ({
    from: range.from,
    to: range.to,
  }));
}

function markdownPreviewDecorations(
  state: EditorState,
  focused: boolean,
  registry: PortalRegistry,
  propsRef: { current: CodeMirrorMarkdownEditorProps },
  activateBlock: (block: MarkdownPreviewBlock, view: EditorView) => void,
): { decorations: DecorationSet; atomic: DecorationSet } {
  const source = state.doc.toString();
  const blocks = getMarkdownPreviewBlocks(source);
  const referenceDefinitions = markdownReferenceDefinitions(source);
  const activeIds = focused
    ? activeMarkdownPreviewBlockIds(blocks, activeSelectionRanges(state))
    : new Set<string>();
  const decorations: Range<Decoration>[] = [];
  const atomicDecorations: Range<Decoration>[] = [];

  for (const block of blocks) {
    const isSource = !block.previewable || activeIds.has(block.id);
    if (isSource) {
      decorations.push(...sourceLineDecorations(block, state));
      const references = findAtomicMarkdownReferences(block.markdown);
      for (const reference of references) {
        const absoluteReference = {
          ...reference,
          from: block.from + reference.from,
          to: block.from + reference.to,
        };
        const key = `atomic:${absoluteReference.from}:${absoluteReference.to}:${absoluteReference.markdown}`;
        const replacement = Decoration.replace({
          widget: new MarkdownPortalWidget(
            {
              type: "atomic",
              key,
              reference: absoluteReference,
            },
            registry,
            propsRef,
            activateBlock,
          ),
          inclusive: false,
        }).range(absoluteReference.from, absoluteReference.to);
        decorations.push(replacement);
        atomicDecorations.push(replacement);
      }
      continue;
    }

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

function markdownCompletion(option: MentionOption, intent?: "reference" | "wake") {
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

function mentionStateAtSelection(view: EditorView): CodeMirrorMentionState | null {
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

function sameMentionState(
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

function portalLinkClickHandler(descriptor: PortalDescriptor) {
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
  descriptor: PortalDescriptor;
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
    const nextState = view.hasFocus ? mentionStateAtSelection(view) : null;
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
    const insert = markdownCompletion(option, propsRef.current.agentMentionIntent);
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
    return getMentionMenuPositionForViewport(
      mentionState,
      window.innerWidth,
      window.innerHeight,
      props.mentionMenuSize === "compact"
        ? { width: 320, maxHeight: 180 }
        : undefined,
    );
  }, [
    mentionState,
    props.mentionMenuAnchorRef,
    props.mentionMenuPlacement,
    props.mentionMenuSize,
  ]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      setPreviewFocusRef.current?.(view, true);
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
      focused: boolean;
      composing: boolean;
    };
    const previewField = StateField.define<PreviewFieldValue>({
      create(state) {
        const result = markdownPreviewDecorations(
          state,
          false,
          registry,
          propsRef,
          activateBlock,
        );
        return {
          ...result,
          focused: false,
          composing: false,
        };
      },
      update(current, transaction) {
        let focused = current.focused;
        let composing = current.composing;
        let effectChanged = false;
        for (const effect of transaction.effects) {
          if (effect.is(setPreviewFocus)) {
            focused = effect.value;
            effectChanged = true;
          }
          if (effect.is(setPreviewComposition)) {
            composing = effect.value;
            effectChanged = true;
          }
        }

        if (composing) {
          return {
            decorations: current.decorations.map(transaction.changes),
            atomic: current.atomic.map(transaction.changes),
            focused,
            composing,
          };
        }

        const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
        if (!transaction.docChanged && !selectionChanged && !effectChanged) {
          return current;
        }
        const result = markdownPreviewDecorations(
          transaction.state,
          focused,
          registry,
          propsRef,
          activateBlock,
        );
        return {
          ...result,
          focused,
          composing,
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
      markdown(),
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
      Prec.highest(keymap.of([
        {
          key: "ArrowDown",
          run: () => {
            const options = filteredMentionsRef.current;
            if (!mentionStateRef.current || options.length === 0) return false;
            setActiveMentionIndex(
              (mentionIndexRef.current + 1) % options.length,
            );
            return true;
          },
        },
        {
          key: "ArrowUp",
          run: () => {
            const options = filteredMentionsRef.current;
            if (!mentionStateRef.current || options.length === 0) return false;
            setActiveMentionIndex(
              (mentionIndexRef.current - 1 + options.length) % options.length,
            );
            return true;
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
          key: "Escape",
          run: () => {
            if (!mentionStateRef.current) return false;
            mentionStateRef.current = null;
            setMentionState(null);
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
          setMentionState(null);
          return false;
        },
        compositionstart: (_event, view) => {
          view.dispatch({ effects: setPreviewComposition.of(true) });
          return false;
        },
        compositionend: (_event, view) => {
          queueMicrotask(() => {
            if (viewRef.current === view) {
              view.dispatch({ effects: setPreviewComposition.of(false) });
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
        <PortalMarkdownBody
          descriptor={descriptor}
          propsRef={propsRef}
          skillReferences={skillReferences}
        />,
        descriptor.host,
        descriptor.key,
      ))}
      {uploadError ? (
        <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>
      ) : null}
      {mentionState && filteredMentions.length > 0 && mentionMenuPosition ? (
        <MarkdownMentionMenu
          activeIndex={mentionIndex}
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
