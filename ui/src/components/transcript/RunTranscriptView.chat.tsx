import { useEffect, useMemo, useState } from "react";
import type { TranscriptEntry } from "../../agent-runtimes";
import { cn } from "../../lib/utils";
import { CommandTerminalDetail, DisclosureChevron, ExpandableTranscriptResponsePre, areAllToolEntriesErrored, renderTranscriptBlock } from "./RunTranscriptView.blocks";
import { ChatTranscriptAction, ChatTranscriptTurn, TranscriptActionIcon, TranscriptActionIconCategory, TranscriptActionIconSlot, TranscriptActionIconStatus, TranscriptAgentInspection, TranscriptAnnotationSourceContext, TranscriptBlock, TranscriptDensity, TranscriptMarkdownLinkClickHandler, TranscriptToolCardEntry, TranscriptToolSemanticInfo, asRecord, compactWhitespace, formatTranscriptDuration, getTranscriptTimestampTitle, isInternalTranscriptLifecycleEntry, truncate } from "./RunTranscriptView.common";
import { formatSemanticDigest, normalizeChatTranscriptTurns, summarizeToolResult } from "./RunTranscriptView.normalize";
import { describeToolSemanticInfo, formatCommandTerminalOutput, formatToolPayload, isCommandTool } from "./RunTranscriptView.semantic";
import { stripWrappedShell } from "./RunTranscriptView.shell";
import { TranscriptAgentAvatarIcon, getTranscriptAgentAvatarInfo } from "./TranscriptAgentAvatarIcon";
import { transcriptAgentInspectionForTool } from "./TranscriptAgentInspection";

const EMPTY_AGENT_INSPECTIONS = new Map<string, TranscriptAgentInspection>();

export function flattenChatTranscriptActions(blocks: TranscriptBlock[]): ChatTranscriptAction[] {
  const actions: ChatTranscriptAction[] = [];

  for (const block of blocks) {
    if (block.type === "command_group") {
      block.items.forEach((entry, index) => {
        actions.push({
          key: `tool-${entry.ts}-${index}`,
          type: "tool",
          entry,
        });
      });
      continue;
    }

    if (block.type === "tool") {
      actions.push({
        key: `tool-${block.ts}-${block.toolUseId ?? block.name}`,
        type: "tool",
        entry: {
          ts: block.ts,
          endTs: block.endTs,
          name: block.name,
          toolUseId: block.toolUseId,
          input: block.input,
          result: block.result,
          isError: block.isError,
          status: block.status,
        },
      });
      continue;
    }

    if (block.type === "stdout") {
      actions.push({
        key: `stdout-${block.ts}`,
        type: "stdout",
        entry: block,
      });
    }
  }

  return actions;
}

export function getToolCommand(block: TranscriptToolCardEntry): string | null {
  if (typeof block.input === "string" && isCommandTool(block.name, block.input)) {
    return stripWrappedShell(block.input);
  }
  const record = asRecord(block.input);
  if (record) {
    if (typeof record.command === "string") return stripWrappedShell(record.command);
    if (typeof record.cmd === "string") return stripWrappedShell(record.cmd);
  }
  return null;
}

export function shouldHideChatToolResult(semantic: TranscriptToolSemanticInfo): boolean {
  return semantic.category === "read" || semantic.category === "skill";
}

function formatChatToolActionSummary(block: TranscriptToolCardEntry, semantic: TranscriptToolSemanticInfo, density: TranscriptDensity) {
  if (
    semantic.summary &&
    !(semantic.summary === "Tool" && block.input == null && typeof block.result === "string" && block.result.trim())
  ) {
    return semantic.summary;
  }
  return summarizeToolResult(block.result, block.status === "error", density);
}

function TranscriptChatActionIconCell({
  category,
  status,
  compact,
  toolName,
  input,
}: {
  category: TranscriptActionIconCategory;
  status: TranscriptActionIconStatus;
  compact: boolean;
  toolName?: string;
  input?: unknown;
}) {
  const agentAvatarInfo = toolName ? getTranscriptAgentAvatarInfo(toolName, input) : null;
  if (agentAvatarInfo) {
    return compact ? (
      <TranscriptAgentAvatarIcon info={agentAvatarInfo} status={status} />
    ) : (
      <span className="inline-flex h-5 w-8 shrink-0" data-transcript-action-icon-slot="true">
        <TranscriptAgentAvatarIcon info={agentAvatarInfo} status={status} />
      </span>
    );
  }

  if (!compact) {
    return <TranscriptActionIconSlot category={category} status={status} />;
  }

  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
      data-transcript-action-icon-slot="true"
    >
      <TranscriptActionIcon category={category} status={status} />
    </span>
  );
}

export function TranscriptChatStdoutActionRow({
  block,
  density,
  inline = false,
  quiet = true,
}: {
  block: Extract<TranscriptBlock, { type: "stdout" }>;
  density: TranscriptDensity;
  inline?: boolean;
  quiet?: boolean;
}) {
  const [open, setOpen] = useState(inline);
  const preview = truncate(compactWhitespace(block.text), density === "compact" ? 80 : 120) || "Output";
  const compact = density === "compact";
  const rowPaddingClass = compact ? "py-0.5" : "py-1.5";
  const rowAlignmentClass = compact ? "items-center" : "items-start";
  const rowGapClass = compact ? "gap-1.5" : "gap-2";
  const chevronOffsetClass = compact ? "" : "mt-0.5";

  if (inline) {
    return (
      <div className={rowPaddingClass} title={getTranscriptTimestampTitle(block.ts)}>
        <div className={cn("flex w-full text-left", rowAlignmentClass, rowGapClass)}>
          <TranscriptChatActionIconCell category="stdout" status="completed" compact={compact} />
          <pre className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-foreground/80",
            compact ? "text-[11px] leading-5" : "text-xs leading-6",
          )}>
            {block.text}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className={rowPaddingClass} title={getTranscriptTimestampTitle(block.ts)}>
      <button
        type="button"
        className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse output details" : "Expand output details"}
      >
        <TranscriptChatActionIconCell category="stdout" status="completed" compact={compact} />
        <span className={cn("min-w-0 flex-1 break-words text-foreground/82", compact ? "text-xs leading-5" : "text-sm leading-6")}>
          {preview}
        </span>
        <span
          className={cn(
            "inline-flex h-5 w-5 items-center justify-center text-muted-foreground",
            chevronOffsetClass,
            quiet && !open && "opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-visible/activity-row:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
          )}
          data-transcript-action-row-disclosure="true"
        >
          <DisclosureChevron open={open} className="h-4 w-4" />
        </span>
      </button>
      {open ? (
        <pre className={cn(
          "motion-disclosure-enter",
          "mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/35 bg-muted/10 p-2.5 font-mono text-foreground/80",
          density === "compact" ? "text-[11px]" : "text-xs",
        )}>
          {block.text}
        </pre>
      ) : null}
    </div>
  );
}

export function TranscriptChatToolActionRow({
  block,
  density,
  inline = false,
  defaultOpenOnError = false,
  highlightError = true,
  onOpenFile,
  agentInspection,
  onOpenAgent,
  quiet = true,
}: {
  block: TranscriptToolCardEntry;
  density: TranscriptDensity;
  inline?: boolean;
  defaultOpenOnError?: boolean;
  highlightError?: boolean;
  onOpenFile?: (targetPath: string, label: string) => void;
  agentInspection?: TranscriptAgentInspection | null;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  quiet?: boolean;
}) {
  const semantic = describeToolSemanticInfo(block.name, block.input);
  const displaySummary = formatChatToolActionSummary(block, semantic, density);
  const compact = density === "compact";
  const isCommand = isCommandTool(block.name, block.input);
  const command = getToolCommand(block);
  const requestText = command ?? (formatToolPayload(block.input) || "<empty>");
  const responseText = shouldHideChatToolResult(semantic)
    ? null
    : command
      ? formatCommandTerminalOutput(block.result)
      : block.result
        ? formatToolPayload(block.result)
        : block.status === "running"
          ? "Waiting for result..."
          : null;
  const canExpand = Boolean(command || responseText || (!isCommand && requestText !== "<empty>"));
  const [open, setOpen] = useState(inline || (defaultOpenOnError && block.status === "error"));
  const duration = quiet ? null : formatTranscriptDuration(block.ts, block.endTs);
  const statusText =
    block.status === "error"
      ? "Failed"
      : block.status === "running"
        ? "Running"
        : null;
  const rowTone = block.status === "error"
    ? "text-red-700 dark:text-red-300"
    : block.status === "running"
      ? "text-cyan-700 dark:text-cyan-300"
      : "text-muted-foreground";
  const iconStatus = block.status === "error" ? "error" : block.status === "running" ? "running" : quiet ? "neutral" : "completed";
  const rowPaddingClass = compact ? "py-0.5" : "py-1.5";
  const rowAlignmentClass = compact ? "items-center" : "items-start";
  const rowGapClass = compact ? "gap-1.5" : "gap-2";
  const trailingOffsetClass = compact ? "" : "pt-0.5";
  const chevronOffsetClass = compact ? "" : "mt-0.5";
  const fileTargets = semantic.fileTargets ?? [];
  const hasOpenableFileTargets = fileTargets.some((target) => target.path);
  const detailLabel = open
    ? `Collapse ${isCommand ? "command" : "tool"} details`
    : `Expand ${isCommand ? "command" : "tool"} details`;
  const toggleDetails = () => {
    if (inline || !canExpand) return;
    setOpen((value) => !value);
  };
  const inspectableAgent = agentInspection && onOpenAgent ? agentInspection : null;
  const inspectAgent = inspectableAgent && onOpenAgent
    ? () => onOpenAgent(inspectableAgent)
    : null;

  return (
    <div
      className={cn(rowPaddingClass, highlightError && block.status === "error" && "-mx-2 rounded-lg bg-red-500/[0.04] px-2")}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      {hasOpenableFileTargets ? (
        <div className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}>
          <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
          <span className={cn("min-w-0 flex-1 break-words text-foreground/84", compact ? "text-xs leading-5" : "text-sm leading-6")}>
            {semantic.category === "edit" ? "Edited " : "Read "}
            {fileTargets.map((target, index) => (
              <span key={`${target.label}-${index}`}>
                {index > 0 ? ", " : null}
                {target.path ? (
                  <button
                    type="button"
                    className="rounded-sm underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-label={`Open file ${target.label}`}
                    data-transcript-file-target={target.path}
                    onClick={() => onOpenFile?.(target.path!, target.label)}
                  >
                    {target.label}
                  </button>
                ) : (
                  <span title="This relative file path has no trusted workspace root.">{target.label}</span>
                )}
              </span>
            ))}
          </span>
          {duration ? (
            <span className={cn("text-[10px] font-medium tabular-nums text-muted-foreground", trailingOffsetClass)}>
              {duration}
            </span>
          ) : null}
          {statusText ? (
            <span className={cn("text-[10px] font-medium", rowTone, trailingOffsetClass)}>
              {statusText}
            </span>
          ) : null}
          {canExpand && !inline ? (
            <button
              type="button"
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                chevronOffsetClass,
                quiet && !open && "opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
              )}
              onClick={toggleDetails}
              aria-expanded={open}
              aria-label={detailLabel}
              data-transcript-action-row-disclosure="true"
            >
              <DisclosureChevron open={open} className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}
          onClick={inspectAgent ?? toggleDetails}
          aria-expanded={!inspectAgent && canExpand && !inline ? open : undefined}
          aria-label={inspectAgent
            ? `Inspect agent ${inspectableAgent?.threadId}`
            : canExpand && !inline
              ? detailLabel
              : undefined}
          data-transcript-agent-inspect={inspectAgent ? inspectableAgent?.threadId : undefined}
        >
          <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
          <span className={cn("min-w-0 flex-1 break-words text-foreground/84", compact ? "text-xs leading-5" : "text-sm leading-6")}>
            {displaySummary}
          </span>
          {duration ? (
            <span className={cn("text-[10px] font-medium tabular-nums text-muted-foreground", trailingOffsetClass)}>
              {duration}
            </span>
          ) : null}
          {statusText ? (
            <span className={cn("text-[10px] font-medium", rowTone, trailingOffsetClass)}>
              {statusText}
            </span>
          ) : null}
          {canExpand && !inline && !inspectAgent ? (
            <span
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center text-muted-foreground",
                chevronOffsetClass,
                quiet && !open && "opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-visible/activity-row:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
              )}
              data-transcript-action-row-disclosure="true"
            >
              <DisclosureChevron open={open} className="h-4 w-4" />
            </span>
          ) : null}
        </button>
      )}
      {canExpand && open ? (
        command ? (
          <CommandTerminalDetail
            command={requestText}
            output={responseText}
            status={block.status}
            className="motion-disclosure-enter ml-5 mt-2"
          />
        ) : (
          <div className="motion-disclosure-enter ml-5 mt-2 space-y-2 rounded-lg border border-border/35 bg-muted/10 p-2.5">
            <div>
              <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                Input
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                {requestText}
              </pre>
            </div>
            {responseText ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                  Response
                </div>
                <ExpandableTranscriptResponsePre
                  text={responseText}
                  className={cn(
                    block.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                  )}
                />
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

export function TranscriptChatActionRow({
  action,
  density,
  inline = false,
  defaultOpenOnError = false,
  highlightError = true,
  onOpenFile,
  agentInspections = EMPTY_AGENT_INSPECTIONS,
  onOpenAgent,
  quiet = true,
}: {
  action: ChatTranscriptAction;
  density: TranscriptDensity;
  inline?: boolean;
  defaultOpenOnError?: boolean;
  highlightError?: boolean;
  onOpenFile?: (targetPath: string, label: string) => void;
  agentInspections?: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  quiet?: boolean;
}) {
  if (action.type === "stdout") {
    return <TranscriptChatStdoutActionRow block={action.entry} density={density} inline={inline} quiet={quiet} />;
  }

  return (
    <TranscriptChatToolActionRow
      block={action.entry}
      density={density}
      inline={inline}
      defaultOpenOnError={defaultOpenOnError}
      highlightError={highlightError}
      onOpenFile={onOpenFile}
      agentInspection={transcriptAgentInspectionForTool(action.entry, agentInspections)}
      onOpenAgent={onOpenAgent}
      quiet={quiet}
    />
  );
}

export type ChatTranscriptTurnSegment =
  | {
      type: "block";
      key: string;
      block: TranscriptBlock;
    }
  | {
      type: "actions";
      key: string;
      actions: ChatTranscriptAction[];
    };

export function isChatActionBlock(block: TranscriptBlock): boolean {
  return block.type === "tool" || block.type === "command_group" || block.type === "stdout";
}

export function segmentChatTranscriptBlocks(blocks: TranscriptBlock[]): ChatTranscriptTurnSegment[] {
  const segments: ChatTranscriptTurnSegment[] = [];
  let pendingActionBlocks: TranscriptBlock[] = [];

  const flushActions = () => {
    if (pendingActionBlocks.length === 0) return;
    const actions = flattenChatTranscriptActions(pendingActionBlocks);
    if (actions.length > 0) {
      segments.push({
        type: "actions",
        key: `actions-${pendingActionBlocks[0]?.ts ?? segments.length}-${segments.length}`,
        actions,
      });
    }
    pendingActionBlocks = [];
  };

  blocks.forEach((block, index) => {
    if (isChatActionBlock(block)) {
      pendingActionBlocks.push(block);
      return;
    }

    flushActions();
    segments.push({
      type: "block",
      key: `${block.type}-${block.ts}-${index}`,
      block,
    });
  });

  flushActions();
  return segments;
}

export function formatChatActionSummary(actions: ChatTranscriptAction[]): string {
  const infos = actions
    .filter((action): action is Extract<ChatTranscriptAction, { type: "tool" }> => action.type === "tool")
    .map((action) => describeToolSemanticInfo(action.entry.name, action.entry.input));
  const stdoutCount = actions.filter((action) => action.type === "stdout").length;
  return formatSemanticDigest(infos, stdoutCount, { preferDirectSummary: true });
}

export function getChatActionIconInfo(action: ChatTranscriptAction): {
  category: TranscriptActionIconCategory;
  status: TranscriptActionIconStatus;
} {
  if (action.type === "stdout") {
    return { category: "stdout", status: "completed" };
  }
  const semantic = describeToolSemanticInfo(action.entry.name, action.entry.input);
  return {
    category: semantic.category,
    status: action.entry.status === "error" ? "error" : action.entry.status === "running" ? "running" : "completed",
  };
}

export function TranscriptChatActionGroup({
  actions,
  density,
  detailVariant,
  groupIndex,
  groupCount,
  onOpenFile,
  agentInspections = EMPTY_AGENT_INSPECTIONS,
  onOpenAgent,
  annotationSource,
}: {
  actions: ChatTranscriptAction[];
  density: TranscriptDensity;
  detailVariant: boolean;
  groupIndex: number;
  groupCount: number;
  onOpenFile?: (targetPath: string, label: string) => void;
  agentInspections?: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  annotationSource?: TranscriptAnnotationSourceContext;
}) {
  const compact = density === "compact";
  const singleAction = actions[0];
  const hasSingleAction = actions.length === 1;
  const toolEntries = actions
    .filter((action): action is Extract<ChatTranscriptAction, { type: "tool" }> => action.type === "tool")
    .map((action) => action.entry);
  const allToolsErrored = areAllToolEntriesErrored(toolEntries);
  const shouldInlineSingleStdoutAction = hasSingleAction && singleAction?.type === "stdout";
  const shouldRenderSingleToolAction = hasSingleAction && singleAction?.type === "tool";
  const summary = formatChatActionSummary(actions);
  const highlightGroupError = allToolsErrored && !detailVariant;
  const [detailsOpen, setDetailsOpen] = useState(() => (detailVariant ? false : allToolsErrored));
  const summaryIcon = getChatActionIconInfo(actions[0]!);
  const summaryAgentAvatar = actions[0]?.type === "tool"
    ? getTranscriptAgentAvatarInfo(actions[0].entry.name, actions[0].entry.input)
    : null;

  useEffect(() => {
    if (!detailVariant && allToolsErrored) {
      setDetailsOpen(true);
    }
  }, [detailVariant, allToolsErrored]);

  if (shouldInlineSingleStdoutAction) {
    return (
      <div className="divide-y divide-border/30">
        <TranscriptChatActionRow
          action={singleAction}
          density={density}
          inline
          agentInspections={agentInspections}
          onOpenAgent={onOpenAgent}
        />
      </div>
    );
  }

  if (shouldRenderSingleToolAction) {
    return (
      <div className="divide-y divide-border/30">
        <TranscriptChatActionRow
          action={singleAction}
          density={density}
          defaultOpenOnError={false}
          highlightError={!detailVariant}
          onOpenFile={onOpenFile}
          agentInspections={agentInspections}
          onOpenAgent={onOpenAgent}
          quiet={!detailVariant}
        />
      </div>
    );
  }

  const labelSuffix = groupCount > 1 ? ` group ${groupIndex + 1}` : "";
  const expandedLabel = detailsOpen
    ? `Collapse tool activity${labelSuffix}`
    : `Expand tool activity${labelSuffix}`;

  return (
    <div>
      <button
        type="button"
        className={cn(
          "group/activity -mx-2 inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors",
          highlightGroupError ? "hover:bg-red-500/[0.05]" : "hover:bg-muted/10",
        )}
        onClick={() => setDetailsOpen((value) => !value)}
        aria-expanded={detailsOpen}
        aria-label={expandedLabel}
      >
        <span
          className={cn("mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center", highlightGroupError && "rounded-full bg-red-500/[0.08]")}
          data-transcript-action-summary-icon="true"
        >
          {summaryAgentAvatar ? (
            <TranscriptAgentAvatarIcon
              info={summaryAgentAvatar}
              status={highlightGroupError ? "error" : summaryIcon.status}
            />
          ) : (
            <TranscriptActionIcon category={summaryIcon.category} status={highlightGroupError ? "error" : "neutral"} />
          )}
        </span>
        <span className="min-w-0">
          <span className={cn(
            "block break-words text-foreground/82",
            compact ? "text-xs" : "text-sm",
          )}>
            {summary || "Tool details"}
          </span>
        </span>
        <span
          className={cn(
            "inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity",
            detailsOpen ? "opacity-100" : "opacity-0 group-hover/activity:opacity-100 group-focus-visible/activity:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
          )}
          data-testid="transcript-action-group-disclosure"
          data-transcript-disclosure-chevron="true"
        >
          <DisclosureChevron open={detailsOpen} className="h-4 w-4" />
        </span>
      </button>

      {detailsOpen ? (
        <div className="motion-disclosure-enter mt-0.5">
          {actions.map((action) => (
            <TranscriptChatActionRow
              key={action.key}
              action={action}
              density={density}
              onOpenFile={onOpenFile}
              agentInspections={agentInspections}
              onOpenAgent={onOpenAgent}
              quiet={!detailVariant}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TranscriptChatTurn({
  turn,
  density,
  thinkingClassName,
  variant = "chat",
  onMarkdownLinkClick,
  onOpenFile,
  agentInspections = EMPTY_AGENT_INSPECTIONS,
  onOpenAgent,
  annotationSource,
}: {
  turn: ChatTranscriptTurn;
  density: TranscriptDensity;
  thinkingClassName?: string;
  variant?: "chat" | "detail";
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  onOpenFile?: (targetPath: string, label: string) => void;
  agentInspections?: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  annotationSource?: TranscriptAnnotationSourceContext;
}) {
  const detailVariant = variant === "detail";
  const segments = segmentChatTranscriptBlocks(turn.blocks);
  const actionGroupCount = segments.filter((segment) => segment.type === "actions").length;
  const content = segments.length > 0 ? (
    <div className={cn(density === "compact" ? "space-y-1" : "space-y-3")} title={getTranscriptTimestampTitle(turn.ts)}>
      {segments.map((segment, index) => (
        segment.type === "block"
          ? renderTranscriptBlock({
              block: segment.block,
              index,
              density,
              presentation: detailVariant ? "detail" : "chat",
              collapseStdout: true,
              thinkingClassName,
              onMarkdownLinkClick,
              annotationSource,
            })
          : (
            <TranscriptChatActionGroup
              key={segment.key}
              actions={segment.actions}
              density={density}
              detailVariant={detailVariant}
              groupIndex={segments.slice(0, index).filter((item) => item.type === "actions").length}
              groupCount={actionGroupCount}
              onOpenFile={onOpenFile}
              agentInspections={agentInspections}
              onOpenAgent={onOpenAgent}
            />
          )
      ))}
    </div>
  ) : null;
  return content;
}

export function trimTrailingWhitespace(value: string) {
  return value.replace(/\s+$/g, "");
}

const INTERNAL_RESULT_MARKER_PATTERN = /RUDDER_RESULT_(?:BEGIN|END)|__RUDDER_RESULT_[a-f0-9-]+__/i;
const INTERNAL_RESULT_MARKER_PREFIXES = ["RUDDER_RESULT_BEGIN", "RUDDER_RESULT_END"];
const DYNAMIC_RESULT_MARKER_STEM = "__RUDDER_RESULT_";

function trailingInternalResultMarkerPrefixIndex(text: string, entryStarts: Set<number>) {
  const isBoundary = (index: number) => index === 0
    || entryStarts.has(index)
    || text[index - 1] === "\n"
    || text[index - 1] === "\r";
  const upper = text.toUpperCase();

  for (const marker of [...INTERNAL_RESULT_MARKER_PREFIXES, DYNAMIC_RESULT_MARKER_STEM]) {
    const maxPrefixLength = Math.min(marker.length, upper.length);
    for (let length = maxPrefixLength; length >= 1; length -= 1) {
      const index = upper.length - length;
      if (isBoundary(index) && marker.startsWith(upper.slice(index))) return index;
    }
  }

  const dynamicMarkerIndex = upper.lastIndexOf(DYNAMIC_RESULT_MARKER_STEM);
  if (dynamicMarkerIndex >= 0 && isBoundary(dynamicMarkerIndex)) {
    const markerSuffix = upper.slice(dynamicMarkerIndex + DYNAMIC_RESULT_MARKER_STEM.length);
    if (/^[A-F0-9-]+_?$/.test(markerSuffix)) return dynamicMarkerIndex;
  }

  return -1;
}

function transcriptEntriesBeforeAssistantTextIndex(
  entries: TranscriptEntry[],
  endIndex: number,
) {
  const visible: TranscriptEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.kind !== "assistant") {
      visible.push(entry);
      continue;
    }
    const entryEnd = offset + entry.text.length;
    if (entryEnd <= endIndex) {
      visible.push(entry);
    } else if (offset < endIndex) {
      const text = trimTrailingWhitespace(entry.text.slice(0, endIndex - offset));
      if (text) visible.push({ ...entry, text });
      break;
    } else {
      break;
    }
    offset = entryEnd;
  }
  return visible;
}

function stripInternalResultProtocolFromChatTranscript(
  entries: TranscriptEntry[],
  streaming: boolean,
  preserveLifecycleBoundaries: boolean,
) {
  const filtered: TranscriptEntry[] = [];
  let assistantGroup: TranscriptEntry[] = [];

  const flushAssistantGroup = () => {
    if (assistantGroup.length === 0) return;
    const entryStarts = new Set<number>();
    let text = "";
    for (const entry of assistantGroup) {
      if (entry.kind !== "assistant") continue;
      entryStarts.add(text.length);
      text += entry.text;
    }
    const completeMarkerIndex = text.search(INTERNAL_RESULT_MARKER_PATTERN);
    const partialMarkerIndex = completeMarkerIndex < 0 && streaming
      ? trailingInternalResultMarkerPrefixIndex(text, entryStarts)
      : -1;
    const markerIndex = completeMarkerIndex >= 0 ? completeMarkerIndex : partialMarkerIndex;
    if (markerIndex < 0) {
      filtered.push(...assistantGroup);
    } else {
      filtered.push(...transcriptEntriesBeforeAssistantTextIndex(assistantGroup, markerIndex));
    }
    assistantGroup = [];
  };

  for (const entry of entries) {
    if (entry.kind === "assistant") {
      assistantGroup.push(entry);
      continue;
    }
    if (preserveLifecycleBoundaries
      && assistantGroup.length > 0
      && isInternalTranscriptLifecycleEntry(entry)) {
      assistantGroup.push(entry);
      continue;
    }
    flushAssistantGroup();
    filtered.push(entry);
  }
  flushAssistantGroup();
  return filtered;
}

export function redactAssistantSuffixFromChatTranscript(
  entries: TranscriptEntry[],
  hiddenAssistantMessageText: string | null | undefined,
) {
  let remaining = trimTrailingWhitespace(hiddenAssistantMessageText ?? "");
  if (!remaining) return entries;

  const nextEntries: TranscriptEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "assistant" || !remaining) {
      nextEntries.push(entry);
      continue;
    }

    const entryText = trimTrailingWhitespace(entry.text);
    remaining = trimTrailingWhitespace(remaining);
    if (!entryText) {
      nextEntries.push(entry);
      continue;
    }

    if (remaining.endsWith(entryText)) {
      remaining = trimTrailingWhitespace(remaining.slice(0, remaining.length - entryText.length));
      continue;
    }

    if (entryText.endsWith(remaining)) {
      const visibleText = trimTrailingWhitespace(entryText.slice(0, entryText.length - remaining.length));
      remaining = "";
      if (visibleText) {
        nextEntries.push({ ...entry, text: visibleText });
      }
      continue;
    }

    nextEntries.push(entry);
  }

  if (remaining) return entries;
  return nextEntries.reverse();
}

export function filterChatAssistantTranscriptEntries(
  entries: TranscriptEntry[],
  options: {
    hideAssistantMessages: boolean;
    hiddenAssistantMessageText?: string | null;
    streaming?: boolean;
    preserveLifecycleBoundaries?: boolean;
  },
) {
  const preserveLifecycleBoundaries = options.preserveLifecycleBoundaries === true;
  if (options.hideAssistantMessages) {
    return entries.filter((entry) => entry.kind !== "assistant"
      && (preserveLifecycleBoundaries || !isInternalTranscriptLifecycleEntry(entry)));
  }
  const withoutFinalAnswer = redactAssistantSuffixFromChatTranscript(entries, options.hiddenAssistantMessageText);
  const withRequiredBoundaries = preserveLifecycleBoundaries
    ? withoutFinalAnswer
    : withoutFinalAnswer.filter((entry) => !isInternalTranscriptLifecycleEntry(entry));
  return stripInternalResultProtocolFromChatTranscript(
    withRequiredBoundaries,
    options.streaming === true,
    preserveLifecycleBoundaries,
  );
}

export function TranscriptChatTimeline({
  entries,
  density,
  streaming,
  collapseStdout,
  thinkingClassName,
  hideAssistantMessages,
  hiddenAssistantMessageText,
  showDeveloperDiagnostics,
  onMarkdownLinkClick,
  onOpenFile,
  agentInspections,
  onOpenAgent,
  annotationSource,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  streaming: boolean;
  collapseStdout: boolean;
  thinkingClassName?: string;
  hideAssistantMessages: boolean;
  hiddenAssistantMessageText?: string | null;
  showDeveloperDiagnostics: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  onOpenFile?: (targetPath: string, label: string) => void;
  agentInspections: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  annotationSource?: TranscriptAnnotationSourceContext;
}) {
  const timelineEntries = useMemo(
    () => filterChatAssistantTranscriptEntries(entries, {
      hideAssistantMessages,
      hiddenAssistantMessageText,
      streaming,
      preserveLifecycleBoundaries: true,
    }),
    [entries, hideAssistantMessages, hiddenAssistantMessageText, streaming],
  );
  const { preludeBlocks, turns } = useMemo(
    () => normalizeChatTranscriptTurns(timelineEntries, streaming, { showDeveloperDiagnostics }),
    [timelineEntries, streaming, showDeveloperDiagnostics],
  );

  return (
    <div className="space-y-3">
      {preludeBlocks.map((block, index) => renderTranscriptBlock({
        block,
        index,
        density,
        presentation: "chat",
        collapseStdout,
        thinkingClassName,
        onMarkdownLinkClick,
        annotationSource,
      }))}
      {turns.map((turn) => (
        <TranscriptChatTurn
          key={turn.key}
          turn={turn}
          density={density}
          thinkingClassName={thinkingClassName}
          onMarkdownLinkClick={onMarkdownLinkClick}
          onOpenFile={onOpenFile}
          agentInspections={agentInspections}
          onOpenAgent={onOpenAgent}
          annotationSource={annotationSource}
        />
      ))}
    </div>
  );
}
