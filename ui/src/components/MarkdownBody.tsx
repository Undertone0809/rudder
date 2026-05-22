import { isValidElement, useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { useTheme } from "../context/ThemeContext";
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
  skillReferences?: MarkdownSkillReferencePreview[];
  enableImagePreview?: boolean;
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

function isExternalMarkdownHref(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return true;
  if (!/^[a-z][a-z\d+.-]*:/iu.test(trimmed)) return false;

  try {
    const parsed = new URL(trimmed);
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
  skillReferences,
  enableImagePreview = true,
}: MarkdownBodyProps) {
  const { resolvedTheme } = useTheme();
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
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
  const normalizedChildren = normalizeEscapedMarkdownNewlines(children);
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
    pre: ({ node: _node, children: preChildren, ...preProps }) => {
      const mermaidSource = extractMermaidSource(preChildren);
      if (mermaidSource) {
        return <MermaidDiagramBlock source={mermaidSource} darkMode={resolvedTheme === "dark"} />;
      }
      return <pre {...preProps}>{preChildren}</pre>;
    },
    a: ({ href, children: linkChildren }) => {
      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        const mentionLabel = stripMentionChipLabelPrefix(flattenText(linkChildren));
        const targetHref = parsed.kind === "project"
          ? `/projects/${parsed.projectId}`
          : parsed.kind === "issue"
            ? `/issues/${parsed.ref ?? parsed.issueId}`
            : `/agents/${parsed.agentId}`;
        return (
          <a
            href={targetHref}
            className={cn(
              "rudder-mention-chip",
              `rudder-mention-chip--${parsed.kind}`,
              parsed.kind === "project" && "rudder-project-mention-chip",
            )}
            data-mention-kind={parsed.kind}
            style={mentionChipInlineStyle(parsed)}
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
