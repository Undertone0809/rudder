import { buildAgentMentionHref } from "@rudderhq/shared";
import { Check, Copy, Globe2 } from "lucide-react";
import { isValidElement, useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type MouseEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { websiteMetadataApi } from "../api/websiteMetadata";
import { useMarkdownMentions } from "../context/MarkdownMentionsContext";
import { useTheme } from "../context/ThemeContext";
import { normalizeRenderedMarkdownSource } from "../lib/markdown-normalize";
import { mentionChipInlineStyle, mentionChipNavigationPath, parseMentionChipHref, stripMentionChipLabelPrefix, type ParsedMentionChip } from "../lib/mention-chips";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "../lib/organization-routes";
import { formatSkillReferenceDisplayLabel, parseSkillReference } from "../lib/skill-reference";
import { cn } from "../lib/utils";
import { ImagePreviewDialog, type ImagePreviewState } from "./ImagePreviewDialog";
import { InspectableImage } from "./InspectableImage";
import type { MentionOption } from "./MarkdownEditor";
import { RudderEntityPreview } from "./RudderEntityPreview";
import { SkillReferenceToken, type MarkdownSkillReferencePreview } from "./SkillReferenceToken";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  /** Optional resolver for relative image paths (e.g. within export packages) */
  resolveImageSrc?: (src: string) => string | null;
  onLinkClick?: MarkdownLinkClickHandler;
  agentMentions?: MarkdownAgentMentionPreview[];
  skillReferences?: MarkdownSkillReferencePreview[];
  enableImagePreview?: boolean;
  copyMarkdownOnCopy?: boolean;
  enableCodeBlockCopy?: boolean;
}

export interface MarkdownAgentMentionPreview {
  name: string;
  agentId: string;
  agentIcon?: string | null;
}

export type MarkdownLinkClickHandler = (input: {
  event: MouseEvent<HTMLAnchorElement>;
  href: string;
  label: string;
}) => boolean | void;

let mermaidLoaderPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidLoaderPromise) {
    mermaidLoaderPromise = import("mermaid").then((module) => module.default);
  }
  return mermaidLoaderPromise;
}

function flattenText(value: ReactNode): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join("");
  if (isValidElement(value)) {
    return flattenText((value.props as { children?: ReactNode }).children);
  }
  return "";
}

function normalizeSkillReferenceLookupKey(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/u, "").toLowerCase() ?? "";
}

function compactMentionId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "item";
  const firstSegment = trimmed.split(/[-/]/u).find(Boolean);
  if (firstSegment && firstSegment.length >= 6) return firstSegment.slice(0, 12);
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function basenameFromPath(value: string | null | undefined) {
  const trimmed = value?.trim().replace(/\/+$/u, "") ?? "";
  return trimmed.split("/").filter(Boolean).at(-1) ?? "";
}

function mentionFallbackLabel(mention: ParsedMentionChip) {
  if (mention.kind === "agent") return compactMentionId(mention.agentId);
  if (mention.kind === "project") return compactMentionId(mention.projectId);
  if (mention.kind === "automation") return mention.title?.trim() || compactMentionId(mention.automationId);
  if (mention.kind === "issue") return mention.ref?.trim() || compactMentionId(mention.issueId);
  if (mention.kind === "chat") return mention.title?.trim() || compactMentionId(mention.conversationId);
  if (mention.kind === "library_doc") return mention.title?.trim() || compactMentionId(mention.documentId);
  if (mention.kind === "library_entry") return mention.title?.trim() || basenameFromPath(mention.path) || compactMentionId(mention.entryId);
  if (mention.kind === "library_file") return mention.title?.trim() || basenameFromPath(mention.filePath) || compactMentionId(mention.filePath);
  return mention.title?.trim() || basenameFromPath(mention.directoryPath) || compactMentionId(mention.directoryPath);
}

function decodeHtmlEntityText(value: string) {
  if (!/[&][#a-z\d]+;/iu.test(value)) return value;
  if (typeof document === "undefined") return value;

  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function mentionDisplayLabel(value: string) {
  return decodeHtmlEntityText(value).replace(/\s+/gu, " ").trim();
}

function currentOrganizationPrefixFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return extractOrganizationPrefixFromPath(window.location.pathname);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function normalizeAgentMentionName(value: string) {
  return value.trim().replace(/^@+/u, "");
}

function isBackendResolvableBareAgentName(value: string) {
  return /^[^\s@,!?.]+$/u.test(value);
}

function findClosingMarkdownToken(source: string, token: string, fromIndex: number) {
  const index = source.indexOf(token, fromIndex);
  return index >= 0 ? index : null;
}

function findClosingMarkdownParen(source: string, fromIndex: number) {
  let escaped = false;
  for (let index = fromIndex; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === ")") return index;
  }
  return null;
}

function splitUnprotectedMarkdownText(source: string): Array<{ text: string; protected: boolean }> {
  const parts: Array<{ text: string; protected: boolean }> = [];
  let cursor = 0;
  let plainStart = 0;

  function pushPlain(end: number) {
    if (end > plainStart) parts.push({ text: source.slice(plainStart, end), protected: false });
  }

  function pushProtected(end: number) {
    pushPlain(cursor);
    parts.push({ text: source.slice(cursor, end), protected: true });
    cursor = end;
    plainStart = end;
  }

  while (cursor < source.length) {
    const char = source[cursor];

    if (char === "`") {
      const fence = source.slice(cursor).match(/^`+/u)?.[0] ?? "`";
      const closing = findClosingMarkdownToken(source, fence, cursor + fence.length);
      if (closing !== null) {
        pushProtected(closing + fence.length);
        continue;
      }
    }

    const linkStart = char === "[" ? cursor : char === "!" && source[cursor + 1] === "[" ? cursor + 1 : null;
    if (linkStart !== null) {
      const closeBracket = findClosingMarkdownToken(source, "]", linkStart + 1);
      if (closeBracket !== null && source[closeBracket + 1] === "(") {
        const closeParen = findClosingMarkdownParen(source, closeBracket + 2);
        if (closeParen !== null) {
          pushProtected(closeParen + 1);
          continue;
        }
      }
    }

    if (char === "<") {
      const closeAngle = findClosingMarkdownToken(source, ">", cursor + 1);
      if (closeAngle !== null) {
        pushProtected(closeAngle + 1);
        continue;
      }
    }

    cursor += 1;
  }

  pushPlain(source.length);
  return parts;
}

export function linkBareAgentMentions(
  source: string,
  agentMentions: MarkdownAgentMentionPreview[] | null | undefined,
) {
  if (!source.includes("@") || !agentMentions?.length) return source;

  const mentionEntries = agentMentions
    .map((mention) => ({
      ...mention,
      name: normalizeAgentMentionName(mention.name),
    }))
    .filter((mention) => mention.name && mention.agentId && isBackendResolvableBareAgentName(mention.name))
    .sort((a, b) => b.name.length - a.name.length);
  if (mentionEntries.length === 0) return source;

  const mentionRe = new RegExp(
    `(^|[^\\w/[\\]\`])@(${mentionEntries.map((mention) => escapeRegExp(mention.name)).join("|")})(?=$|[\\s@,!?.])`,
    "giu",
  );
  const fencedCodeRe = /^(```|~~~)/;
  let inFence = false;

  return source.split(/(\n)/).map((part) => {
    if (part === "\n") return part;
    if (fencedCodeRe.test(part.trimStart())) {
      inFence = !inFence;
      return part;
    }
    if (inFence) return part;

    return splitUnprotectedMarkdownText(part).map((segment) => {
      if (segment.protected) return segment.text;
      return segment.text.replace(mentionRe, (match, prefix: string, rawName: string) => {
        const found = mentionEntries.find((mention) => mention.name.toLowerCase() === rawName.toLowerCase());
        if (!found) return match;
        const href = buildAgentMentionHref(found.agentId, found.agentIcon);
        return `${prefix}[@${escapeMarkdownLinkLabel(found.name)}](${href})`;
      });
    }).join("");
  }).join("");
}

function isExternalMarkdownHref(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return true;
  if (!/^[a-z][a-z\d+.-]*:/iu.test(trimmed)) return false;

  try {
    const parsed = new URL(trimmed);
    if (
      typeof window !== "undefined" &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === window.location.origin
    ) {
      return false;
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function websiteUrlFromMarkdownHref(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const candidate = trimmed.startsWith("//")
    ? `${typeof window === "undefined" ? "https:" : window.location.protocol}${trimmed}`
    : trimmed;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (typeof window !== "undefined" && parsed.origin === window.location.origin) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isBareMarkdownUrlLabel(label: string) {
  const normalizedLabel = label.trim();
  return /^(?:https?:\/\/|www\.|\/\/)/iu.test(normalizedLabel);
}

function isAbsoluteMarkdownHref(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(trimmed);
}

const APP_ROUTE_FIRST_SEGMENTS = new Set([
  "agents",
  "automations",
  "dashboard",
  "goals",
  "inbox",
  "issues",
  "library",
  "messenger",
  "organization",
  "projects",
  "settings",
  "skills",
]);

function isPlainPrimaryClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function internalAppRouteFromHref(href: string, organizationPrefix: string | null | undefined) {
  if (typeof window === "undefined") return null;

  try {
    const parsed = new URL(href, window.location.href);
    if (parsed.origin !== window.location.origin) return null;

    const segments = parsed.pathname.split("/").filter(Boolean);
    const firstRouteSegment = segments[0] && APP_ROUTE_FIRST_SEGMENTS.has(segments[0])
      ? segments[0]
      : segments[1] && APP_ROUTE_FIRST_SEGMENTS.has(segments[1])
        ? segments[1]
        : null;
    if (!firstRouteSegment) return null;

    return applyOrganizationPrefix(`${parsed.pathname}${parsed.search}${parsed.hash}`, organizationPrefix);
  } catch {
    return null;
  }
}

function issueRouteRefFromHref(href: string | null | undefined) {
  if (!href || typeof window === "undefined") return null;

  try {
    const parsed = new URL(href, window.location.href);
    if (parsed.origin !== window.location.origin) return null;

    const segments = parsed.pathname.split("/").filter(Boolean);
    const issueSegmentIndex = segments.findIndex((segment) => segment.toLowerCase() === "issues");
    if (issueSegmentIndex < 0) return null;
    const issueRef = segments[issueSegmentIndex + 1];
    if (!issueRef) return null;
    return decodeURIComponent(issueRef);
  } catch {
    return null;
  }
}

function matchingIssueMentionFromRouteRef(
  issueRouteRef: string | null | undefined,
  issueMentions: MentionOption[],
) {
  const normalizedRouteRef = issueRouteRef?.trim().toLowerCase();
  if (!normalizedRouteRef) return null;

  return issueMentions.find((mention) => {
    if (mention.kind !== "issue" || !mention.issueId) return false;
    const issueId = mention.issueId.toLowerCase();
    const issueIdentifier = mention.issueIdentifier?.toLowerCase() ?? "";
    return (
      issueId === normalizedRouteRef ||
      issueIdentifier === normalizedRouteRef ||
      (normalizedRouteRef.length >= 6 && issueId.startsWith(normalizedRouteRef))
    );
  }) ?? null;
}

function navigateInternalAppRoute(route: string) {
  if (typeof window === "undefined") return;
  const currentRoute = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (route === currentRoute) return;

  window.history.pushState(window.history.state, "", route);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

type WebsiteMetadataIconState =
  | { status: "idle" | "loading" | "none" | "error"; iconUrl: null }
  | { status: "ready"; iconUrl: string };

const websiteMetadataIconCache = new Map<string, WebsiteMetadataIconState>();
const websiteMetadataIconInflight = new Map<string, Promise<WebsiteMetadataIconState>>();

function useWebsiteMetadataIcon(url: URL) {
  const href = url.href;
  const [state, setState] = useState<WebsiteMetadataIconState>(
    () => websiteMetadataIconCache.get(href) ?? { status: "idle", iconUrl: null },
  );

  useEffect(() => {
    const cached = websiteMetadataIconCache.get(href);
    if (cached && cached.status !== "loading") {
      setState(cached);
      return;
    }

    const loadingState: WebsiteMetadataIconState = { status: "loading", iconUrl: null };
    websiteMetadataIconCache.set(href, loadingState);

    let cancelled = false;
    const request = websiteMetadataIconInflight.get(href) ?? Promise.resolve(websiteMetadataApi.get(href))
      .then((metadata) => {
        const nextState: WebsiteMetadataIconState = metadata?.iconUrl
          ? { status: "ready", iconUrl: metadata.iconUrl }
          : { status: "none", iconUrl: null };
        return nextState;
      })
      .catch((): WebsiteMetadataIconState => {
        return { status: "error", iconUrl: null };
      })
      .finally(() => {
        websiteMetadataIconInflight.delete(href);
      });
    websiteMetadataIconInflight.set(href, request);

    request
      .then((nextState) => {
        websiteMetadataIconCache.set(href, nextState);
        if (!cancelled) setState(nextState);
      });

    return () => {
      cancelled = true;
    };
  }, [href]);

  return state;
}

export function WebsiteLinkIcon({ url }: { url: URL }) {
  const metadataIcon = useWebsiteMetadataIcon(url);
  const [failedIconUrls, setFailedIconUrls] = useState<Set<string>>(() => new Set());
  const iconUrl = metadataIcon.status === "ready" && !failedIconUrls.has(metadataIcon.iconUrl)
    ? metadataIcon.iconUrl
    : null;

  if (iconUrl) {
    return (
      <span
        className="rudder-website-link-icon"
        aria-hidden="true"
        data-website-icon="metadata"
      >
        <img
          src={iconUrl}
          alt=""
          className="rudder-website-link-logo"
          aria-hidden="true"
          data-website-icon="metadata"
          referrerPolicy="no-referrer"
          onError={() => setFailedIconUrls((current) => new Set(current).add(iconUrl))}
        />
      </span>
    );
  }

  return (
    <span className="rudder-website-link-icon" aria-hidden="true" data-website-icon="generic">
      <Globe2 className="rudder-website-link-generic" aria-hidden="true" />
    </span>
  );
}

export function __clearWebsiteMetadataIconCacheForTests() {
  websiteMetadataIconCache.clear();
  websiteMetadataIconInflight.clear();
}

function extractMermaidSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const childProps = children.props as { className?: unknown; children?: ReactNode };
  if (typeof childProps.className !== "string") return null;
  if (!/\blanguage-mermaid\b/i.test(childProps.className)) return null;
  return flattenText(childProps.children).replace(/\n$/, "");
}

function extractCodeBlockSource(children: ReactNode) {
  const source = flattenText(children);
  return source.replace(/\n$/, "");
}

function extractCodeBlockLanguage(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const childProps = children.props as { className?: unknown };
  if (typeof childProps.className !== "string") return null;
  const language = childProps.className.match(/\blanguage-([^\s]+)/i)?.[1];
  return language?.toLowerCase() ?? null;
}

function isPatchCodeBlockLanguage(language: string | null) {
  return language === "diff" || language === "patch" || language === "udiff";
}

function classifyPatchLine(line: string) {
  if (/^(?:diff --git|index |new file mode |deleted file mode |old mode |new mode |rename from |rename to |similarity index )/.test(line)) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

function PatchCodeBlock({
  source,
  preProps,
  sourceAttributes,
}: {
  source: string;
  preProps: Record<string, unknown>;
  sourceAttributes: ReturnType<typeof markdownSourceAttributes>;
}) {
  const lines = source.split("\n");

  return (
    <pre
      {...preProps}
      {...sourceAttributes}
      className={cn(typeof preProps.className === "string" ? preProps.className : null, "rudder-markdown-patch-block")}
    >
      <code>
        {lines.map((line, index) => {
          const kind = classifyPatchLine(line);
          const hasPatchMarker = kind === "add" || kind === "remove";
          const marker = hasPatchMarker ? line.slice(0, 1) : "";
          const content = hasPatchMarker ? line.slice(1) : line;

          return (
            <span key={`${index}-${kind}`} className={cn("rudder-markdown-patch-line", `rudder-markdown-patch-line--${kind}`)}>
              <span className="rudder-markdown-patch-line-marker" aria-hidden={!marker}>{marker}</span>
              <span className="rudder-markdown-patch-line-content">{content}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write failed.");
}

function getMarkdownImagePreviewName(image: HTMLImageElement) {
  const alt = image.alt.trim();
  if (alt) return alt;

  const src = image.currentSrc || image.src;
  try {
    const parsed = new URL(src, window.location.href);
    const basename = parsed.pathname.split("/").filter(Boolean).at(-1);
    return basename ? decodeURIComponent(basename) : "Image preview";
  } catch {
    return "Image preview";
  }
}

function markdownSourceAttributes(node: unknown) {
  const position = (node as {
    position?: {
      start?: { offset?: number };
      end?: { offset?: number };
    };
  } | null)?.position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return {};
  return {
    "data-markdown-source-start": String(start),
    "data-markdown-source-end": String(end),
  };
}

function closestMarkdownSourceElement(node: Node | null): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  return element?.closest<HTMLElement>("[data-markdown-source-start][data-markdown-source-end]") ?? null;
}

function markdownSourceSliceFromElement(source: string, element: HTMLElement) {
  const start = Number(element.dataset.markdownSourceStart);
  const end = Number(element.dataset.markdownSourceEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return source.slice(start, end);
}

function markdownSourceForSelection(root: HTMLElement, selection: Selection, source: string) {
  const startElement = closestMarkdownSourceElement(selection.anchorNode);
  const endElement = closestMarkdownSourceElement(selection.focusNode);
  if (startElement && startElement === endElement) {
    return markdownSourceSliceFromElement(source, startElement);
  }

  const range = selection.getRangeAt(0);
  const intersectingElements = Array.from(
    root.querySelectorAll<HTMLElement>("[data-markdown-source-start][data-markdown-source-end]"),
  ).filter((element) => {
    try {
      return range.intersectsNode(element);
    } catch {
      return false;
    }
  });
  const topLevelElements = intersectingElements.filter(
    (element) => !intersectingElements.some((candidate) => candidate !== element && candidate.contains(element)),
  );
  const sourceRanges = topLevelElements
    .map((element) => ({
      start: Number(element.dataset.markdownSourceStart),
      end: Number(element.dataset.markdownSourceEnd),
    }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
  if (sourceRanges.length === 0) return null;
  const start = Math.min(...sourceRanges.map((item) => item.start));
  const end = Math.max(...sourceRanges.map((item) => item.end));
  return source.slice(start, end);
}

function MermaidDiagramBlock({ source, darkMode }: { source: string; darkMode: boolean }) {
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: darkMode ? "dark" : "default",
          fontFamily: "inherit",
          suppressErrorRendering: true,
        });
        const rendered = await mermaid.render(`rudder-mermaid-${renderId}`, source);
        if (!active) return;
        setSvg(rendered.svg);
      })
      .catch((err) => {
        if (!active) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to render Mermaid diagram.";
        setError(message);
      });

    return () => {
      active = false;
    };
  }, [darkMode, renderId, source]);

  return (
    <div className="rudder-mermaid">
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <>
          <p className={cn("rudder-mermaid-status", error && "rudder-mermaid-status-error")}>
            {error ? `Unable to render Mermaid diagram: ${error}` : "Rendering Mermaid diagram..."}
          </p>
          <pre className="rudder-mermaid-source">
            <code className="language-mermaid">{source}</code>
          </pre>
        </>
      )}
    </div>
  );
}

function CopyableCodeBlock({
  children,
  copyText,
  preProps,
  sourceAttributes,
  block,
}: {
  children?: ReactNode;
  copyText: string;
  preProps: Record<string, unknown>;
  sourceAttributes: ReturnType<typeof markdownSourceAttributes>;
  block?: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tooltipLabel =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy code";

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  const handleCopy = useCallback(async () => {
    clearTimeout(resetTimerRef.current);
    try {
      await writeClipboardText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 1600);
  }, [copyText]);

  return (
    <div className="rudder-code-block-copy-wrap">
      {block ?? <pre {...preProps} {...sourceAttributes}>{children}</pre>}
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rudder-code-block-copy-button"
              aria-label={tooltipLabel}
              data-copy-state={copyState}
              onClick={() => void handleCopy()}
            >
              {copyState === "copied" ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={8}>
            {tooltipLabel}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function MarkdownBody({
  children,
  className,
  resolveImageSrc,
  onLinkClick,
  agentMentions,
  skillReferences,
  enableImagePreview = true,
  copyMarkdownOnCopy = false,
  enableCodeBlockCopy = false,
}: MarkdownBodyProps) {
  const { resolvedTheme } = useTheme();
  const { mentions } = useMarkdownMentions();
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const agentMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "agent")
      .map((mention) => [mention.agentId ?? mention.id.replace(/^agent:/, ""), mention] as const),
  );
  const projectMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "project" && mention.projectId)
      .map((mention) => [mention.projectId!, mention] as const),
  );
  const issueMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "issue" && mention.issueId)
      .map((mention) => [mention.issueId!, mention] as const),
  );
  const issueMentions = mentions.filter((mention) => mention.kind === "issue" && mention.issueId);
  const automationMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "automation" && mention.automationId)
      .map((mention) => [mention.automationId!, mention] as const),
  );
  const chatMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "chat" && mention.chatConversationId)
      .map((mention) => [mention.chatConversationId!, mention] as const),
  );
  const libraryDocMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "library_doc" && mention.libraryDocumentId)
      .map((mention) => [mention.libraryDocumentId!, mention] as const),
  );
  const libraryEntryMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "library_file" && mention.libraryEntryId)
      .map((mention) => [mention.libraryEntryId!, mention] as const),
  );
  const libraryFileMentionByPath = new Map(
    mentions
      .filter((mention) => mention.kind === "library_file" && mention.libraryFilePath)
      .map((mention) => [mention.libraryFilePath!, mention] as const),
  );
  const libraryDirectoryMentionByPath = new Map(
    mentions
      .filter((mention) => mention.kind === "library_directory" && mention.libraryDirectoryPath)
      .map((mention) => [mention.libraryDirectoryPath!, mention] as const),
  );
  const skillPreviewByHref = new Map(
    (skillReferences ?? [])
      .map((preview) => [normalizeSkillReferenceLookupKey(preview.href), preview] as const)
      .filter(([key]) => key.length > 0),
  );
  const skillPreviewByLabel = new Map(
    (skillReferences ?? [])
      .map((preview) => [normalizeSkillReferenceLookupKey(preview.label), preview] as const)
      .filter(([key]) => key.length > 0),
  );
  const organizationPrefix = currentOrganizationPrefixFromLocation();
  const normalizedChildren = linkBareAgentMentions(
    normalizeRenderedMarkdownSource(children),
    agentMentions,
  );
  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!copyMarkdownOnCopy) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    if (!event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
    const markdownSource = markdownSourceForSelection(event.currentTarget, selection, normalizedChildren)
      ?? normalizedChildren;
    event.clipboardData.setData("text/plain", markdownSource);
    event.preventDefault();
  };
  const handleMarkdownLinkClick = (event: MouseEvent<HTMLAnchorElement>, href: string, label: string) => {
    const handled = onLinkClick?.({ event, href, label });
    if (handled) {
      event.preventDefault();
      return;
    }
    if (event.defaultPrevented || !isPlainPrimaryClick(event)) return;

    const internalRoute = internalAppRouteFromHref(href, organizationPrefix);
    if (!internalRoute) return;
    event.preventDefault();
    navigateInternalAppRoute(internalRoute);
  };
  const handleImageInspect = (image: HTMLImageElement) => {
    if (!enableImagePreview) return;
    const src = image.currentSrc || image.src;
    if (!src) return;
    setImagePreview({
      alt: image.alt,
      name: getMarkdownImagePreviewName(image),
      src,
      naturalSize:
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null,
    });
  };
  const components: Components = {
    p: ({ node, children: paragraphChildren, ...paragraphProps }) => (
      <p {...paragraphProps} {...markdownSourceAttributes(node)}>{paragraphChildren}</p>
    ),
    h1: ({ node, children: headingChildren, ...headingProps }) => (
      <h1 {...headingProps} {...markdownSourceAttributes(node)}>{headingChildren}</h1>
    ),
    h2: ({ node, children: headingChildren, ...headingProps }) => (
      <h2 {...headingProps} {...markdownSourceAttributes(node)}>{headingChildren}</h2>
    ),
    h3: ({ node, children: headingChildren, ...headingProps }) => (
      <h3 {...headingProps} {...markdownSourceAttributes(node)}>{headingChildren}</h3>
    ),
    h4: ({ node, children: headingChildren, ...headingProps }) => (
      <h4 {...headingProps} {...markdownSourceAttributes(node)}>{headingChildren}</h4>
    ),
    h5: ({ node, children: headingChildren, ...headingProps }) => (
      <h5 {...headingProps} {...markdownSourceAttributes(node)}>{headingChildren}</h5>
    ),
    h6: ({ node, children: headingChildren, ...headingProps }) => (
      <h6 {...headingProps} {...markdownSourceAttributes(node)}>{headingChildren}</h6>
    ),
    li: ({ node, children: itemChildren, ...itemProps }) => (
      <li {...itemProps} {...markdownSourceAttributes(node)}>{itemChildren}</li>
    ),
    table: ({ node, children: tableChildren, ...tableProps }) => (
      <div className="rudder-markdown-table-scroll">
        <table {...tableProps} {...markdownSourceAttributes(node)}>{tableChildren}</table>
      </div>
    ),
    pre: ({ node, children: preChildren, ...preProps }) => {
      const mermaidSource = extractMermaidSource(preChildren);
      if (mermaidSource) {
        return <MermaidDiagramBlock source={mermaidSource} darkMode={resolvedTheme === "dark"} />;
      }
      const sourceAttributes = markdownSourceAttributes(node);
      const codeBlockLanguage = extractCodeBlockLanguage(preChildren);
      const patchSource = isPatchCodeBlockLanguage(codeBlockLanguage) ? extractCodeBlockSource(preChildren) : null;
      if (patchSource !== null) {
        const patchBlock = (
          <PatchCodeBlock
            source={patchSource}
            preProps={preProps}
            sourceAttributes={sourceAttributes}
          />
        );
        if (enableCodeBlockCopy) {
          return (
            <CopyableCodeBlock
              copyText={patchSource}
              preProps={{}}
              sourceAttributes={{}}
              block={patchBlock}
            />
          );
        }
        return patchBlock;
      }
      if (enableCodeBlockCopy) {
        return (
          <CopyableCodeBlock
            copyText={extractCodeBlockSource(preChildren)}
            preProps={preProps}
            sourceAttributes={sourceAttributes}
          >
            {preChildren}
          </CopyableCodeBlock>
        );
      }
      return <pre {...preProps} {...sourceAttributes}>{preChildren}</pre>;
    },
    a: ({ node, href, children: linkChildren }) => {
      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        const fallbackMentionLabel = mentionDisplayLabel(stripMentionChipLabelPrefix(flattenText(linkChildren)));
        const mention = (() => {
          if (parsed.kind === "agent") {
            return {
              ...parsed,
              icon: agentMentionById.get(parsed.agentId)?.agentIcon ?? parsed.icon,
            };
          }
          if (parsed.kind === "project") {
            const current = projectMentionById.get(parsed.projectId);
            return {
              ...parsed,
              color: current?.projectColor ?? parsed.color,
              icon: current?.projectIcon ?? parsed.icon,
            };
          }
          if (parsed.kind === "issue") {
            const current = issueMentionById.get(parsed.issueId)
              ?? matchingIssueMentionFromRouteRef(parsed.issueId, issueMentions)
              ?? matchingIssueMentionFromRouteRef(parsed.ref, issueMentions)
              ?? matchingIssueMentionFromRouteRef(issueRouteRefFromHref(href), issueMentions);
            return {
              ...parsed,
              issueId: parsed.issueId,
              ref: current?.issueIdentifier ?? parsed.ref,
              status: current?.issueStatus ?? parsed.status,
            };
          }
          return parsed;
        })();
        const mentionLabel = (() => {
          if (mention.kind === "agent") return agentMentionById.get(mention.agentId)?.name ?? fallbackMentionLabel;
          if (mention.kind === "project") return projectMentionById.get(mention.projectId)?.name ?? fallbackMentionLabel;
          if (mention.kind === "issue") {
            const currentIssue = issueMentionById.get(mention.issueId)
              ?? matchingIssueMentionFromRouteRef(mention.issueId, issueMentions)
              ?? matchingIssueMentionFromRouteRef(mention.ref, issueMentions);
            return (currentIssue?.name ?? fallbackMentionLabel ?? mention.ref?.trim() ?? "") || mention.ref?.trim() || mentionFallbackLabel(mention);
          }
          if (mention.kind === "automation") return automationMentionById.get(mention.automationId)?.name ?? mention.title?.trim() ?? fallbackMentionLabel;
          if (mention.kind === "chat") return chatMentionById.get(mention.conversationId)?.name ?? fallbackMentionLabel;
          if (mention.kind === "library_doc") return libraryDocMentionById.get(mention.documentId)?.name ?? fallbackMentionLabel;
          if (mention.kind === "library_entry") return libraryEntryMentionById.get(mention.entryId)?.name ?? fallbackMentionLabel;
          if (mention.kind === "library_file") return libraryFileMentionByPath.get(mention.filePath)?.name ?? fallbackMentionLabel;
          if (mention.kind === "library_directory") return libraryDirectoryMentionByPath.get(mention.directoryPath)?.name ?? fallbackMentionLabel;
          return fallbackMentionLabel;
        })() || mentionFallbackLabel(mention);
        const displayMentionLabel = mentionDisplayLabel(mentionLabel);
        const targetHref = applyOrganizationPrefix(mentionChipNavigationPath(mention), organizationPrefix);
        const mentionLink = (
          <a
            href={targetHref}
            className={cn(
              "rudder-mention-chip",
              `rudder-mention-chip--${mention.kind}`,
              mention.kind === "issue" && mention.status && "rudder-mention-chip--with-status-icon",
              mention.kind === "project" && "rudder-project-mention-chip",
            )}
            data-mention-kind={mention.kind}
            data-mention-comment={mention.kind === "issue" && mention.commentId ? "true" : undefined}
            data-mention-status={mention.kind === "issue" && mention.status ? mention.status : undefined}
            style={mentionChipInlineStyle(mention)}
            {...markdownSourceAttributes(node)}
            onClick={(event) => {
              handleMarkdownLinkClick(event, targetHref, displayMentionLabel);
            }}
          >
            {displayMentionLabel}
          </a>
        );
        if (mention.kind === "automation" || mention.kind === "chat") return mentionLink;
        return (
          <RudderEntityPreview mention={mention} label={displayMentionLabel}>
            {mentionLink}
          </RudderEntityPreview>
        );
      }
      const skillReference = parseSkillReference(href, flattenText(linkChildren));
      if (skillReference) {
        const preview =
          skillPreviewByHref.get(normalizeSkillReferenceLookupKey(skillReference.href))
          ?? skillPreviewByLabel.get(normalizeSkillReferenceLookupKey(skillReference.label))
          ?? null;
        const skillLabel = formatSkillReferenceDisplayLabel(preview?.label) || skillReference.label;
        return (
          <SkillReferenceToken label={skillLabel} preview={preview} />
        );
      }
      const linkLabel = flattenText(linkChildren);
      const isExternal = isExternalMarkdownHref(href);
      const websiteUrl = websiteUrlFromMarkdownHref(href);
      const isBareUrlLink = isExternal && isBareMarkdownUrlLabel(linkLabel);
      const internalHref = href ? internalAppRouteFromHref(href, organizationPrefix) : null;
      const internalIssueMention = matchingIssueMentionFromRouteRef(issueRouteRefFromHref(href), issueMentions);
      if (internalIssueMention && internalHref) {
        const mention: ParsedMentionChip = {
          kind: "issue",
          issueId: internalIssueMention.issueId!,
          ref: internalIssueMention.issueIdentifier ?? null,
          commentId: null,
          status: internalIssueMention.issueStatus ?? null,
        };
        const mentionLabel = mentionDisplayLabel(internalIssueMention.name || linkLabel || mentionFallbackLabel(mention));
        const mentionLink = (
          <a
            href={internalHref}
            className={cn(
              "rudder-mention-chip rudder-mention-chip--issue",
              mention.status && "rudder-mention-chip--with-status-icon",
            )}
            data-mention-kind="issue"
            data-mention-status={mention.status ?? undefined}
            {...markdownSourceAttributes(node)}
            onClick={(event) => {
              handleMarkdownLinkClick(event, internalHref, mentionLabel);
            }}
          >
            {mentionLabel}
          </a>
        );
        return (
          <RudderEntityPreview mention={mention} label={mentionLabel}>
            {mentionLink}
          </RudderEntityPreview>
        );
      }
      const renderedHref = internalHref && !isAbsoluteMarkdownHref(href) ? internalHref : href;
      if (websiteUrl) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            title={isBareUrlLink ? href : undefined}
            className="rudder-website-link"
            {...markdownSourceAttributes(node)}
            onClick={(event) => {
              if (!href) return;
              handleMarkdownLinkClick(event, href, linkLabel);
            }}
          >
            <WebsiteLinkIcon url={websiteUrl} />
            <span className="rudder-website-link-label">{linkChildren}</span>
          </a>
        );
      }
      return (
        <a
          href={renderedHref}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noreferrer noopener" : "noreferrer"}
          title={isBareUrlLink ? href : undefined}
          {...markdownSourceAttributes(node)}
          onClick={(event) => {
            if (!href) return;
            handleMarkdownLinkClick(event, internalHref ?? href, linkLabel);
          }}
        >
          {linkChildren}
        </a>
      );
    },
  };
  components.img = ({ node: _node, src, alt, ...imgProps }) => {
    const resolved = src && resolveImageSrc ? resolveImageSrc(src) : null;
    const imageSrc = resolved ?? src ?? "";
    if (enableImagePreview && imageSrc) {
      return (
        <InspectableImage
          {...imgProps}
          src={imageSrc}
          alt={alt ?? ""}
          name={alt?.trim() || "Markdown image"}
          onInspect={handleImageInspect}
        />
      );
    }
    return (
      <img
        {...imgProps}
        src={imageSrc}
        alt={alt ?? ""}
      />
    );
  };

  return (
    <>
      <div
        className={cn(
          "rudder-markdown prose prose-sm max-w-none break-words overflow-hidden",
          resolvedTheme === "dark" && "prose-invert",
          className,
        )}
        onCopyCapture={handleCopy}
        data-copy-markdown-source={copyMarkdownOnCopy ? "true" : undefined}
      >
        <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => url}>
          {normalizedChildren}
        </Markdown>
      </div>
      {enableImagePreview ? (
        <ImagePreviewDialog
          preview={imagePreview}
          onOpenChange={(open) => {
            if (!open) setImagePreview(null);
          }}
          testId="markdown-body-image-preview-dialog"
          titleFallback="Image preview"
        />
      ) : null}
    </>
  );
}
