import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@rudderhq/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import type { TranscriptEntry } from "../agent-runtimes";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatRunElapsedDuration, relativeTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import { AgentIdentity } from "./AgentAvatar";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
import { filterRoutineStdout } from "./transcript/RunTranscriptView.common";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_PREVIEW_TEXT_MAX = 260;

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

interface ActiveAgentsPanelProps {
  orgId: string;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function summarizeDashboardPreviewText(value: string): string {
  const lines = value.split(/\r?\n/);
  const previewLines: string[] = [];
  let sawStructuredEvent = false;
  let commandCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const record = readRecord(JSON.parse(trimmed));
      const item = readRecord(record?.["item"]);
      const itemType = typeof item?.["type"] === "string" ? item["type"] : null;

      if (typeof record?.["type"] === "string") {
        sawStructuredEvent = true;
      }

      if (itemType === "agent_message") {
        const text = typeof item?.["text"] === "string"
          ? filterRoutineStdout(item["text"], false)
          : "";
        if (text) previewLines.push(text);
        continue;
      }

      if (itemType === "command_execution" && record?.["type"] === "item.completed") {
        commandCount += 1;
        continue;
      }

      if (typeof record?.["type"] === "string") {
        continue;
      }
    } catch {
      previewLines.push(trimmed);
      continue;
    }
  }

  if (commandCount > 0) {
    previewLines.push(`Ran ${commandCount} command${commandCount === 1 ? "" : "s"}.`);
  }

  const text = sawStructuredEvent ? previewLines.slice(-3).join("\n\n").trim() : value;
  if (text.length <= DASHBOARD_RUN_PREVIEW_TEXT_MAX) return text;
  return `${text.slice(0, DASHBOARD_RUN_PREVIEW_TEXT_MAX).trimEnd()}...`;
}

export function filterDashboardRunPreviewTranscript(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.flatMap((entry) => {
    if (!("text" in entry) || typeof entry.text !== "string") return [entry];
    const text = summarizeDashboardPreviewText(filterRoutineStdout(entry.text, false));
    return text ? [{ ...entry, text }] : [];
  });
}

export function ActiveAgentsPanel({ orgId }: ActiveAgentsPanelProps) {
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(orgId), "dashboard"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(orgId, MIN_DASHBOARD_RUNS),
  });

  const runs = liveRuns ?? [];
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(orgId),
    queryFn: () => issuesApi.list(orgId),
    enabled: runs.length > 0,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(orgId),
    queryFn: () => agentsApi.list(orgId),
    enabled: runs.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);
  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs,
    orgId,
    maxChunksPerRun: 120,
  });

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold tracking-[0.04em] text-muted-foreground">
        Agents
      </h3>
      {runs.length === 0 ? (
        <div className="surface-panel rounded-[var(--radius-lg)] p-4">
          <p className="text-sm text-muted-foreground">No recent agent runs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-4">
          {runs.map((run) => (
            <AgentRunCard
              key={run.id}
              run={run}
              agent={agentById.get(run.agentId) ?? null}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? []}
              hasOutput={hasOutputForRun(run.id)}
              isActive={isRunActive(run)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRunCard({
  run,
  agent,
  issue,
  transcript,
  hasOutput,
  isActive,
}: {
  run: LiveRunForIssue;
  agent: Agent | null;
  issue?: Issue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isActive: boolean;
}) {
  const [, setElapsedTick] = useState(0);

  useEffect(() => {
    if (!isActive) return;
    const id = window.setInterval(() => setElapsedTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(id);
  }, [isActive]);

  const activeDuration = formatRunElapsedDuration(run.startedAt ?? run.createdAt);
  const previewTranscript = useMemo(
    () => filterDashboardRunPreviewTranscript(transcript),
    [transcript],
  );

  return (
    <div className={cn(
      "motion-list-enter flex h-[292px] flex-col overflow-hidden rounded-[var(--radius-lg)] border",
      isActive
        ? "motion-live-surface border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-proposal)_68%,transparent)] shadow-[var(--shadow-md)]"
        : "surface-panel",
    )}>
      <div className="border-b panel-divider px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive ? (
                <span className="motion-live-dot relative flex h-2.5 w-2.5 shrink-0 text-[color:var(--accent-base)]">
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[color:var(--accent-strong)]" />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              )}
              {agent ? (
                <AgentIdentity name={agent.name} icon={agent.icon} role={agent.role} size="sm" className="[&>span:last-child]:!text-[11px]" />
              ) : (
                <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{isActive ? `Live for ${activeDuration ?? "now"}` : run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`}</span>
            </div>
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_86%,transparent)] px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        </div>

        {run.issueId && (
          <div className="surface-inset mt-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs">
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isActive ? "text-[color:var(--accent-strong)]" : "text-muted-foreground hover:text-foreground",
              )}
              title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
            >
              {issue?.identifier ?? run.issueId.slice(0, 8)}
              {issue?.title ? ` - ${issue.title}` : ""}
            </Link>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        <RunTranscriptView
          className="dashboard-run-preview"
          entries={previewTranscript}
          density="compact"
          limit={5}
          streaming={isActive}
          collapseStdout
          presentation="chat"
          thinkingClassName="!text-[10px] !leading-4"
          emptyMessage={hasOutput ? "Waiting for transcript parsing..." : isActive ? "Waiting for output..." : "No transcript captured."}
        />
      </div>
    </div>
  );
}
