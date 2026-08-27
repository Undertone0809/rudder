import { useToolCallFailureIndicators } from "@/context/ThemeContext";
import { Fragment, createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptEntry } from "../../agent-runtimes";
import { cn } from "../../lib/utils";
import { CommandTerminalDetail, DisclosureChevron, ExpandableTranscriptResponsePre, TranscriptRunAnnotationBlock, areAllToolEntriesErrored, renderTranscriptBlock } from "./RunTranscriptView.blocks";
import { ChatTranscriptAction, ChatTranscriptTurn, TranscriptActionIcon, TranscriptActionIconCategory, TranscriptActionIconStatus, TranscriptAgentInspection, TranscriptAnnotationSourceContext, TranscriptBlock, TranscriptDensity, TranscriptMarkdownLinkClickHandler, TranscriptRunAnnotationContext, TranscriptSentAnnotationContext, TranscriptSkillTarget, TranscriptToolCardEntry, TranscriptToolSemanticInfo, asRecord, compactWhitespace, formatTranscriptDuration, getTranscriptTimestampTitle, isInternalTranscriptLifecycleEntry, truncate } from "./RunTranscriptView.common";
import { formatSemanticDigest, normalizeChatTranscriptTurns, summarizeToolResult } from "./RunTranscriptView.normalize";
import { formatNiceToolRequest, formatNiceToolRequestParameters, formatNiceToolResponse, getNiceToolRequestLabel } from "./RunTranscriptView.presentation";
import { RudderMcpSemanticPresenter, getRudderMcpPresenterDefinition } from "./RunTranscriptView.rudder-mcp";
import { describeToolSemanticInfo, extractMcpToolDetails, formatCommandTerminalOutput, isCommandTool, neutralizeToolFailureSemanticInfo } from "./RunTranscriptView.semantic";
import { stripWrappedShell } from "./RunTranscriptView.shell";
import { TranscriptAgentAvatarIcon, getTranscriptAgentAvatarInfo } from "./TranscriptAgentAvatarIcon";
import { transcriptAgentInspectionForTool } from "./TranscriptAgentInspection";
import { TranscriptImageArtifact } from "./TranscriptImageArtifact";
import { TranscriptUnifiedDiff, parseUnifiedDiff } from "./TranscriptUnifiedDiff";

const EMPTY_AGENT_INSPECTIONS = new Map<string, TranscriptAgentInspection>();
const CHAT_READING_COLUMN_CLASS = "w-full min-w-0 max-w-3xl px-1";
const CHAT_FULL_COLUMN_CLASS = "w-full min-w-0";
const TranscriptTextContext = createContext<(text: string) => string>((text) => text);

function useTranscriptText() {
  return useContext(TranscriptTextContext);
}

function transcriptFileDisplayName(label: string) {
  const trimmed = label.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || label;
}

type TranscriptMcpBrandIcon = {
  aliases: readonly string[];
  label: string;
  src: string;
  imageClassName?: string;
};

const TRANSCRIPT_MCP_BRAND_ICONS: readonly TranscriptMcpBrandIcon[] = [
  {
    aliases: ["rudder", "rudder-tools", "rudder_tools", "rudder-browser", "rudder_browser"],
    label: "Rudder",
    src: "/rudder-logo.png",
  },
  {
    aliases: ["github", "github-tools", "github-mcp", "github-mcp-server"],
    label: "GitHub",
    src: "/brands/github-logo.svg",
    imageClassName: "dark:invert",
  },
  {
    aliases: ["gmail"],
    label: "Gmail",
    src: "/brands/gmail-logo.svg",
  },
  {
    aliases: ["google-calendar", "google_calendar"],
    label: "Google Calendar",
    src: "/brands/google-calendar-logo.svg",
  },
  {
    aliases: ["google-drive", "google_drive"],
    label: "Google Drive",
    src: "/brands/google-drive-logo.svg",
  },
  {
    aliases: ["notion"],
    label: "Notion",
    src: "/brands/notion-logo.svg",
    imageClassName: "dark:invert",
  },
  {
    aliases: ["linear"],
    label: "Linear",
    src: "/brands/linear-logo.svg",
  },
];

export function getTranscriptMcpBrandIcon(server: string | null | undefined): TranscriptMcpBrandIcon | null {
  const normalizedServer = server?.trim().toLowerCase();
  if (!normalizedServer) return null;
  return TRANSCRIPT_MCP_BRAND_ICONS.find((brand) => brand.aliases.includes(normalizedServer)) ?? null;
}

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
          sourceEntryIds: block.sourceEntryIds,
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

function formatChatToolActionSummary(
  block: TranscriptToolCardEntry,
  semantic: TranscriptToolSemanticInfo,
  density: TranscriptDensity,
  renderFailure: boolean,
) {
  if (block.status === "error" && !renderFailure) {
    return semantic.summary || semantic.label;
  }
  if (
    semantic.summary &&
    !(semantic.summary === "Tool" && block.input == null && typeof block.result === "string" && block.result.trim())
  ) {
    return semantic.summary;
  }
  return summarizeToolResult(block.result, renderFailure, density);
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
  const mcpDetails = category === "mcp" && toolName ? extractMcpToolDetails(toolName, input) : null;
  const mcpBrandIcon = getTranscriptMcpBrandIcon(mcpDetails?.server);
  if (agentAvatarInfo) {
    return compact ? (
      <TranscriptAgentAvatarIcon info={agentAvatarInfo} status={status} />
    ) : (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center" data-transcript-action-icon-slot="true">
        <TranscriptAgentAvatarIcon info={agentAvatarInfo} status={status} />
      </span>
    );
  }

  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
      data-transcript-action-icon-slot="true"
    >
      {mcpBrandIcon ? (
        <span
          className="inline-flex h-4 w-4 items-center justify-center"
          aria-label={`${mcpBrandIcon.label} MCP tool`}
          title={mcpBrandIcon.label}
        >
          <img
            src={mcpBrandIcon.src}
            alt=""
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 object-contain", mcpBrandIcon.imageClassName)}
          />
        </span>
      ) : (
        <TranscriptActionIcon category={category} status={status} />
      )}
    </span>
  );
}

function TranscriptChatActionTrailing({
  duration,
  statusText,
  statusTone,
  statusId,
  disclosure,
}: {
  duration: string | null;
  statusText: string | null;
  statusTone?: string;
  statusId?: string;
  disclosure?: ReactNode;
}) {
  const hasDisclosure = Boolean(disclosure);
  if (!duration && !statusText && !hasDisclosure) return null;

  return (
    <span
      className="ml-auto inline-flex h-5 shrink-0 items-center gap-1.5 self-center"
      data-transcript-action-trailing="true"
    >
      {statusText ? (
        <span id={statusId} className={cn("inline-flex h-5 items-center text-[10px] font-medium", statusTone)}>
          {statusText}
        </span>
      ) : null}
      {duration ? (
        <span
          className="inline-flex h-5 items-center text-[10px] font-medium tabular-nums text-muted-foreground"
          data-transcript-action-duration="true"
        >
          {duration}
        </span>
      ) : null}
      <span
        className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground", !hasDisclosure && "invisible")}
        data-transcript-action-disclosure-slot="true"
        aria-hidden={!hasDisclosure}
      >
        {disclosure}
      </span>
    </span>
  );
}

export function TranscriptChatStdoutActionRow({
  block,
  density,
  inline = false,
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
        <span
          className={cn("min-w-0 flex-1 truncate text-foreground/82", compact ? "text-xs leading-5" : "text-sm leading-6")}
          title={block.text}
        >
          {preview}
        </span>
        <span
          className={cn(
            "inline-flex h-5 w-5 items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-visible/activity-row:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
            chevronOffsetClass,
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
  onOpenSkill,
  canOpenSkill,
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
  onOpenSkill?: (target: TranscriptSkillTarget) => void;
  canOpenSkill?: (target: TranscriptSkillTarget) => boolean;
  agentInspection?: TranscriptAgentInspection | null;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  quiet?: boolean;
}) {
  const showFailureIndicators = useToolCallFailureIndicators();
  const localizeText = useTranscriptText();
  const renderFailure = showFailureIndicators && block.status === "error";
  const rawSemantic = describeToolSemanticInfo(block.name, block.input, block.result);
  const semantic = showFailureIndicators
    ? rawSemantic
    : neutralizeToolFailureSemanticInfo(rawSemantic);
  const displaySummary = localizeText(formatChatToolActionSummary(block, semantic, density, renderFailure));
  const compact = density === "compact";
  const isCommand = isCommandTool(block.name, block.input);
  const command = getToolCommand(block);
  const requestText = command ?? formatNiceToolRequest(block.name, block.input);
  const requestLabel = getNiceToolRequestLabel(block.name, block.input);
  const requestParameters = command ? null : formatNiceToolRequestParameters(block.name, block.input);
  const rudderPresenter = getRudderMcpPresenterDefinition(block.name, block.input);
  const responseText = shouldHideChatToolResult(semantic)
    ? null
    : command
      ? formatCommandTerminalOutput(block.result)
      : block.result
        ? formatNiceToolResponse(block.name, block.input, block.result)
        : block.status === "running"
          ? localizeText("Waiting for result...")
          : null;
  const canExpand = semantic.category !== "skill"
    && !(rudderPresenter && block.status === "running")
    && Boolean(rudderPresenter || command || responseText || (!isCommand && requestText !== "<empty>"));
  const visualStatus = block.status === "error" && !showFailureIndicators
    ? "completed"
    : block.status;
  const [open, setOpen] = useState(inline || (defaultOpenOnError && renderFailure));
  const failureAutoOpenRef = useRef(!inline && defaultOpenOnError && renderFailure);
  const [imageOpen, setImageOpen] = useState(false);
  const [openDiffIndexes, setOpenDiffIndexes] = useState<Set<number>>(() => new Set());
  const taskDuration = formatTranscriptDuration(block.ts, block.endTs);
  const duration = quiet ? null : taskDuration;
  const statusText =
    renderFailure
      ? localizeText("Failed")
      : block.status === "running"
        ? localizeText("Running")
        : null;
  const rowTone = renderFailure
    ? "text-red-700 dark:text-red-300"
    : block.status === "running"
      ? "text-cyan-700 dark:text-cyan-300"
      : "text-muted-foreground";
  const iconStatus = renderFailure ? "error" : block.status === "running" ? "running" : quiet ? "neutral" : "completed";
  const rowPaddingClass = compact ? "py-0.5" : "py-1.5";
  const rowAlignmentClass = compact ? "items-center" : "items-start";
  const rowGapClass = compact ? "gap-1.5" : "gap-2";
  const chevronOffsetClass = compact ? "" : "mt-0.5";
  const fileTargets = semantic.fileTargets ?? [];
  const fileChanges = semantic.fileChanges ?? [];
  const fileTargetDetailsGated = fileTargets.length > 1;
  const hasOpenableFileTargets = fileTargets.some((target) => target.path);
  const skillTargets = semantic.skillTargets ?? [];
  const hasInspectableSkillTargets = semantic.category === "skill" && skillTargets.length > 0;
  const image = block.status === "completed" ? semantic.image : undefined;
  const inputStatus = typeof asRecord(block.input)?.status === "string"
    ? String(asRecord(block.input)?.status).toLowerCase()
    : null;
  const fileChangeSucceeded = block.status === "completed"
    && inputStatus !== "failed"
    && inputStatus !== "error";
  const fileChangeDetailsGated = fileChanges.length > 0 && (
    fileChanges.length > 1
    || semantic.quantity > fileChanges.length
    || !fileChanges.some((change) => {
      const parsed = change.diff ? parseUnifiedDiff(change.diff) : null;
      return fileChangeSucceeded
        && Boolean(change.diff && parsed?.hasHunks && !parsed.binary);
    })
  );
  const detailStateLabelId = useId();
  const summaryLabelId = useId();
  const statusLabelId = useId();
  useEffect(() => {
    if (!inline && defaultOpenOnError && renderFailure) {
      setOpen((current) => {
        if (!current) {
          failureAutoOpenRef.current = true;
          return true;
        }
        return current;
      });
      return;
    }
    if (failureAutoOpenRef.current) {
      failureAutoOpenRef.current = false;
      setOpen(false);
    }
  }, [defaultOpenOnError, inline, renderFailure]);

  const toggleDetails = () => {
    if (inline || !canExpand) return;
    failureAutoOpenRef.current = false;
    setOpen((value) => !value);
  };
  const inspectableAgent = agentInspection && onOpenAgent ? agentInspection : null;
  const inspectAgent = inspectableAgent && onOpenAgent
    ? () => onOpenAgent(inspectableAgent)
    : null;
  const toggleDiff = (index: number) => {
    setOpenDiffIndexes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div
      className={cn(rowPaddingClass, highlightError && renderFailure && "-mx-2 rounded-lg bg-red-500/[0.04] px-2")}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      {canExpand && !inline && !inspectAgent ? (
        <span id={detailStateLabelId} className="sr-only">
          {localizeText(`${open ? "Collapse" : "Expand"} ${isCommand ? "command" : "tool"} details:`)}
        </span>
      ) : null}
      {hasInspectableSkillTargets ? (
        <div className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}>
          <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
          <span
            id={summaryLabelId}
            className={cn(
              "min-w-0 flex-1 truncate text-foreground/84",
              compact ? "text-xs leading-5" : "text-sm leading-6",
            )}
            title={displaySummary}
          >
            {skillTargets.length === 1 ? (() => {
              const target = skillTargets[0]!;
              const openable = Boolean(onOpenSkill) && (canOpenSkill?.(target) ?? true);
              return openable ? (
                <>
                  <span>{localizeText("Use")} </span>
                  <button
                    type="button"
                    className="rounded-sm px-0.5 underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    aria-label={localizeText(`Open skill ${target.name}`)}
                    data-transcript-skill-target={target.name}
                    data-transcript-skill-path={target.path ?? undefined}
                    onClick={() => onOpenSkill?.(target)}
                  >
                    {target.name}
                  </button>
                  <span> {localizeText("skill")}</span>
                </>
              ) : (
                <span data-transcript-skill-target={target.name}>{displaySummary}</span>
              );
            })() : (
              <>
                <span>{localizeText("Use")} </span>
                {skillTargets.map((target, index) => {
                  const openable = Boolean(onOpenSkill) && (canOpenSkill?.(target) ?? true);
                  return (
                    <Fragment key={`${target.name}-${target.path ?? "unresolved"}-${index}`}>
                      {index > 0 ? ", " : null}
                      {openable ? (
                        <button
                          type="button"
                          className="rounded-sm px-0.5 underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          aria-label={localizeText(`Open skill ${target.name}`)}
                          data-transcript-skill-target={target.name}
                          data-transcript-skill-path={target.path ?? undefined}
                          onClick={() => onOpenSkill?.(target)}
                        >
                          {target.name}
                        </button>
                      ) : (
                        <span data-transcript-skill-target={target.name}>{target.name}</span>
                      )}
                    </Fragment>
                  );
                })}
                <span> {localizeText("skills")}</span>
              </>
            )}
          </span>
          <TranscriptChatActionTrailing
            duration={duration}
            statusText={statusText}
            statusTone={rowTone}
            statusId={statusLabelId}
          />
        </div>
      ) : image ? (
        <div>
          <div className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}>
            <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
            <button
              type="button"
              id={summaryLabelId}
              className={cn("min-w-0 flex-1 rounded-sm text-left text-foreground/84 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40", compact ? "text-xs leading-5" : "text-sm leading-6")}
              title={image.path}
              aria-expanded={imageOpen}
              aria-label={localizeText(`${imageOpen ? "Collapse" : "Preview"} image ${image.displayLabel}`)}
              data-transcript-image-target={image.path}
              onClick={() => setImageOpen((value) => !value)}
            >
              {localizeText("Viewed an image")}
            </button>
            <TranscriptChatActionTrailing
              duration={duration}
              statusText={statusText}
              statusTone={rowTone}
              statusId={statusLabelId}
            />
          </div>
          {imageOpen ? <TranscriptImageArtifact path={image.path} displayLabel={image.displayLabel} /> : null}
        </div>
      ) : hasOpenableFileTargets ? (
        fileTargetDetailsGated && !open ? (
          <button
            type="button"
            className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}
            onClick={toggleDetails}
            aria-expanded={open}
            data-testid="transcript-action-group-disclosure"
            data-transcript-action-row-disclosure="true"
          >
            <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
            <span className={cn("min-w-0 flex-1 truncate text-foreground/84", compact ? "text-xs leading-5" : "text-sm leading-6")}>
              {displaySummary}
            </span>
            <DisclosureChevron open={open} className="h-4 w-4 text-muted-foreground" />
          </button>
        ) : (
        <div className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}>
          <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
          <span
            id={summaryLabelId}
            className={cn(
              "flex min-w-0 flex-1 items-baseline gap-1 text-foreground/84",
              compact ? "text-xs leading-5" : "text-sm leading-6",
            )}
          >
            <span className="shrink-0">{localizeText(semantic.category === "edit" ? "Edited" : "Read")}{" "}</span>
            <span className="min-w-0 flex-1">
              {fileTargets.map((target, index) => {
                const displayName = transcriptFileDisplayName(target.label);
                return (
                  <span key={`${target.label}-${index}`}>
                    {index > 0 ? ", " : null}
                    {target.path ? (
                      <button
                        type="button"
                        className="inline-block max-w-full whitespace-normal break-words rounded-sm text-left align-top underline decoration-border underline-offset-4 transition-colors [overflow-wrap:anywhere] hover:text-foreground hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        aria-label={localizeText(`Open file ${displayName}`)}
                        data-transcript-file-target={target.path}
                        onClick={() => onOpenFile?.(target.path!, displayName)}
                      >
                        {displayName}
                      </button>
                    ) : (
                      <span className="[overflow-wrap:anywhere]" title="This relative file path has no trusted workspace root.">
                        {displayName}
                      </span>
                    )}
                  </span>
                );
              })}
            </span>
          </span>
          <TranscriptChatActionTrailing
            duration={duration}
            statusText={statusText}
            statusTone={rowTone}
            statusId={statusLabelId}
            disclosure={canExpand && !inline ? (
              <button
                type="button"
                className={cn(
                  "-my-1 inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
                  chevronOffsetClass,
                )}
                onClick={toggleDetails}
                aria-expanded={open}
                aria-labelledby={`${detailStateLabelId} ${summaryLabelId}${statusText ? ` ${statusLabelId}` : ""}`}
                data-transcript-action-row-disclosure="true"
              >
                <DisclosureChevron open={open} className="h-4 w-4" />
              </button>
            ) : null}
          />
        </div>
        )
      ) : fileChanges.length > 0 ? (
        <div>
          {fileChangeDetailsGated ? (
            <button
              type="button"
              className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}
              onClick={toggleDetails}
              aria-expanded={open}
              aria-labelledby={`${detailStateLabelId} ${summaryLabelId}${statusText ? ` ${statusLabelId}` : ""}`}
              data-testid="transcript-action-group-disclosure"
              data-transcript-action-row-disclosure="true"
            >
              <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
              <span id={summaryLabelId} className={cn("min-w-0 flex-1 truncate text-foreground/84", compact ? "text-xs leading-5" : "text-sm leading-6")}>
                {displaySummary}
              </span>
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
                <DisclosureChevron open={open} className="h-4 w-4" />
              </span>
            </button>
          ) : null}
          {(!fileChangeDetailsGated || open) && fileChanges.map((change, index) => {
            const parsed = change.diff ? parseUnifiedDiff(change.diff) : null;
            const hasHistoricalDiff = Boolean(
              fileChangeSucceeded
              && change.diff
              && parsed?.hasHunks
              && !parsed.binary,
            );
            const targetText = `${change.displayLabel}${change.diff ? ` +${change.additions} -${change.deletions}` : ""}`;
            return (
              <div key={`${change.path}-${index}`}>
                <div className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}>
                  <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
                  <span
                    className={cn("min-w-0 flex-1 break-words text-foreground/84", compact ? "text-xs leading-5" : "text-sm leading-6")}
                    title={change.movePath ? `${change.path} -> ${change.movePath}` : change.path}
                  >
                    Edited{" "}
                    {hasHistoricalDiff ? (
                      <button
                        type="button"
                        className="rounded-sm underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        aria-label={`${openDiffIndexes.has(index) ? "Collapse" : "Expand"} historical diff for ${change.displayLabel}`}
                        aria-expanded={openDiffIndexes.has(index)}
                        data-transcript-diff-target={change.path}
                        onClick={() => toggleDiff(index)}
                      >
                        {targetText}
                      </button>
                    ) : (
                      <span>{targetText}</span>
                    )}
                  </span>
                  <TranscriptChatActionTrailing
                    duration={duration}
                    statusText={statusText}
                    statusTone={rowTone}
                    statusId={statusLabelId}
                  />
                </div>
                {hasHistoricalDiff && openDiffIndexes.has(index) && change.diff ? (
                  <div className="ml-5">
                    <TranscriptUnifiedDiff
                      fileName={change.displayLabel}
                      diff={change.diff}
                      truncated={change.diffTruncated}
                      originalBytes={change.diffOriginalBytes}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <button
          type="button"
          className={cn("group/activity-row flex w-full text-left", rowAlignmentClass, rowGapClass)}
          onClick={inspectAgent ?? toggleDetails}
          aria-expanded={!inspectAgent && canExpand && !inline ? open : undefined}
          aria-label={inspectAgent
            ? localizeText(`Inspect agent ${inspectableAgent?.threadId}`)
            : undefined}
          aria-labelledby={!inspectAgent && canExpand && !inline
            ? `${detailStateLabelId} ${summaryLabelId}${statusText ? ` ${statusLabelId}` : ""}`
            : undefined}
          data-transcript-agent-inspect={inspectAgent ? inspectableAgent?.threadId : undefined}
        >
          <TranscriptChatActionIconCell category={semantic.category} status={iconStatus} compact={compact} toolName={block.name} input={block.input} />
          <span
            id={summaryLabelId}
            className={cn("min-w-0 flex-1 truncate text-foreground/84", compact ? "text-xs leading-5" : "text-sm leading-6")}
            title={displaySummary}
          >
            {displaySummary}
          </span>
          <TranscriptChatActionTrailing
            duration={duration}
            statusText={statusText}
            statusTone={rowTone}
            statusId={statusLabelId}
            disclosure={canExpand && !inline && !inspectAgent ? (
              <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/activity-row:opacity-100 group-focus-visible/activity-row:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                data-transcript-action-row-disclosure="true"
              >
                <DisclosureChevron open={open} className="block h-4 w-4" />
              </span>
            ) : null}
          />
        </button>
      )}
      {semantic.evidenceWarning && (open || !canExpand) ? (
        <div
          className="ml-5 mt-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-200"
          role="status"
          data-transcript-evidence-warning="true"
        >
          {semantic.evidenceWarning}
        </div>
      ) : null}
      {canExpand && open ? (
        rudderPresenter ? (
          <div className="motion-disclosure-enter ml-5 mt-2" data-rudder-semantic-presenter={rudderPresenter.toolName}>
            <RudderMcpSemanticPresenter block={block} />
          </div>
        ) : command ? (
          <CommandTerminalDetail
            command={requestText}
            output={responseText}
            status={visualStatus}
            className="motion-disclosure-enter ml-5 mt-2"
          />
        ) : (
          <div className="motion-disclosure-enter ml-5 mt-2 space-y-2 rounded-lg border border-border/35 bg-muted/10 p-2.5">
            <div>
              <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                {requestLabel}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                {requestText}
              </pre>
            </div>
            {requestParameters ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                  Parameters
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                  {requestParameters}
                </pre>
              </div>
            ) : null}
            {responseText ? (
              <div>
                <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                  Response
                </div>
                <ExpandableTranscriptResponsePre
                  text={responseText}
                  className={cn(
                    renderFailure ? "text-red-700 dark:text-red-300" : "text-foreground/80",
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
  onOpenSkill,
  canOpenSkill,
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
  onOpenSkill?: (target: TranscriptSkillTarget) => void;
  canOpenSkill?: (target: TranscriptSkillTarget) => boolean;
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
      onOpenSkill={onOpenSkill}
      canOpenSkill={canOpenSkill}
      agentInspection={transcriptAgentInspectionForTool(action.entry, agentInspections)}
      onOpenAgent={onOpenAgent}
      quiet={quiet}
    />
  );
}

function transcriptBlockForChatAction(action: ChatTranscriptAction): TranscriptBlock {
  if (action.type === "stdout") return action.entry;
  return {
    type: "tool",
    ts: action.entry.ts,
    endTs: action.entry.endTs,
    name: action.entry.name,
    toolUseId: action.entry.toolUseId,
    input: action.entry.input,
    result: action.entry.result,
    isError: action.entry.isError,
    status: action.entry.status,
    sourceEntryIds: action.entry.sourceEntryIds,
  };
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

export function formatChatActionSummary(
  actions: ChatTranscriptAction[],
  showFailureIndicators = true,
): string {
  const infos = actions
    .filter((action): action is Extract<ChatTranscriptAction, { type: "tool" }> => action.type === "tool")
    .map((action) => {
      const semantic = describeToolSemanticInfo(action.entry.name, action.entry.input);
      return showFailureIndicators ? semantic : neutralizeToolFailureSemanticInfo(semantic);
    });
  const stdoutCount = actions.filter((action) => action.type === "stdout").length;
  return formatSemanticDigest(infos, stdoutCount, { preferDirectSummary: true });
}

function transcriptActionGroupAnnotationBlock(
  actions: ChatTranscriptAction[],
  summary: string,
  tone: "info" | "error",
): Extract<TranscriptBlock, { type: "event" }> | null {
  if (actions.length < 2) return null;
  const sourceEntryIds = actions
    .flatMap((action) => action.entry.sourceEntryIds ?? [])
    .filter((id, index, ids) => ids.indexOf(id) === index);
  const firstAction = actions[0];
  if (!firstAction || sourceEntryIds.length === 0) return null;
  return {
    type: "event",
    ts: firstAction.entry.ts,
    label: "tool activity",
    tone,
    text: summary || "Tool details",
    sourceEntryIds,
  };
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
  onOpenSkill,
  canOpenSkill,
  agentInspections = EMPTY_AGENT_INSPECTIONS,
  onOpenAgent,
  annotationSource,
  runAnnotationContext,
  streaming = false,
}: {
  actions: ChatTranscriptAction[];
  density: TranscriptDensity;
  detailVariant: boolean;
  groupIndex: number;
  groupCount: number;
  onOpenFile?: (targetPath: string, label: string) => void;
  onOpenSkill?: (target: TranscriptSkillTarget) => void;
  canOpenSkill?: (target: TranscriptSkillTarget) => boolean;
  agentInspections?: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  annotationSource?: TranscriptAnnotationSourceContext;
  runAnnotationContext?: TranscriptRunAnnotationContext;
  streaming?: boolean;
}) {
  const showFailureIndicators = useToolCallFailureIndicators();
  const localizeText = useTranscriptText();
  const compact = density === "compact";
  const singleAction = actions[0];
  const hasSingleAction = actions.length === 1;
  const toolEntries = actions
    .filter((action): action is Extract<ChatTranscriptAction, { type: "tool" }> => action.type === "tool")
    .map((action) => action.entry);
  const allToolsErrored = areAllToolEntriesErrored(toolEntries);
  const shouldInlineSingleStdoutAction = hasSingleAction && singleAction?.type === "stdout";
  const shouldRenderSingleToolAction = hasSingleAction && singleAction?.type === "tool";
  const summary = localizeText(formatChatActionSummary(actions, showFailureIndicators));
  const highlightGroupError = showFailureIndicators && allToolsErrored && !detailVariant;
  const [detailsOpen, setDetailsOpen] = useState(() => (detailVariant ? false : highlightGroupError));
  const failureAutoOpenRef = useRef(!detailVariant && highlightGroupError);
  const summaryIcon = getChatActionIconInfo(actions[0]!);
  const summaryAgentAvatar = actions[0]?.type === "tool"
    ? getTranscriptAgentAvatarInfo(actions[0].entry.name, actions[0].entry.input)
    : null;
  const singleActionBlock = hasSingleAction && singleAction
    ? transcriptBlockForChatAction(singleAction)
    : null;
  const actionGroupBlock = detailVariant && runAnnotationContext
    ? transcriptActionGroupAnnotationBlock(actions, summary, highlightGroupError ? "error" : "info")
    : null;
  const actionGroupInteractionId = actionGroupBlock
    ? `action-group:${actions.map((action) => action.key).join("|")}`
    : undefined;
  const wrapSingleActionAnnotation = (content: ReactNode) => singleActionBlock && detailVariant && runAnnotationContext ? (
    <TranscriptRunAnnotationBlock
      block={singleActionBlock}
      presentation="detail"
      context={runAnnotationContext}
      streaming={streaming}
    >
      {content}
    </TranscriptRunAnnotationBlock>
  ) : content;

  const renderActionRow = (action: ChatTranscriptAction) => {
    const row = (
      <TranscriptChatActionRow
        action={action}
        density={density}
        onOpenFile={onOpenFile}
        onOpenSkill={onOpenSkill}
        canOpenSkill={canOpenSkill}
        agentInspections={agentInspections}
        onOpenAgent={onOpenAgent}
        quiet={!detailVariant}
      />
    );
    if (!detailVariant || !runAnnotationContext) {
      return <Fragment key={action.key}>{row}</Fragment>;
    }
    return (
      <TranscriptRunAnnotationBlock
        key={action.key}
        block={transcriptBlockForChatAction(action)}
        presentation="detail"
        context={runAnnotationContext}
        streaming={streaming}
      >
        {row}
      </TranscriptRunAnnotationBlock>
    );
  };

  useEffect(() => {
    if (!detailVariant && showFailureIndicators && allToolsErrored) {
      setDetailsOpen((current) => {
        if (!current) {
          failureAutoOpenRef.current = true;
          return true;
        }
        return current;
      });
      return;
    }
    if (failureAutoOpenRef.current) {
      failureAutoOpenRef.current = false;
      setDetailsOpen(false);
    }
  }, [detailVariant, showFailureIndicators, allToolsErrored]);

  const toggleDetails = () => {
    failureAutoOpenRef.current = false;
    setDetailsOpen((value) => !value);
  };

  if (shouldInlineSingleStdoutAction) {
    return wrapSingleActionAnnotation(
      <div className="divide-y divide-border/30">
        <TranscriptChatActionRow
          action={singleAction}
          density={density}
          inline
          agentInspections={agentInspections}
          onOpenAgent={onOpenAgent}
        />
      </div>
      ,
    );
  }

  if (shouldRenderSingleToolAction) {
    return wrapSingleActionAnnotation(
      <div className="divide-y divide-border/30">
        <TranscriptChatActionRow
          action={singleAction}
          density={density}
          defaultOpenOnError={false}
          highlightError={!detailVariant}
          onOpenFile={onOpenFile}
          onOpenSkill={onOpenSkill}
          canOpenSkill={canOpenSkill}
          agentInspections={agentInspections}
          onOpenAgent={onOpenAgent}
          quiet={!detailVariant}
        />
      </div>
      ,
    );
  }

  const labelSuffix = groupCount > 1 ? ` group ${groupIndex + 1}` : "";
  const expandedLabel = localizeText(detailsOpen
    ? `Collapse tool activity${labelSuffix}`
    : `Expand tool activity${labelSuffix}`);

  const summaryButton = (
    <button
      type="button"
      className={cn(
        "group/activity -mx-2 inline-flex max-w-full items-center rounded-lg px-2 py-1.5 text-left transition-colors",
        compact ? "gap-1.5" : "gap-2",
        highlightGroupError ? "hover:bg-red-500/[0.05]" : "hover:bg-muted/10",
      )}
      onClick={toggleDetails}
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
            status={highlightGroupError
              ? "error"
              : summaryIcon.status === "running"
                ? "running"
                : "neutral"}
          />
        ) : (
          <TranscriptActionIcon category={summaryIcon.category} status={highlightGroupError ? "error" : "neutral"} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn(
          "block truncate text-foreground/82",
          compact ? "text-xs" : "text-sm",
        )} title={summary || localizeText("Tool details")}>
          {summary || localizeText("Tool details")}
        </span>
      </span>
      <span
        className={cn(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/activity:opacity-100 group-focus-visible/activity:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100",
        )}
        data-testid="transcript-action-group-disclosure"
        data-transcript-disclosure-chevron="true"
      >
        <DisclosureChevron open={detailsOpen} className="h-4 w-4" />
      </span>
    </button>
  );

  return (
    <div>
      {actionGroupBlock ? (
        <TranscriptRunAnnotationBlock
          block={actionGroupBlock}
          presentation="detail"
          context={runAnnotationContext}
          streaming={streaming}
          interactionId={actionGroupInteractionId}
        >
          {summaryButton}
        </TranscriptRunAnnotationBlock>
      ) : summaryButton}

      {detailsOpen ? (
        <div className="motion-disclosure-enter mt-0.5">
          {actions.map(renderActionRow)}
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
  onOpenSkill,
  canOpenSkill,
  agentInspections = EMPTY_AGENT_INSPECTIONS,
  onOpenAgent,
  annotationSource,
  sentAnnotationContext,
  runAnnotationContext,
  streaming = false,
}: {
  turn: ChatTranscriptTurn;
  density: TranscriptDensity;
  thinkingClassName?: string;
  variant?: "chat" | "detail";
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  onOpenFile?: (targetPath: string, label: string) => void;
  onOpenSkill?: (target: TranscriptSkillTarget) => void;
  canOpenSkill?: (target: TranscriptSkillTarget) => boolean;
  agentInspections?: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  annotationSource?: TranscriptAnnotationSourceContext;
  sentAnnotationContext?: TranscriptSentAnnotationContext;
  runAnnotationContext?: TranscriptRunAnnotationContext;
  streaming?: boolean;
}) {
  const detailVariant = variant === "detail";
  const localizeText = useTranscriptText();
  const segments = segmentChatTranscriptBlocks(turn.blocks);
  const actionGroupCount = segments.filter((segment) => segment.type === "actions").length;
  const content = segments.length > 0 ? (
    <div className={cn("w-full min-w-0", density === "compact" ? "space-y-1" : "space-y-3")} title={getTranscriptTimestampTitle(turn.ts)}>
      {segments.map((segment, index) => {
        if (detailVariant) {
          return segment.type === "block" ? (
            <Fragment key={`${segment.block.type}-${segment.block.ts}-${index}`}>
              {renderTranscriptBlock({
                block: segment.block,
                index,
                density,
                presentation: "detail",
                collapseStdout: true,
                thinkingClassName,
                onMarkdownLinkClick,
                annotationSource,
                sentAnnotationContext,
                runAnnotationContext,
                localizeText,
                streaming,
              })}
            </Fragment>
          ) : (
            <TranscriptChatActionGroup
              key={segment.key}
              actions={segment.actions}
              density={density}
              detailVariant
              groupIndex={segments.slice(0, index).filter((item) => item.type === "actions").length}
              groupCount={actionGroupCount}
              onOpenFile={onOpenFile}
              onOpenSkill={onOpenSkill}
              canOpenSkill={canOpenSkill}
              agentInspections={agentInspections}
              onOpenAgent={onOpenAgent}
              runAnnotationContext={runAnnotationContext}
              streaming={streaming}
            />
          );
        }

        return segment.type === "block"
          ? (
            <div
              key={`${segment.block.type}-${segment.block.ts}-${index}`}
              data-transcript-chat-column={
                segment.block.type === "message" && segment.block.source === "steer"
                  ? "full"
                  : "reading"
              }
              className={cn(
                segment.block.type === "message" && segment.block.source === "steer"
                  ? CHAT_FULL_COLUMN_CLASS
                  : CHAT_READING_COLUMN_CLASS,
              )}
            >
              {renderTranscriptBlock({
                block: segment.block,
                index,
                density,
                presentation: "chat",
                collapseStdout: true,
                thinkingClassName,
                onMarkdownLinkClick,
                annotationSource,
                sentAnnotationContext,
                runAnnotationContext,
                localizeText,
              })}
            </div>
          )
          : (
            <div
              key={segment.key}
              data-transcript-chat-column="reading"
              className={CHAT_READING_COLUMN_CLASS}
            >
              <TranscriptChatActionGroup
                actions={segment.actions}
                density={density}
                detailVariant={detailVariant}
                groupIndex={segments.slice(0, index).filter((item) => item.type === "actions").length}
                groupCount={actionGroupCount}
                onOpenFile={onOpenFile}
                onOpenSkill={onOpenSkill}
                canOpenSkill={canOpenSkill}
                agentInspections={agentInspections}
                onOpenAgent={onOpenAgent}
                runAnnotationContext={runAnnotationContext}
                streaming={streaming}
              />
            </div>
          );
      })}
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
  localizeText = (text) => text,
  showDeveloperDiagnostics,
  onMarkdownLinkClick,
  onOpenFile,
  onOpenSkill,
  canOpenSkill,
  agentInspections,
  onOpenAgent,
  annotationSource,
  sentAnnotationContext,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  streaming: boolean;
  collapseStdout: boolean;
  thinkingClassName?: string;
  hideAssistantMessages: boolean;
  hiddenAssistantMessageText?: string | null;
  localizeText?: (text: string) => string;
  showDeveloperDiagnostics: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  onOpenFile?: (targetPath: string, label: string) => void;
  onOpenSkill?: (target: TranscriptSkillTarget) => void;
  canOpenSkill?: (target: TranscriptSkillTarget) => boolean;
  agentInspections: Map<string, TranscriptAgentInspection>;
  onOpenAgent?: (agent: TranscriptAgentInspection) => void;
  annotationSource?: TranscriptAnnotationSourceContext;
  sentAnnotationContext?: TranscriptSentAnnotationContext;
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
    <TranscriptTextContext.Provider value={localizeText}>
      <div className="w-full min-w-0 space-y-3">
      {preludeBlocks.map((block, index) => {
        const fullWidth = block.type === "message" && block.source === "steer";
        return (
          <div
            key={`${block.type}-${block.ts}-${index}`}
            data-transcript-chat-column={fullWidth ? "full" : "reading"}
            className={fullWidth ? CHAT_FULL_COLUMN_CLASS : CHAT_READING_COLUMN_CLASS}
          >
            {renderTranscriptBlock({
              block,
              index,
              density,
              presentation: "chat",
              collapseStdout,
              thinkingClassName,
              onMarkdownLinkClick,
              annotationSource,
              sentAnnotationContext,
              localizeText,
            })}
          </div>
        );
      })}
      {turns.map((turn) => (
        <TranscriptChatTurn
          key={turn.key}
          turn={turn}
          density={density}
          thinkingClassName={thinkingClassName}
          onMarkdownLinkClick={onMarkdownLinkClick}
          onOpenFile={onOpenFile}
          onOpenSkill={onOpenSkill}
          canOpenSkill={canOpenSkill}
          agentInspections={agentInspections}
          onOpenAgent={onOpenAgent}
          annotationSource={annotationSource}
          sentAnnotationContext={sentAnnotationContext}
        />
      ))}
      </div>
    </TranscriptTextContext.Provider>
  );
}
