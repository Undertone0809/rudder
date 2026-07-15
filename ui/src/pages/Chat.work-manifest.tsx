import { WebsiteLinkIcon } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import type { ChatWorkManifestItem, ChatWorkManifestResponse } from "@rudderhq/shared";
import {
  BriefcaseBusiness,
  ChevronDown,
  FileOutput,
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
}

const COLLAPSED_ROWS = 2;

export function hasChatWorkManifestContent(manifest: ChatWorkManifestResponse | null | undefined) {
  if (!manifest) return false;
  const outputCount = Array.isArray(manifest.outputs) ? manifest.outputs.length : 0;
  const sourceCount = Array.isArray(manifest.sources) ? manifest.sources.length : 0;
  const referenceCount = Array.isArray(manifest.references) ? manifest.references.length : 0;
  return outputCount + sourceCount + referenceCount > 0;
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
    <div className="group flex min-h-11 items-center gap-2 border-t border-border/55 px-3 first:border-t-0">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
        onClick={onOpen}
        title={item.title}
      >
        {externalUrl ? (
          <span className="shrink-0 text-sm text-muted-foreground">
            <WebsiteLinkIcon url={externalUrl} />
          </span>
        ) : (
          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{item.title}</span>
          {externalUrl ? (
            <span className="block truncate text-[11px] text-muted-foreground">{externalUrl.href}</span>
          ) : null}
        </span>
      </button>
      {item.messageId ? (
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
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
  label,
  icon,
  items,
  onOpenItem,
  onJumpToMessage,
}: {
  label: string;
  icon: ReactNode;
  items: ChatWorkManifestItem[];
  onOpenItem(item: ChatWorkManifestItem): void;
  onJumpToMessage(messageId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visibleItems = expanded ? items : items.slice(0, COLLAPSED_ROWS);
  return (
    <section aria-label={label}>
      <div className="flex h-9 items-center gap-2 border-t border-border/70 bg-muted/25 px-3 text-[11px] font-semibold text-muted-foreground first:border-t-0">
        {icon}
        <span>{label}</span>
        <span className="ml-auto tabular-nums">{items.length}</span>
      </div>
      <div>
        {visibleItems.map((item) => (
          <ManifestRow
            key={item.id}
            item={item}
            onOpen={() => onOpenItem(item)}
            onJump={() => item.messageId && onJumpToMessage(item.messageId)}
          />
        ))}
      </div>
      {items.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          className="flex h-8 w-full items-center justify-center gap-1 border-t border-border/55 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `View all ${items.length}`}
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </button>
      ) : null}
    </section>
  );
}

function ManifestContent({
  manifest,
  loading,
  error,
  onOpenItem,
  onJumpToMessage,
  onAddSource,
}: Omit<ChatWorkManifestProps, "sidePanelOpen">) {
  if (loading) return null;
  if (error) return <div className="px-3 py-6 text-center text-xs text-destructive">{error}</div>;
  const outputs = Array.isArray(manifest?.outputs) ? manifest.outputs : [];
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const references = Array.isArray(manifest?.references) ? manifest.references : [];
  if (!manifest || !hasChatWorkManifestContent(manifest)) return null;
  return (
    <>
      <ManifestSection
        label="Outputs"
        icon={<FileOutput className="size-3.5" aria-hidden="true" />}
        items={outputs}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
      <ManifestSection
        label="Sources"
        icon={<Paperclip className="size-3.5" aria-hidden="true" />}
        items={sources}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
      <ManifestSection
        label="References"
        icon={<Link2 className="size-3.5" aria-hidden="true" />}
        items={references}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
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
          "hidden w-72 origin-top-right overflow-hidden rounded-md border border-border/75 bg-background/96 shadow-sm transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none xl:block",
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
        <div className="flex h-10 items-center border-b border-border/70 px-3">
          <span className="text-xs font-semibold text-foreground">Work</span>
          <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
          <button type="button" className="ml-auto grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onAddSource} aria-label="Add source" title="Add source">
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <ManifestContent {...props} />
      </aside>

      <button
        type="button"
        className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground shadow-sm xl:hidden"
        onClick={() => setCompactOpen((value) => !value)}
        data-testid="chat-work-manifest-trigger"
        aria-expanded={compactOpen}
      >
        <BriefcaseBusiness className="size-3.5" aria-hidden="true" />
        Work {count}
      </button>
      {compactOpen ? (
        <div
          className="pointer-events-auto absolute right-0 top-10 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-border bg-background shadow-lg xl:hidden"
          data-testid="chat-work-manifest-compact-panel"
        >
          <div className="flex h-10 items-center border-b border-border/70 px-3">
            <span className="text-xs font-semibold">Work</span>
            <button type="button" className="ml-auto grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted" onClick={() => setCompactOpen(false)} aria-label="Close work manifest">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <ManifestContent {...props} />
        </div>
      ) : null}
    </div>
  );
}
