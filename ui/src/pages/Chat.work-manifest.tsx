import { WebsiteLinkIcon } from "@/components/MarkdownBody";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { cn } from "@/lib/utils";
import type { ChatWorkManifestItem, ChatWorkManifestResponse } from "@rudderhq/shared";
import {
  ChevronDown,
  FileOutput,
  Link2,
  ListFilter,
  MessageSquare,
  Paperclip,
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
      aria-label={open ? "Hide conversation files and links" : "Show conversation files and links"}
      aria-pressed={open}
      aria-expanded={open}
      aria-controls="chat-work-manifest-wide-panel"
      title={open ? "Hide conversation files and links" : "Show conversation files and links"}
      className={cn(
        "pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 xl:inline-flex",
        open && "bg-[color:var(--surface-active)] text-foreground",
      )}
      onClick={onToggle}
    >
      <ListFilter className="h-4 w-4" aria-hidden />
      <span className="sr-only">Conversation files and links {count}</span>
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
  fixedHeader = false,
  reserveActionSpace = false,
  onOpenItem,
  onJumpToMessage,
}: {
  label: string;
  icon: ReactNode;
  items: ChatWorkManifestItem[];
  fixedHeader?: boolean;
  reserveActionSpace?: boolean;
  onOpenItem(item: ChatWorkManifestItem): void;
  onJumpToMessage(messageId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visibleItems = expanded ? items : items.slice(0, COLLAPSED_ROWS);
  return (
    <section aria-label={label} className={cn(!fixedHeader && "border-t border-border/70 first:border-t-0")}>
      {fixedHeader ? null : (
        <ManifestSectionHeader
          label={label}
          icon={icon}
          count={items.length}
          reserveActionSpace={reserveActionSpace}
        />
      )}
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

function ManifestSectionHeader({
  label,
  icon,
  count,
  action,
  reserveActionSpace = false,
}: {
  label: string;
  icon: ReactNode;
  count: number;
  action?: ReactNode;
  reserveActionSpace?: boolean;
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border/55 bg-muted/25 px-3 text-[11px] font-semibold text-muted-foreground"
      data-testid={`chat-work-manifest-section-header-${label.toLowerCase()}`}
    >
      {icon}
      <span>{label}</span>
      <span
        className="ml-auto tabular-nums"
        data-testid={`chat-work-manifest-section-count-${label.toLowerCase()}`}
      >
        {count}
      </span>
      {reserveActionSpace ? (
        <span className="-mr-1 ml-1 flex size-7 shrink-0 items-center justify-center" aria-hidden={action ? undefined : true}>
          {action}
        </span>
      ) : action}
    </div>
  );
}

function ManifestStatusHeader({ action }: { action?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-3">
      <span className="text-xs font-semibold text-foreground">Conversation items</span>
      {action ? <span className="ml-auto flex">{action}</span> : null}
    </div>
  );
}

function ManifestContent({
  manifest,
  loading,
  error,
  onOpenItem,
  onJumpToMessage,
  fixedSectionLabel,
  reserveActionSpace = false,
}: Omit<ChatWorkManifestProps, "sidePanelOpen"> & {
  fixedSectionLabel: string | null;
  reserveActionSpace?: boolean;
}) {
  const scrollRef = useScrollbarActivityRef();
  if (loading) return null;
  if (error) return <div className="px-3 py-6 text-center text-xs text-destructive">{error}</div>;
  const outputs = Array.isArray(manifest?.outputs) ? manifest.outputs : [];
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const references = Array.isArray(manifest?.references) ? manifest.references : [];
  if (!manifest || !hasChatWorkManifestContent(manifest)) return null;
  return (
    <div
      ref={scrollRef}
      className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain"
      data-testid="chat-work-manifest-scroll-region"
    >
      <ManifestSection
        label="Outputs"
        icon={<FileOutput className="size-3.5" aria-hidden="true" />}
        items={outputs}
        fixedHeader={fixedSectionLabel === "Outputs"}
        reserveActionSpace={reserveActionSpace}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
      <ManifestSection
        label="Sources"
        icon={<Paperclip className="size-3.5" aria-hidden="true" />}
        items={sources}
        fixedHeader={fixedSectionLabel === "Sources"}
        reserveActionSpace={reserveActionSpace}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
      <ManifestSection
        label="References"
        icon={<Link2 className="size-3.5" aria-hidden="true" />}
        items={references}
        fixedHeader={fixedSectionLabel === "References"}
        reserveActionSpace={reserveActionSpace}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
      />
    </div>
  );
}

export function ChatWorkManifest(props: ChatWorkManifestProps) {
  const [compactOpen, setCompactOpen] = useState(false);
  if (props.sidePanelOpen || props.loading || (!props.error && !hasChatWorkManifestContent(props.manifest))) return null;
  const outputs = Array.isArray(props.manifest?.outputs) ? props.manifest.outputs : [];
  const sources = Array.isArray(props.manifest?.sources) ? props.manifest.sources : [];
  const references = Array.isArray(props.manifest?.references) ? props.manifest.references : [];
  const fixedSection = outputs.length > 0
    ? { label: "Outputs", count: outputs.length, icon: <FileOutput className="size-3.5" aria-hidden="true" /> }
    : sources.length > 0
      ? { label: "Sources", count: sources.length, icon: <Paperclip className="size-3.5" aria-hidden="true" /> }
      : references.length > 0
        ? { label: "References", count: references.length, icon: <Link2 className="size-3.5" aria-hidden="true" /> }
        : null;
  const fixedSectionLabel = fixedSection?.label ?? null;
  const closeCompactPanel = (
    <button
      type="button"
      className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => setCompactOpen(false)}
      aria-label="Close conversation files and links"
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  );
  return (
    <div className="pointer-events-none relative z-20 shrink-0" data-testid="chat-work-manifest">
      <aside
        className={cn(
          "hidden max-h-[calc(100dvh-5rem)] w-72 origin-top-right flex-col overflow-hidden rounded-md border border-border/75 bg-background/96 shadow-sm transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none xl:flex",
          props.wideOpen
            ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
            : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0",
        )}
        id="chat-work-manifest-wide-panel"
        aria-label="Conversation files and links"
        aria-hidden={!props.wideOpen}
        inert={props.wideOpen ? undefined : true}
        data-testid="chat-work-manifest-wide-panel"
        data-state={props.wideOpen ? "open" : "closed"}
      >
        {fixedSection ? (
          <ManifestSectionHeader {...fixedSection} />
        ) : (
          <ManifestStatusHeader />
        )}
        <ManifestContent
          key={`wide:${props.manifest?.conversationId ?? "error"}`}
          {...props}
          fixedSectionLabel={fixedSectionLabel}
        />
      </aside>

      <button
        type="button"
        className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground shadow-sm xl:hidden"
        onClick={() => setCompactOpen((value) => !value)}
        data-testid="chat-work-manifest-trigger"
        aria-expanded={compactOpen}
        aria-controls="chat-work-manifest-compact-panel"
      >
        <ListFilter className="size-3.5" aria-hidden="true" />
        {fixedSection ? `${fixedSection.label} ${fixedSection.count}` : "Conversation items"}
      </button>
      {compactOpen ? (
        <div
          className="pointer-events-auto absolute right-0 top-10 flex max-h-[calc(100dvh-6rem)] w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-md border border-border bg-background shadow-lg xl:hidden"
          id="chat-work-manifest-compact-panel"
          data-testid="chat-work-manifest-compact-panel"
          role="complementary"
          aria-label="Conversation files and links"
        >
          {fixedSection ? (
            <ManifestSectionHeader {...fixedSection} action={closeCompactPanel} reserveActionSpace />
          ) : (
            <ManifestStatusHeader action={closeCompactPanel} />
          )}
          <ManifestContent
            key={`compact:${props.manifest?.conversationId ?? "error"}`}
            {...props}
            fixedSectionLabel={fixedSectionLabel}
            reserveActionSpace
          />
        </div>
      ) : null}
    </div>
  );
}
