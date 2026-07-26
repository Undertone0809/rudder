import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE } from "@/lib/chat-response-annotation-selection";
import { skillTokenIconInlineStyle } from "@/lib/skill-reference";
import { cn } from "@/lib/utils";
import { ArrowUpRight, Boxes } from "lucide-react";
import type { MouseEvent } from "react";

export interface MarkdownSkillReferencePreview {
  href: string;
  label?: string | null;
  displayName?: string | null;
  description?: string | null;
  categoryLabel?: string | null;
  locationLabel?: string | null;
  detailsHref?: string | null;
  openHref?: string | null;
}

interface SkillReferenceTokenProps {
  label: string;
  preview?: MarkdownSkillReferencePreview | null;
  fallbackOpenHref?: string | null;
  sourceAttributes?: Record<string, string | undefined>;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, href: string, label: string) => void;
}

export function SkillReferenceToken({
  label,
  preview,
  fallbackOpenHref,
  sourceAttributes,
  onOpen,
}: SkillReferenceTokenProps) {
  const displayName = preview?.displayName?.trim() || label;
  const description = preview?.description?.trim() || null;
  const categoryLabel = preview?.categoryLabel?.trim() || null;
  const locationLabel = preview?.locationLabel?.trim() || null;
  const detailsHref = preview?.detailsHref?.trim() || null;
  const openHref = fallbackOpenHref?.trim() || preview?.openHref?.trim() || null;
  const hasPreview = Boolean(description || categoryLabel || locationLabel || detailsHref);
  const hoverCardScrollRef = useScrollbarActivityRef();
  const tokenHref = onOpen ? (openHref ?? detailsHref) : detailsHref;
  const tokenContent = tokenHref ? (
    <a
      className="rudder-skill-token"
      data-skill-token="true"
      href={tokenHref}
      aria-label={`${displayName} skill`}
      style={skillTokenIconInlineStyle()}
      {...sourceAttributes}
      onClick={(event) => onOpen?.(event, tokenHref, displayName)}
    >
      {label}
    </a>
  ) : (
    <span
      className="rudder-skill-token"
      data-skill-token="true"
      tabIndex={hasPreview ? 0 : undefined}
      aria-label={hasPreview ? `${displayName} skill` : undefined}
      style={skillTokenIconInlineStyle()}
      {...sourceAttributes}
    >
      {label}
    </span>
  );

  return (
    <span className={cn("rudder-skill-token-wrap", hasPreview && "rudder-skill-token-wrap--preview")}>
      {tokenContent}
      {hasPreview ? (
        <span
          ref={hoverCardScrollRef}
          className="rudder-skill-hover-card scrollbar-auto-hide"
          role="tooltip"
          {...{ [CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE]: "" }}
        >
          <span className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[#2f80ed]/10 text-[#2f80ed]">
              <Boxes className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium leading-5 text-foreground">{displayName}</span>
              {(categoryLabel || locationLabel) ? (
                <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                  {categoryLabel ? (
                    <span className="inline-flex items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
                      {categoryLabel}
                    </span>
                  ) : null}
                  {locationLabel ? (
                    <span className="min-w-0 break-all text-[11px] leading-4 text-muted-foreground">
                      {locationLabel}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {description ? (
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {description}
                </span>
              ) : null}
            </span>
          </span>
          {detailsHref ? (
            <a className="rudder-skill-hover-card-action" href={detailsHref}>
              <span>View details</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
