import { Boxes, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MarkdownSkillReferencePreview {
  href: string;
  label?: string | null;
  displayName?: string | null;
  description?: string | null;
  categoryLabel?: string | null;
  locationLabel?: string | null;
  detailsHref?: string | null;
}

interface SkillReferenceTokenProps {
  label: string;
  preview?: MarkdownSkillReferencePreview | null;
}

export function SkillReferenceToken({ label, preview }: SkillReferenceTokenProps) {
  const displayName = preview?.displayName?.trim() || label;
  const description = preview?.description?.trim() || null;
  const categoryLabel = preview?.categoryLabel?.trim() || null;
  const locationLabel = preview?.locationLabel?.trim() || null;
  const detailsHref = preview?.detailsHref?.trim() || null;
  const hasPreview = Boolean(description || categoryLabel || locationLabel || detailsHref);

  return (
    <span className={cn("rudder-skill-token-wrap", hasPreview && "rudder-skill-token-wrap--preview")}>
      <span
        className="rudder-skill-token"
        data-skill-token="true"
        tabIndex={hasPreview ? 0 : undefined}
        aria-label={hasPreview ? `${displayName} skill` : undefined}
      >
        {label}
      </span>
      {hasPreview ? (
        <span className="rudder-skill-hover-card" role="tooltip">
          <span className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[#2f80ed]/10 text-[#2f80ed]">
              <Boxes className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{displayName}</span>
              {(categoryLabel || locationLabel) ? (
                <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                  {categoryLabel ? (
                    <span className="inline-flex items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
                      {categoryLabel}
                    </span>
                  ) : null}
                  {locationLabel ? (
                    <span className="min-w-0 truncate text-[11px] leading-none text-muted-foreground">
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
