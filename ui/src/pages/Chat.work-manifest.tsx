import { WebsiteLinkIcon } from "@/components/MarkdownBody";
import { StatusIcon } from "@/components/StatusIcon";
import { getTranscriptAgentAvatarImageSrc } from "@/components/transcript/TranscriptAgentAvatarIcon";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { isPreviewableImage } from "@/lib/image-actions";
import { cn } from "@/lib/utils";
import { isWorkspaceHtmlFilePath } from "@/lib/workspace-html-preview";
import type { ChatWorkManifestItem, ChatWorkManifestResponse, ChatWorkManifestSubagents } from "@rudderhq/shared";
import {
  Bot,
  ChevronDown,
  CircleAlert,
  ClipboardList,
  FileImage,
  FileOutput,
  FileText,
  Globe2,
  Link2,
  ListFilter,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  Repeat2,
  X,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export interface ChatWorkManifestProps {
  manifest: ChatWorkManifestResponse | null;
  loading: boolean;
  error: string | null;
  sidePanelOpen: boolean;
  wideOpen: boolean;
  onOpenItem(item: ChatWorkManifestItem): void;
  onOpenSubagents(): void;
  onJumpToMessage(messageId: string): void;
  localizeText?: (text: string) => string;
}

const identityLocalizeText = (text: string) => text;

const VISIBLE_ROWS_BEFORE_COLLAPSE = 6;

export function hasChatWorkManifestContent(manifest: ChatWorkManifestResponse | null | undefined) {
  if (!manifest) return false;
  const outputCount = Array.isArray(manifest.outputs) ? manifest.outputs.length : 0;
  const sourceCount = Array.isArray(manifest.sources) ? manifest.sources.length : 0;
  const referenceCount = Array.isArray(manifest.references) ? manifest.references.length : 0;
  const subagentCount = manifest.subagents?.totalCount ?? 0;
  return outputCount + sourceCount + referenceCount + subagentCount > 0;
}

export function chatWorkManifestCount(manifest: ChatWorkManifestResponse | null | undefined) {
  if (!manifest) return 0;
  const itemCount = manifest.totalCount ?? (
    (Array.isArray(manifest.outputs) ? manifest.outputs.length : 0)
    + (Array.isArray(manifest.sources) ? manifest.sources.length : 0)
    + (Array.isArray(manifest.references) ? manifest.references.length : 0)
  );
  return itemCount + (manifest.subagents?.totalCount ?? 0);
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

function manifestFilePath(item: ChatWorkManifestItem) {
  const metadataPath = typeof item.metadata?.filePath === "string" ? item.metadata.filePath : null;
  return metadataPath ?? item.title;
}

function manifestIssueStatus(item: ChatWorkManifestItem) {
  const status = typeof item.metadata?.issueStatus === "string"
    ? item.metadata.issueStatus.trim()
    : "";
  return status || null;
}

function issueStatusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function ManifestItemIcon({
  item,
  localizeText,
}: {
  item: ChatWorkManifestItem;
  localizeText: (text: string) => string;
}) {
  const externalUrl = websiteUrl(item);
  if (externalUrl) {
    return (
      <span className="shrink-0 text-sm text-muted-foreground">
        <WebsiteLinkIcon url={externalUrl} />
      </span>
    );
  }

  const filePath = manifestFilePath(item);
  const filename = filePath.split(/[\\/]/u).at(-1) ?? "";
  const hasFileExtension = /\.[^.]+$/u.test(filename);
  const contentType = typeof item.metadata?.contentType === "string"
    ? item.metadata.contentType.toLowerCase()
    : "";
  const iconProps = {
    className: "size-3.5 shrink-0 text-muted-foreground",
    "aria-hidden": true,
  } as const;

  if (item.targetType === "issue" || item.targetType === "issue_comment") {
    const issueStatus = manifestIssueStatus(item);
    if (issueStatus) {
      const statusLabel = localizeText(`Issue status: ${issueStatusLabel(issueStatus)}`);
      return (
        <span
          className="relative inline-flex size-3.5 shrink-0"
          data-file-icon="issue"
          data-issue-status={issueStatus}
          aria-hidden="true"
          title={statusLabel}
        >
          <ClipboardList className="size-3.5 text-muted-foreground" data-issue-type-icon="true" />
          <span className="absolute -bottom-1 -right-1 grid size-3 place-items-center rounded-full bg-background ring-1 ring-border/80">
            <StatusIcon status={issueStatus} className="size-2.5" />
          </span>
        </span>
      );
    }
    return <ClipboardList {...iconProps} data-file-icon="issue" />;
  }
  if (item.targetType === "automation") {
    return <Repeat2 {...iconProps} data-file-icon="automation" />;
  }
  if (item.targetType === "chat_conversation") {
    return <MessagesSquare {...iconProps} data-file-icon="chat" />;
  }
  if (isWorkspaceHtmlFilePath(filePath) || contentType === "text/html") {
    return <Globe2 {...iconProps} data-file-icon="website" />;
  }
  if (item.targetType === "attachment" && isPreviewableImage(contentType, filePath)) {
    return <FileImage {...iconProps} data-file-icon="image" />;
  }
  if (hasFileExtension || item.targetType !== "attachment") {
    return <FileText {...iconProps} data-file-icon="document" />;
  }
  return <Paperclip {...iconProps} data-file-icon="attachment" />;
}

export function ChatWorkManifestToggle({
  open,
  count,
  onToggle,
  localizeText = identityLocalizeText,
}: {
  open: boolean;
  count: number;
  onToggle(): void;
  localizeText?: (text: string) => string;
}) {
  const toggleLabel = localizeText(open ? "Hide conversation files and links" : "Show conversation files and links");
  return (
    <button
      type="button"
      data-testid="chat-work-manifest-wide-toggle"
      aria-label={toggleLabel}
      aria-pressed={open}
      aria-expanded={open}
      aria-controls="chat-work-manifest-wide-panel"
      title={toggleLabel}
      className={cn(
        "pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 xl:inline-flex",
        open && "bg-[color:var(--surface-active)] text-foreground",
      )}
      onClick={onToggle}
    >
      <ListFilter className="h-4 w-4" aria-hidden />
      <span className="sr-only">{localizeText("Conversation files and links")} {count}</span>
    </button>
  );
}

function ManifestRow({
  item,
  onOpen,
  onJump,
  localizeText,
}: {
  item: ChatWorkManifestItem;
  onOpen(): void;
  onJump(): void;
  localizeText: (text: string) => string;
}) {
  const rowId = useId();
  const externalUrl = websiteUrl(item);
  const issueStatus = item.targetType === "issue" || item.targetType === "issue_comment"
    ? manifestIssueStatus(item)
    : null;
  const issueStatusDescriptionId = `${rowId}-issue-status`;
  return (
    <div className="group flex min-h-11 items-center gap-1">
      <button
        type="button"
        data-target-type={item.targetType}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        onClick={onOpen}
        title={item.title}
        aria-describedby={issueStatus ? issueStatusDescriptionId : undefined}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-[calc(var(--radius-sm)-1px)] bg-muted/75 text-muted-foreground transition-colors group-hover:bg-background/70 group-hover:text-foreground">
          <ManifestItemIcon item={item} localizeText={localizeText} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-5 text-foreground">{item.title}</span>
          {externalUrl ? (
            <span className="block truncate text-[11px] leading-4 text-muted-foreground/90">{externalUrl.href}</span>
          ) : null}
        </span>
      </button>
      {issueStatus ? (
        <span id={issueStatusDescriptionId} className="sr-only">
          {localizeText(`Issue status: ${issueStatusLabel(issueStatus)}`)}
        </span>
      ) : null}
      {item.messageId ? (
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-muted-foreground opacity-0 transition-[background-color,color,opacity] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 group-hover:opacity-100"
          onClick={onJump}
          aria-label={localizeText(`Jump to source message for ${item.title}`)}
          title={localizeText("Jump to source message")}
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
  fixedHeader = false,
  reserveActionSpace = false,
  onOpenItem,
  onJumpToMessage,
  localizeText,
}: {
  idPrefix: string;
  label: string;
  icon: ReactNode;
  items: ChatWorkManifestItem[];
  fixedHeader?: boolean;
  reserveActionSpace?: boolean;
  onOpenItem(item: ChatWorkManifestItem): void;
  onJumpToMessage(messageId: string): void;
  localizeText: (text: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visibleItems = expanded ? items : items.slice(0, VISIBLE_ROWS_BEFORE_COLLAPSE);
  const sectionId = `${idPrefix}-${label.toLowerCase()}`;
  const localizedLabel = localizeText(label);
  return (
    <section aria-label={localizedLabel} className={cn(!fixedHeader && "border-t border-border/65 first:border-t-0")}>
      {fixedHeader ? null : (
        <ManifestSectionHeader
          label={localizedLabel}
          testIdLabel={label}
          icon={icon}
          count={items.length}
          reserveActionSpace={reserveActionSpace}
        />
      )}
      <div id={sectionId} className="space-y-0.5 px-2.5 pb-2 pt-1.5" role="list">
        {visibleItems.map((item) => (
          <div key={item.id} role="listitem">
            <ManifestRow
              item={item}
              onOpen={() => onOpenItem(item)}
              onJump={() => item.messageId && onJumpToMessage(item.messageId)}
              localizeText={localizeText}
            />
          </div>
        ))}
      </div>
      {items.length > VISIBLE_ROWS_BEFORE_COLLAPSE ? (
        <button
          type="button"
          className="mt-1 flex h-7 w-full items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={sectionId}
        >
          {localizeText(expanded ? "Show less" : `View all ${items.length}`)}
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
  testIdLabel,
}: {
  label: string;
  icon: ReactNode;
  count: number;
  action?: ReactNode;
  reserveActionSpace?: boolean;
  testIdLabel?: string;
}) {
  const stableTestIdLabel = (testIdLabel ?? label).toLowerCase();
  return (
    <div
      className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border/55 bg-muted/20 px-3.5 text-xs font-semibold text-muted-foreground"
      data-testid={`chat-work-manifest-section-header-${stableTestIdLabel}`}
    >
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground/90" aria-hidden="true">{icon}</span>
      <span className="text-foreground/80">{label}</span>
      <span
        className="ml-auto tabular-nums"
        data-testid={`chat-work-manifest-section-count-${stableTestIdLabel}`}
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

function subagentSummaryLabel(subagents: ChatWorkManifestSubagents) {
  const activeCount = subagents.active.length;
  const doneCount = subagents.done.length;
  if (activeCount > 0 && doneCount > 0) return `${activeCount} active · ${doneCount} done`;
  if (activeCount > 0) return `${activeCount} active`;
  return `${doneCount} done`;
}

function SubagentsSection({
  subagents,
  fixedHeader = false,
  reserveActionSpace = false,
  onOpen,
  localizeText,
}: {
  subagents: ChatWorkManifestSubagents;
  fixedHeader?: boolean;
  reserveActionSpace?: boolean;
  onOpen(): void;
  localizeText: (text: string) => string;
}) {
  if (subagents.totalCount === 0) return null;
  const visible = [...subagents.active, ...subagents.done].slice(0, 4);
  return (
    <section
      aria-label={localizeText("Subagents")}
      className={cn(!fixedHeader && "border-t border-border/65")}
      data-testid="chat-work-manifest-subagents"
    >
      {fixedHeader ? null : (
        <ManifestSectionHeader
          label={localizeText("Subagents")}
          testIdLabel="Subagents"
          icon={<Bot className="size-3.5" aria-hidden="true" />}
          count={subagents.totalCount}
          reserveActionSpace={reserveActionSpace}
        />
      )}
      <button
        type="button"
        className="group flex min-h-14 w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
        onClick={onOpen}
        aria-label={localizeText(`Open subagents, ${subagentSummaryLabel(subagents)}`)}
        data-testid="chat-work-manifest-subagents-summary"
      >
        <span className="flex shrink-0 items-center pl-0.5">
          {visible.map((item, index) => (
            <img
              key={item.threadId}
              src={getTranscriptAgentAvatarImageSrc(item.avatarSeed)}
              alt=""
              className={cn(
                "size-6 rounded-full object-cover ring-2 ring-[color:var(--surface-overlay)]",
                index > 0 && "-ml-2",
                item.state === "active" ? "ring-offset-0" : "opacity-80",
              )}
              data-subagent-avatar={item.threadId}
            />
          ))}
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground group-hover:text-foreground">
          {localizeText(subagentSummaryLabel(subagents))}
        </span>
        <ChevronDown className="ml-auto size-4 shrink-0 -rotate-90 text-muted-foreground/70 transition-transform group-hover:text-foreground" aria-hidden="true" />
      </button>
    </section>
  );
}

function ManifestStatusHeader({ action, localizeText }: { action?: ReactNode; localizeText: (text: string) => string }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border/65 px-3.5">
      <span className="text-xs font-semibold text-foreground">{localizeText("Conversation items")}</span>
      {action ? <span className="ml-auto flex">{action}</span> : null}
    </div>
  );
}

function ManifestContent({
  idPrefix,
  manifest,
  loading,
  error,
  onOpenItem,
  onOpenSubagents,
  onJumpToMessage,
  fixedSectionLabel,
  reserveActionSpace = false,
  localizeText = identityLocalizeText,
}: Omit<ChatWorkManifestProps, "sidePanelOpen"> & {
  idPrefix: string;
  fixedSectionLabel: string | null;
  reserveActionSpace?: boolean;
}) {
  const scrollRef = useScrollbarActivityRef();
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
  const subagents = manifest?.subagents ?? { active: [], done: [], totalCount: 0 };
  if (!manifest || !hasChatWorkManifestContent(manifest)) return null;
  return (
    <div
      ref={scrollRef}
      className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain"
      data-testid="chat-work-manifest-scroll-region"
    >
      <ManifestSection
        idPrefix={idPrefix}
        label="Outputs"
        icon={<FileOutput className="size-3.5" aria-hidden="true" />}
        items={outputs}
        fixedHeader={fixedSectionLabel === "Outputs"}
        reserveActionSpace={reserveActionSpace}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
        localizeText={localizeText}
      />
      <SubagentsSection
        subagents={subagents}
        fixedHeader={fixedSectionLabel === "Subagents"}
        reserveActionSpace={reserveActionSpace}
        onOpen={onOpenSubagents}
        localizeText={localizeText}
      />
      <ManifestSection
        idPrefix={idPrefix}
        label="Sources"
        icon={<Paperclip className="size-3.5" aria-hidden="true" />}
        items={sources}
        fixedHeader={fixedSectionLabel === "Sources"}
        reserveActionSpace={reserveActionSpace}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
        localizeText={localizeText}
      />
      <ManifestSection
        idPrefix={idPrefix}
        label="References"
        icon={<Link2 className="size-3.5" aria-hidden="true" />}
        items={references}
        fixedHeader={fixedSectionLabel === "References"}
        reserveActionSpace={reserveActionSpace}
        onOpenItem={onOpenItem}
        onJumpToMessage={onJumpToMessage}
        localizeText={localizeText}
      />
    </div>
  );
}

export function ChatWorkManifest(props: ChatWorkManifestProps) {
  const [compactOpen, setCompactOpen] = useState(false);
  const localizeText = props.localizeText ?? identityLocalizeText;
  if (props.sidePanelOpen || props.loading || (!props.error && !hasChatWorkManifestContent(props.manifest))) return null;
  const outputs = Array.isArray(props.manifest?.outputs) ? props.manifest.outputs : [];
  const sources = Array.isArray(props.manifest?.sources) ? props.manifest.sources : [];
  const references = Array.isArray(props.manifest?.references) ? props.manifest.references : [];
  const subagents = props.manifest?.subagents ?? { active: [], done: [], totalCount: 0 };
  const fixedSection = outputs.length > 0
    ? { label: "Outputs", count: outputs.length, icon: <FileOutput className="size-3.5" aria-hidden="true" /> }
    : subagents.totalCount > 0
      ? { label: "Subagents", count: subagents.totalCount, icon: <Bot className="size-3.5" aria-hidden="true" /> }
      : sources.length > 0
        ? { label: "Sources", count: sources.length, icon: <Paperclip className="size-3.5" aria-hidden="true" /> }
        : references.length > 0
          ? { label: "References", count: references.length, icon: <Link2 className="size-3.5" aria-hidden="true" /> }
          : null;
  const fixedSectionLabel = fixedSection?.label ?? null;
  const closeCompactPanel = (
    <button
      type="button"
      className="grid size-7 place-items-center rounded-[var(--radius-sm)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      onClick={() => setCompactOpen(false)}
      aria-label={localizeText("Close conversation files and links")}
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  );
  return (
    <div className="pointer-events-none relative z-20 shrink-0" data-testid="chat-work-manifest">
      <aside
        className={cn(
          "hidden max-h-[min(32rem,calc(100dvh-8rem))] w-[min(18rem,calc(100vw-2rem))] origin-top-right flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--surface-overlay)] shadow-[var(--shadow-lg)] transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none xl:flex",
          props.wideOpen
            ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
            : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0",
        )}
        id="chat-work-manifest-wide-panel"
        aria-label={localizeText("Conversation files and links")}
        aria-hidden={!props.wideOpen}
        inert={props.wideOpen ? undefined : true}
        data-testid="chat-work-manifest-wide-panel"
        data-state={props.wideOpen ? "open" : "closed"}
      >
        {fixedSection ? (
          <ManifestSectionHeader
            {...fixedSection}
            label={localizeText(fixedSection.label)}
            testIdLabel={fixedSection.label}
          />
        ) : (
          <ManifestStatusHeader localizeText={localizeText} />
        )}
        <ManifestContent
          key={`wide:${props.manifest?.conversationId ?? "error"}`}
          {...props}
          fixedSectionLabel={fixedSectionLabel}
          idPrefix="chat-work-manifest-wide"
        />
      </aside>

      <button
        type="button"
        className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border/70 bg-[color:var(--surface-overlay)] px-2.5 text-xs font-medium text-foreground shadow-sm transition-[background-color,color] hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 xl:hidden"
        onClick={() => setCompactOpen((value) => !value)}
        data-testid="chat-work-manifest-trigger"
        aria-expanded={compactOpen}
        aria-controls="chat-work-manifest-compact-panel"
      >
        <ListFilter className="size-3.5" aria-hidden="true" />
        {fixedSection ? `${localizeText(fixedSection.label)} ${fixedSection.count}` : localizeText("Conversation items")}
      </button>
      {compactOpen ? (
        <div
          id="chat-work-manifest-compact-panel"
          className="pointer-events-auto absolute right-[-7rem] top-10 flex max-h-[min(32rem,calc(100dvh-6rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--surface-overlay)] shadow-[var(--shadow-lg)] xl:hidden"
          data-testid="chat-work-manifest-compact-panel"
          role="complementary"
          aria-label={localizeText("Conversation files and links")}
        >
          {fixedSection ? (
            <ManifestSectionHeader
              {...fixedSection}
              label={localizeText(fixedSection.label)}
              testIdLabel={fixedSection.label}
              action={closeCompactPanel}
              reserveActionSpace
            />
          ) : (
            <ManifestStatusHeader action={closeCompactPanel} localizeText={localizeText} />
          )}
          <ManifestContent
            key={`compact:${props.manifest?.conversationId ?? "error"}`}
            {...props}
            fixedSectionLabel={fixedSectionLabel}
            reserveActionSpace
            idPrefix="chat-work-manifest-compact"
          />
        </div>
      ) : null}
    </div>
  );
}
