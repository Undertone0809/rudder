import { WebsiteLinkIcon } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import type { ChatWorkManifestItem, ChatWorkManifestResponse } from "@rudderhq/shared";
import {
  BriefcaseBusiness,
  ChevronDown,
  CircleAlert,
  FileOutput,
  FileText,
  Link2,
  ListFilter,
  MessageSquare,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

export interface ChatWorkManifestProps {
  manifest: ChatWorkManifestResponse | null;
  loading: boolean;
  error: string | null;
  sidePanelOpen: boolean;
  wideOpen: boolean;
  onOpenItem(item: ChatWorkManifestItem): void;
  onJumpToMessage(messageId: string): void;
  onAddSource(): void;
  onOpenProject(projectId: string): void;
}

const COLLAPSED_ROWS = 2;

export function hasChatWorkManifestContent(manifest: ChatWorkManifestResponse | null | undefined) {
  if (!manifest) return false;
  const outputCount = Array.isArray(manifest.outputs) ? manifest.outputs.length : 0;
  const sourceCount = Array.isArray(manifest.sources) ? manifest.sources.length : 0;
  const referenceCount = Array.isArray(manifest.references) ? manifest.references.length : 0;
  return outputCount + sourceCount + referenceCount > 0
    || Boolean(manifest.project && manifest.project.totalCount > 0);
}

function websiteUrl(item: ChatWorkManifestItem) {
  if (item.targetType !== "external_url" || !item.url) return null;
  try {
    const url = new URL(item.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function ChatWorkManifestToggle({
  open,
  count,
  onToggle,
}: {
  open: boolean;
  count: number;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      data-testid="chat-work-manifest-wide-toggle"
      aria-label={open ? "Hide Work manifest" : "Show Work manifest"}
      aria-pressed={open}
      aria-expanded={open}
      aria-controls="chat-work-manifest-wide-panel"
      title={open ? "Hide Work manifest" : "Show Work manifest"}
      className={cn(
        "pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 xl:inline-flex",
        open && "bg-[color:var(--surface-active)] text-foreground",
      )}
      onClick={onToggle}
    >
      <ListFilter className="h-4 w-4" aria-hidden />
      <span className="sr-only">Work {count}</span>
    </button>
  );
}

function ManifestRow({
  item,
  onOpen,
  onJump,
}: {
  item: ChatWorkManifestItem;
  onOpen(): void;
  onJump(): void;
}) {
  const externalUrl = websiteUrl(item);
  return (
    <div className="group flex min-h-10 items-center gap-1">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1.5 text-left transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        onClick={onOpen}
        title={item.title}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-[calc(var(--radius-sm)-1px)] bg-muted/65 text-muted-foreground transition-colors group-hover:bg-background/65 group-hover:text-foreground">
          {externalUrl ? (
            <span className="text-sm">
              <WebsiteLinkIcon url={externalUrl} />
            </span>
          ) : item.category === "output" ? (
            <FileText className="size-3.5" aria-hidden="true" />
          ) : (
            <Paperclip className="size-3.5" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium leading-5 text-foreground">{item.title}</span>
          {externalUrl ? (
            <span className="block truncate text-[11px] leading-4 text-muted-foreground">{externalUrl.href}</span>
          ) : null}
        </span>
      </button>
      {item.messageId ? (
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-muted-foreground opacity-0 transition-[background-color,color,opacity] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 group-hover:opacity-100"
          onClick={onJump}
          aria-label={`Jump to source message for ${item.title}`}
          title="Jump to source message"
        >
          <MessageSquare className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ManifestSection({
  idPrefix,
  label,
  icon,
  items,
  onOpenItem,
  onJumpToMessage,
}: {
  idPrefix: string;
  label: string;
  icon: ReactNode;
  items: ChatWorkManifestItem[];
  onOpenItem(item: ChatWorkManifestItem): void;
  onJumpToMessage(messageId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visibleItems = expanded ? items : items.slice(0, COLLAPSED_ROWS);
  const sectionId = `${idPrefix}-${label.toLowerCase()}`;
  return (
    <section className="border-t border-border/50 px-2.5 py-2 first:border-t-0" aria-label={label}>
      <div className="flex h-7 items-center gap-2 px-1.5 text-[11px] font-medium text-muted-foreground">
        <span className="grid size-5 place-items-center" aria-hidden="true">{icon}</span>
        <span className="text-foreground/80">{label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground/80">{items.length}</span>
      </div>
      <div id={sectionId} className="mt-0.5 space-y-0.5" role="list">
        {visibleItems.map((item) => (
          <div key={item.id} role="listitem">
            <ManifestRow
              item={item}
              onOpen={() => onOpenItem(item)}
              onJump={() => item.messageId && onJumpToMessage(item.messageId)}
            />
          </div>
        ))}
      </div>
      {items.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          className="mt-1 flex h-7 w-full items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={sectionId}
        >
          {expanded ? "Show less" : `View all ${items.length}`}
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}

function ManifestContent({
  idPrefix,
  manifest,
  loading,
  error,
  onOpenItem,
  onJumpToMessage,
  onAddSource,
  onOpenProject,
}: Omit<ChatWorkManifestProps, "sidePanelOpen"> & { idPrefix: string }) {
  if (loading) return null;
  if (error) {
    return (
      <div className="flex items-start gap-2.5 border-t border-border/50 px-3.5 py-4 text-xs text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span className="leading-5">{error}</span>
      </div>
    );
  }
  const outputs = Array.isArray(manifest?.outputs) ? manifest.outputs : [];
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const references = Array.isArray(manifest?.references) ? manifest.references : [];
  if (!manifest || !hasChatWorkManifestContent(manifest)) return null;
  return (
    <>
      <ManifestSection
        idPrefix={idPrefix}
        label="Outputs"
        icon={<FileOutput className="size-3.5" aria-hidden="true" />}
        items={outputs}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
      <ManifestSection
        idPrefix={idPrefix}
        label="Sources"
        icon={<Paperclip className="size-3.5" aria-hidden="true" />}
        items={sources}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
      <ManifestSection
        idPrefix={idPrefix}
        label="References"
        icon={<Link2 className="size-3.5" aria-hidden="true" />}
        items={references}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
      {manifest.project ? (
        <button
          type="button"
          className="flex min-h-10 w-full items-center gap-2 border-t border-border/50 px-4 py-2.5 text-left transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
          onClick={() => onOpenProject(manifest.project!.id)}
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-[calc(var(--radius-sm)-1px)] bg-muted/65 text-muted-foreground">
            <BriefcaseBusiness className="size-3.5" aria-hidden="true" />
          </span>
          <span className="text-xs font-medium text-foreground">Project work</span>
          <span className="ml-auto pr-1 text-[11px] tabular-nums text-muted-foreground">{manifest.project.totalCount} items</span>
        </button>
      ) : null}
    </>
  );
}

export function ChatWorkManifest(props: ChatWorkManifestProps) {
  const [compactOpen, setCompactOpen] = useState(false);
  if (props.sidePanelOpen || props.loading || (!props.error && !hasChatWorkManifestContent(props.manifest))) return null;
  const count = props.manifest?.totalCount ?? 0;
  return (
    <div className="pointer-events-none relative z-20 shrink-0" data-testid="chat-work-manifest">
      <aside
        className={cn(
          "hidden w-72 origin-top-right overflow-hidden rounded-[var(--radius-md)] border border-border/65 bg-[color:var(--surface-overlay)] shadow-md transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none xl:block",
          props.wideOpen
            ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
            : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0",
        )}
        id="chat-work-manifest-wide-panel"
        aria-label="Work manifest"
        aria-hidden={!props.wideOpen}
        inert={props.wideOpen ? undefined : true}
        data-testid="chat-work-manifest-wide-panel"
        data-state={props.wideOpen ? "open" : "closed"}
      >
        <div className="flex h-11 items-center border-b border-border/55 px-3.5">
          <span className="text-xs font-semibold text-foreground">Work</span>
          <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
          <button type="button" className="ml-auto grid size-7 place-items-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" onClick={props.onAddSource} aria-label="Add source" title="Add source">
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </div>
        <ManifestContent {...props} idPrefix="chat-work-manifest-wide" />
      </aside>

      <button
        type="button"
        className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border/70 bg-[color:var(--surface-overlay)] px-2.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 xl:hidden"
        onClick={() => setCompactOpen((value) => !value)}
        data-testid="chat-work-manifest-trigger"
        aria-expanded={compactOpen}
        aria-controls="chat-work-manifest-compact-panel"
      >
        <BriefcaseBusiness className="size-3.5" aria-hidden="true" />
        Work {count}
      </button>
      {compactOpen ? (
        <div
          id="chat-work-manifest-compact-panel"
          className="pointer-events-auto absolute right-0 top-10 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-md)] border border-border/65 bg-[color:var(--surface-overlay)] shadow-md xl:hidden"
          data-testid="chat-work-manifest-compact-panel"
        >
          <div className="flex h-11 items-center border-b border-border/55 px-3.5">
            <span className="text-xs font-semibold">Work</span>
            <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
            <button type="button" className="ml-auto grid size-7 place-items-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" onClick={() => setCompactOpen(false)} aria-label="Close work manifest">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <ManifestContent {...props} idPrefix="chat-work-manifest-compact" />
        </div>
      ) : null}
    </div>
  );
}
