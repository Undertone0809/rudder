import { useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { readDesktopShell, type DesktopLocalFilePreview } from "../lib/desktop-shell";
import { isPreviewableImage } from "../lib/image-actions";
import { localFileIconDescriptor } from "../lib/local-file-icons";
import { resolveLocalFileDisplayTarget, resolveLocalFileTarget } from "../lib/local-file-targets";
import { InspectableImage } from "./InspectableImage";

type MarkdownSourceAttributes = Record<string, string | undefined>;

function localImagePreviewDataUrl(preview: DesktopLocalFilePreview) {
  const contentType = preview.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (preview.previewKind !== "image" || !contentType.startsWith("image/") || !preview.base64) return null;
  return `data:${contentType};base64,${preview.base64}`;
}

export function LocalFileLinkIcon({ filePath }: { filePath: string }) {
  const { Icon, kind } = localFileIconDescriptor(filePath);
  return <Icon className="mr-1 inline-block size-[0.95em] align-[-0.12em]" data-local-file-icon={kind} aria-hidden="true" />;
}

function MarkdownLocalImageLink({
  children,
  enablePreview,
  href,
  imageName,
  onClick,
  sourceAttributes,
  targetPath,
}: {
  children: ReactNode;
  enablePreview: boolean;
  href: string;
  imageName: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  sourceAttributes: MarkdownSourceAttributes;
  targetPath: string;
}) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewSrc(null);
    const desktopShell = readDesktopShell();
    if (!desktopShell) return undefined;

    void desktopShell.previewLocalFile(targetPath)
      .then((preview) => {
        if (cancelled) return;
        const dataUrl = localImagePreviewDataUrl(preview);
        if (dataUrl) setPreviewSrc(dataUrl);
      })
      .catch(() => {
        // Keep the original local-file link when the file is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, [targetPath]);

  if (!previewSrc) {
    return (
      <a
        href={href}
        className="rudder-local-file-link"
        title={imageName || undefined}
        {...sourceAttributes}
        onClick={onClick}
      >
        <LocalFileLinkIcon filePath={targetPath} />
        <span className="rudder-inline-token-label">{children}</span>
      </a>
    );
  }

  if (!enablePreview) {
    return (
      <img
        {...sourceAttributes}
        src={previewSrc}
        alt={imageName}
        className="rudder-local-image-media"
      />
    );
  }

  return (
    <InspectableImage
      {...sourceAttributes}
      src={previewSrc}
      alt={imageName}
      name={imageName}
      className="rudder-local-image-media"
      wrapperClassName="rudder-local-image"
      triggerClassName="rudder-local-image-trigger"
      previewTestId="markdown-body-image-preview-dialog"
      previewTitleFallback="Image preview"
    />
  );
}

export function MarkdownLocalFileLink({
  children,
  filePath,
  href,
  label,
  onClick,
  sourceAttributes,
}: {
  children: ReactNode;
  filePath: string;
  href: string;
  label: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  sourceAttributes: MarkdownSourceAttributes;
}) {
  if (isPreviewableImage(null, filePath)) {
    const imageName = label.trim() || filePath.split(/[\\/]/u).at(-1) || "Local image";
    return (
      <MarkdownLocalImageLink
        href={href}
        enablePreview={true}
        imageName={imageName}
        targetPath={filePath}
        sourceAttributes={sourceAttributes}
        onClick={onClick}
      >
        {children}
      </MarkdownLocalImageLink>
    );
  }

  return (
    <a
      href={href}
      className="rudder-local-file-link"
      title={label || undefined}
      {...sourceAttributes}
      onClick={onClick}
    >
      <LocalFileLinkIcon filePath={filePath} />
      <span className="rudder-inline-token-label">{children}</span>
    </a>
  );
}

export function renderMarkdownLocalImage({
  alt,
  enablePreview,
  onClick,
  sourceAttributes,
  src,
}: {
  alt?: string | null;
  enablePreview: boolean;
  onClick: (event: MouseEvent<HTMLAnchorElement>, imageName: string) => void;
  sourceAttributes: MarkdownSourceAttributes;
  src: string;
}): ReactElement | null {
  const targetPath = resolveLocalFileTarget(src, alt ?? "");
  const displayPath = resolveLocalFileDisplayTarget(src, alt ?? "");
  if (!targetPath || !displayPath) return null;

  const imageName = alt?.trim() || displayPath.split(/[\\/]/u).at(-1) || "Local image";
  if (!isPreviewableImage(null, displayPath)) {
    return (
      <MarkdownLocalFileLink
        href={src}
        filePath={displayPath}
        label={imageName}
        sourceAttributes={sourceAttributes}
        onClick={(event) => onClick(event, imageName)}
      >
        {imageName}
      </MarkdownLocalFileLink>
    );
  }

  return (
    <MarkdownLocalImageLink
      href={src}
      enablePreview={enablePreview}
      imageName={imageName}
      targetPath={targetPath}
      sourceAttributes={sourceAttributes}
      onClick={(event) => onClick(event, imageName)}
    >
      {imageName}
    </MarkdownLocalImageLink>
  );
}
