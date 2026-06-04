import { isValidElement, useEffect, useId, useState, type ClipboardEvent, type MouseEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildAgentMentionHref } from "@rudderhq/shared";
import { cn } from "../lib/utils";
import { useTheme } from "../context/ThemeContext";
import { useMarkdownMentions } from "../context/MarkdownMentionsContext";
import { mentionChipInlineStyle, parseMentionChipHref, stripMentionChipLabelPrefix } from "../lib/mention-chips";
import { parseSkillReference } from "../lib/skill-reference";
import { ImagePreviewDialog, type ImagePreviewState } from "./ImagePreviewDialog";
import { InspectableImage } from "./InspectableImage";
import { SkillReferenceToken, type MarkdownSkillReferencePreview } from "./SkillReferenceToken";

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
  return "";
}

function normalizeSkillReferenceLookupKey(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/u, "").toLowerCase() ?? "";
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

function isBareMarkdownUrlLabel(label: string) {
  const normalizedLabel = label.trim();
  return /^(?:https?:\/\/|www\.|\/\/)/iu.test(normalizedLabel);
}

function extractMermaidSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const childProps = children.props as { className?: unknown; children?: ReactNode };
  if (typeof childProps.className !== "string") return null;
  if (!/\blanguage-mermaid\b/i.test(childProps.className)) return null;
  return flattenText(childProps.children).replace(/\n$/, "");
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

export function normalizeEscapedMarkdownNewlines(source: string) {
  if (!source.includes("\\n")) return source;
  const escapedNewlineCount = source.match(/\\n/g)?.length ?? 0;
  if (escapedNewlineCount === 0) return source;

  const realNewlineCount = source.match(/\n/g)?.length ?? 0;
  const hasEscapedParagraph = source.includes("\\n\\n");
  const hasEscapedMarkdownList = /\\n\s*(?:[-*+]\s|\d+\.\s)/.test(source);
  const looksLikeEscapedBlock = realNewlineCount === 0 && escapedNewlineCount >= 3;

  if (!hasEscapedParagraph && !hasEscapedMarkdownList && !looksLikeEscapedBlock) {
    return source;
  }

  return source
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
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

export function MarkdownBody({
  children,
  className,
  resolveImageSrc,
  onLinkClick,
  agentMentions,
  skillReferences,
  enableImagePreview = true,
  copyMarkdownOnCopy = false,
}: MarkdownBodyProps) {
  const { resolvedTheme } = useTheme();
  const { mentions } = useMarkdownMentions();
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const agentMentionById = new Map(
    mentions
      .filter((mention) => mention.kind === "agent")
      .map((mention) => [mention.agentId ?? mention.id.replace(/^agent:/, ""), mention] as const),
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
  const normalizedChildren = linkBareAgentMentions(
    normalizeEscapedMarkdownNewlines(children),
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
    pre: ({ node, children: preChildren, ...preProps }) => {
      const mermaidSource = extractMermaidSource(preChildren);
      if (mermaidSource) {
        return <MermaidDiagramBlock source={mermaidSource} darkMode={resolvedTheme === "dark"} />;
      }
      return <pre {...preProps} {...markdownSourceAttributes(node)}>{preChildren}</pre>;
    },
    a: ({ node, href, children: linkChildren }) => {
      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        const mention = parsed.kind === "agent"
          ? {
              ...parsed,
              icon: agentMentionById.get(parsed.agentId)?.agentIcon ?? parsed.icon,
            }
          : parsed;
        const mentionLabel = stripMentionChipLabelPrefix(flattenText(linkChildren));
        const targetHref = mention.kind === "project"
          ? `/projects/${mention.projectId}`
          : mention.kind === "issue"
            ? `/issues/${mention.ref ?? mention.issueId}`
            : mention.kind === "chat"
              ? `/messenger/chat/${mention.conversationId}`
              : mention.kind === "library_doc"
                ? `/library?doc=${encodeURIComponent(mention.documentId)}`
                : mention.kind === "library_file"
                  ? `/library?path=${encodeURIComponent(mention.filePath)}`
                  : mention.kind === "library_directory"
                    ? `/library?directory=${encodeURIComponent(mention.directoryPath)}`
                  : `/agents/${mention.agentId}`;
        return (
          <a
            href={targetHref}
            title={`Open ${mentionLabel}`}
            className={cn(
              "rudder-mention-chip",
              `rudder-mention-chip--${mention.kind}`,
              mention.kind === "project" && "rudder-project-mention-chip",
            )}
            data-mention-kind={mention.kind}
            style={mentionChipInlineStyle(mention)}
            {...markdownSourceAttributes(node)}
          >
            {mentionLabel}
          </a>
        );
      }
      const skillReference = parseSkillReference(href, flattenText(linkChildren));
      if (skillReference) {
        const preview =
          skillPreviewByHref.get(normalizeSkillReferenceLookupKey(skillReference.href))
          ?? skillPreviewByLabel.get(normalizeSkillReferenceLookupKey(skillReference.label))
          ?? null;
        return (
          <SkillReferenceToken label={skillReference.label} preview={preview} />
        );
      }
      const linkLabel = flattenText(linkChildren);
      const isExternal = isExternalMarkdownHref(href);
      const isBareUrlLink = isExternal && isBareMarkdownUrlLabel(linkLabel);
      return (
        <a
          href={href}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noreferrer noopener" : "noreferrer"}
          title={isBareUrlLink ? href : undefined}
          {...markdownSourceAttributes(node)}
          onClick={(event) => {
            if (!href || !onLinkClick) return;
            onLinkClick({ event, href, label: linkLabel });
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
