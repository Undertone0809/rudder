import { Fragment, useMemo } from "react";
import type { TranscriptEntry } from "../../agent-runtimes";
import { cn, formatTokens } from "../../lib/utils";
import { formatTranscriptLabel, TranscriptActivityRow, TranscriptEventRow, TranscriptMessageBlock, TranscriptStdoutRow, TranscriptThinkingBlock, TranscriptTodoListRow, TranscriptToolCard } from "./RunTranscriptView.blocks";
import { TranscriptChatTurn } from "./RunTranscriptView.chat";
import { TranscriptBlock, TranscriptDensity, TranscriptMarkdownLinkClickHandler } from "./RunTranscriptView.common";
import { formatTodoListRaw, normalizeChatTranscriptTurns, parseClaudeSkillContext } from "./RunTranscriptView.normalize";
import { formatToolPayload } from "./RunTranscriptView.semantic";

export interface DetailTimelineRow {
  key: string;
  block: Exclude<TranscriptBlock, { type: "command_group" }>;
}

export function expandDetailTimelineBlocks(blocks: TranscriptBlock[]): DetailTimelineRow[] {
  const rows: DetailTimelineRow[] = [];

  for (const block of blocks) {
    if (block.type === "command_group") {
      block.items.forEach((item, index) => {
        rows.push({
          key: `${block.ts}-command-${index}-${item.ts}`,
          block: {
            type: "tool",
            ts: item.ts,
            endTs: item.endTs,
            name: item.name,
            input: item.input,
            result: item.result,
            isError: item.isError,
            status: item.status,
          },
        });
      });
      continue;
    }

    if (block.type === "message") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "thinking") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "tool") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "todo_list") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "activity") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "memory_update") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    if (block.type === "event") {
      rows.push({
        key: `${block.type}-${block.ts}-${rows.length}`,
        block,
      });
      continue;
    }

    rows.push({
      key: `${block.type}-${block.ts}-${rows.length}`,
      block,
    });
  }

  return rows;
}

export function TranscriptDetailTimeline({
  entries,
  density,
  streaming,
  thinkingClassName,
  showDeveloperDiagnostics,
  onMarkdownLinkClick,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
  streaming: boolean;
  thinkingClassName?: string;
  showDeveloperDiagnostics: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
}) {
  const { preludeBlocks, turns } = useMemo(
    () => normalizeChatTranscriptTurns(entries, streaming, { showDeveloperDiagnostics }),
    [entries, streaming, showDeveloperDiagnostics],
  );
  const rows = expandDetailTimelineBlocks(preludeBlocks);

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        return (
          <Fragment key={row.key}>
            {row.block.type === "message" && (
              <TranscriptMessageBlock
                block={row.block}
                density={density}
                presentation="detail"
                className="text-sm leading-7"
                collapsibleSummary={row.block.role === "user"}
                onMarkdownLinkClick={onMarkdownLinkClick}
              />
            )}
            {row.block.type === "thinking" && (
              <TranscriptThinkingBlock
                block={row.block}
                density={density}
                className={thinkingClassName}
                collapsibleSummary
                onMarkdownLinkClick={onMarkdownLinkClick}
              />
            )}
            {row.block.type === "tool" && (
              <TranscriptToolCard block={row.block} density={density} presentation="detail" />
            )}
            {row.block.type === "todo_list" && (
              <TranscriptTodoListRow block={row.block} density={density} presentation="detail" />
            )}
            {row.block.type === "activity" && <TranscriptActivityRow block={row.block} density={density} />}
            {row.block.type === "event" && (
              <TranscriptEventRow block={row.block} density={density} presentation="detail" />
            )}
            {row.block.type === "stdout" && (
              <TranscriptStdoutRow
                block={row.block}
                density={density}
                collapseByDefault
                presentation="detail"
              />
            )}
          </Fragment>
        );
      })}
      {turns.map((turn, index) => {
        return (
          <div
            key={turn.key}
            className={cn(index === turns.length - 1 && streaming && "animate-in fade-in slide-in-from-bottom-1 duration-300")}
          >
            <TranscriptChatTurn
              turn={turn}
              density={density}
              thinkingClassName={thinkingClassName}
              variant="detail"
              onMarkdownLinkClick={onMarkdownLinkClick}
            />
          </div>
        );
      })}
    </div>
  );
}

export function RawTranscriptView({
  entries,
  density,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
}) {
  const compact = density === "compact";
  return (
    <div className={cn("font-mono", compact ? "space-y-1 text-[11px]" : "space-y-1.5 text-xs")}>
      {entries.map((entry, idx) => (
        <div
          key={`${entry.kind}-${entry.ts}-${idx}`}
          className={cn(
            "grid gap-x-3",
            "grid-cols-[auto_1fr]",
          )}
        >
          <span className="text-[10px] tracking-[0.06em] text-muted-foreground">
            {formatRawTranscriptLabel(entry)}
          </span>
          <pre className="min-w-0 whitespace-pre-wrap break-words text-foreground/80">
            {entry.kind === "tool_call"
              ? `${entry.name}\n${formatToolPayload(entry.input)}`
              : entry.kind === "tool_result"
                ? formatToolPayload(entry.content)
                : entry.kind === "todo_list"
                  ? formatTodoListRaw(entry.items)
                  : entry.kind === "result"
                  ? `${entry.text}\n${formatTokens(entry.inputTokens)} / ${formatTokens(entry.outputTokens)} / $${entry.costUsd.toFixed(6)}`
                  : entry.kind === "init"
                    ? `model=${entry.model}${entry.sessionId ? ` session=${entry.sessionId}` : ""}`
                    : entry.text}
          </pre>
        </div>
      ))}
    </div>
  );
}

function formatRawTranscriptLabel(entry: TranscriptEntry): string {
  return entry.kind === "user" && parseClaudeSkillContext(entry.text)
    ? "Skill Context"
    : formatTranscriptLabel(entry.kind);
}
