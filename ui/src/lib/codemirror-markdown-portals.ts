import { WidgetType, type EditorView } from "@codemirror/view";
import type { MarkdownEditorProps } from "../components/MarkdownEditor";
import {
  safeInteractiveMarkdownHref,
  type MarkdownWebsiteLink,
} from "./codemirror-markdown-live-preview";
import type { AtomicInlineTokenElement } from "./inline-token-dom";
import {
  findAtomicMarkdownReferences,
  type AtomicMarkdownReference,
  type MarkdownPreviewBlock,
} from "./markdown-live-preview";
import {
  mentionChipNavigationPath,
  parseMentionChipHref,
} from "./mention-chips";
import {
  applyOrganizationPrefix,
  extractOrganizationPrefixFromPath,
} from "./organization-routes";
import { buildLibrarySkillHref } from "./skill-library-routes";

export type MarkdownPortalEditorProps = MarkdownEditorProps;

export type PortalDescriptor =
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
  }
  | {
    type: "website";
    key: string;
    host: HTMLElement;
    link: MarkdownWebsiteLink;
  };

export type PortalRegistration = PortalDescriptor extends infer Descriptor
  ? Descriptor extends { host: HTMLElement }
    ? Omit<Descriptor, "host">
    : never
  : never;

export interface PortalRegistry {
  register: (registration: PortalRegistration, host: HTMLElement) => void;
  unregister: (key: string, host: HTMLElement) => void;
}

export function isPrimaryPlainMouseEvent(event: MouseEvent) {
  return event.button === 0
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey;
}

export function openDecoratedMarkdownLink(href: string) {
  if (typeof document === "undefined") return;
  if (!safeInteractiveMarkdownHref(href)) return;
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.rel = "noopener noreferrer";
  if (/^https?:\/\//iu.test(href)) anchor.target = "_blank";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function markdownPointerPosition(
  view: EditorView,
  event: Pick<MouseEvent, "clientX" | "clientY">,
) {
  const ownerDocument = view.contentDOM.ownerDocument;
  const documentWithCaret = ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => {
      offsetNode: Node;
      offset: number;
    } | null;
    caretRangeFromPoint?: (x: number, y: number) => {
      startContainer: Node;
      startOffset: number;
    } | null;
  };
  const caretPosition = documentWithCaret.caretPositionFromPoint?.(
    event.clientX,
    event.clientY,
  );
  if (caretPosition) {
    try {
      return view.posAtDOM(caretPosition.offsetNode, caretPosition.offset);
    } catch {
      // Fall through to CodeMirror's geometry lookup.
    }
  }
  const caretRange = documentWithCaret.caretRangeFromPoint?.(
    event.clientX,
    event.clientY,
  );
  if (caretRange) {
    try {
      return view.posAtDOM(caretRange.startContainer, caretRange.startOffset);
    } catch {
      // Fall through to CodeMirror's geometry lookup.
    }
  }
  return view.posAtCoords({
    x: event.clientX,
    y: event.clientY,
  });
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

export function sourceReferenceForTarget(block: MarkdownPreviewBlock, target: HTMLElement) {
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

export function emitInlineTokenClick(
  props: MarkdownPortalEditorProps,
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

export class MarkdownPortalWidget extends WidgetType {
  constructor(
    readonly registration: PortalRegistration,
    readonly registry: PortalRegistry,
    readonly propsRef: { current: MarkdownPortalEditorProps },
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
      : this.registration.type === "website"
        ? "rudder-codemirror-markdown-website"
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
    } else if (this.registration.type === "atomic") {
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
    } else {
      host.dataset.markdownWebsiteIcon = "true";
      host.dataset.sourceStart = String(this.registration.link.from);
      host.dataset.sourceEnd = String(this.registration.link.to);
      host.setAttribute("aria-hidden", "true");
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
