import { Boxes, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MarkdownSkillReferencePreview {
  href: string;
  label?: string | null;
  displayName?: string | null;
  description?: string | null;
  detailsHref?: string | null;
}

interface SkillReferenceTokenProps {
  label: string;
  preview?: MarkdownSkillReferencePreview | null;
}

export function SkillReferenceToken({ label, preview }: SkillReferenceTokenProps) {
  const displayName = preview?.displayName?.trim() || label;
  const description = preview?.description?.trim() || null;
  const detailsHref = preview?.detailsHref?.trim() || null;
  const hasPreview = Boolean(description || detailsHref);

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
