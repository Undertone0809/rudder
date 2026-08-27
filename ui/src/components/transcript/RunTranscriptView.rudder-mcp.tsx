import { AgentIdentity } from "@/components/AgentAvatar";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "@/lib/organization-routes";
import { cn } from "@/lib/utils";
import type { AgentRole } from "@rudderhq/shared";
import {
  AlertCircle,
  Check,
  CircleDot,
  FolderKanban,
  Goal,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import type { RunTranscriptViewProps, TranscriptAgentDirectoryEntry, TranscriptToolCardEntry } from "./RunTranscriptView.common";
import { extractMcpToolDetails } from "./RunTranscriptView.semantic";

export type RudderMcpPresenterKind = "rail" | "summary" | "receipt";
export type RudderMcpDomain = "goal" | "issue" | "project" | "approval" | "automation";

interface RudderMcpPresenterDefinition {
  domain: RudderMcpDomain;
  kind: RudderMcpPresenterKind;
  action: string;
}

const registry = {
  rudder_goal_list: { domain: "goal", kind: "rail", action: "Goals" },
  rudder_goal_context: { domain: "goal", kind: "summary", action: "Goal context" },
  rudder_goal_progress: { domain: "goal", kind: "receipt", action: "Progress recorded" },
  rudder_goal_checkpoint: { domain: "goal", kind: "receipt", action: "Checkpoint saved" },
  rudder_goal_change_propose: { domain: "goal", kind: "receipt", action: "Change proposed" },
  rudder_goal_result_propose: { domain: "goal", kind: "receipt", action: "Result proposed" },

  rudder_issue_list: { domain: "issue", kind: "rail", action: "Issues" },
  rudder_issue_search: { domain: "issue", kind: "rail", action: "Issue search" },
  rudder_issue_comments_list: { domain: "issue", kind: "rail", action: "Comments" },
  rudder_issue_get: { domain: "issue", kind: "summary", action: "Issue" },
  rudder_issue_context: { domain: "issue", kind: "summary", action: "Issue context" },
  rudder_issue_comments_get: { domain: "issue", kind: "summary", action: "Comment" },
  rudder_issue_checkout: { domain: "issue", kind: "receipt", action: "Issue checked out" },
  rudder_issue_comment: { domain: "issue", kind: "receipt", action: "Comment added" },
  rudder_issue_update: { domain: "issue", kind: "receipt", action: "Issue updated" },
  rudder_issue_review: { domain: "issue", kind: "receipt", action: "Review decision recorded" },
  rudder_issue_commit: { domain: "issue", kind: "receipt", action: "Commit recorded" },
  rudder_issue_done: { domain: "issue", kind: "receipt", action: "Issue updated" },
  rudder_issue_block: { domain: "issue", kind: "receipt", action: "Assistance claim recorded" },
  rudder_issue_create: { domain: "issue", kind: "receipt", action: "Issue created" },

  rudder_project_list: { domain: "project", kind: "rail", action: "Projects" },
  rudder_project_get: { domain: "project", kind: "summary", action: "Project" },
  rudder_project_create: { domain: "project", kind: "receipt", action: "Project created" },
  rudder_project_update: { domain: "project", kind: "receipt", action: "Project updated" },

  rudder_approval_issues: { domain: "approval", kind: "rail", action: "Approval issues" },
  rudder_approval_get: { domain: "approval", kind: "summary", action: "Approval" },
  rudder_approval_comment: { domain: "approval", kind: "receipt", action: "Approval comment added" },

  rudder_automation_list: { domain: "automation", kind: "rail", action: "Automations" },
  rudder_automation_runs: { domain: "automation", kind: "rail", action: "Automation runs" },
  rudder_automation_triggers_list: { domain: "automation", kind: "rail", action: "Automation triggers" },
  rudder_automation_get: { domain: "automation", kind: "summary", action: "Automation" },
  rudder_automation_triggers_create: { domain: "automation", kind: "receipt", action: "Trigger created" },
  rudder_automation_triggers_update: { domain: "automation", kind: "receipt", action: "Trigger updated" },
  rudder_automation_triggers_delete: { domain: "automation", kind: "receipt", action: "Trigger deleted" },
  rudder_automation_triggers_rotate_secret: { domain: "automation", kind: "receipt", action: "Webhook secret rotated" },
  rudder_automation_create: { domain: "automation", kind: "receipt", action: "Automation created" },
  rudder_automation_update: { domain: "automation", kind: "receipt", action: "Automation updated" },
  rudder_automation_enable: { domain: "automation", kind: "receipt", action: "Automation enabled" },
  rudder_automation_disable: { domain: "automation", kind: "receipt", action: "Automation disabled" },
  rudder_automation_run: { domain: "automation", kind: "receipt", action: "Automation run queued" },
} as const satisfies Record<string, RudderMcpPresenterDefinition>;

const TRUSTED_RUDDER_MCP_SERVERS = new Set(["rudder", "rudder-tools", "rudder_tools"]);

export type CoveredRudderMcpToolName = keyof typeof registry;
export const RUDDER_MCP_PRESENTER_REGISTRY: Readonly<Record<CoveredRudderMcpToolName, RudderMcpPresenterDefinition>> = registry;

interface PresenterState {
  mounted: number;
  scrollLeft: number;
}

interface PresenterStateStore {
  agents: TranscriptAgentDirectoryEntry[];
  triggerAutomationParents: ReadonlyMap<string, string>;
  get: (key: string) => PresenterState;
  update: (key: string, patch: Partial<PresenterState>) => void;
}

const RudderMcpPresenterContext = createContext<PresenterStateStore | null>(null);

export function RudderMcpPresenterProvider({
  agents = [],
  entries = [],
  triggerAutomationParents,
  children,
}: {
  agents?: TranscriptAgentDirectoryEntry[];
  entries?: RunTranscriptViewProps["entries"];
  triggerAutomationParents?: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  const statesRef = useRef(new Map<string, PresenterState>());
  const get = useCallback((key: string) => statesRef.current.get(key) ?? { mounted: 6, scrollLeft: 0 }, []);
  const update = useCallback((key: string, patch: Partial<PresenterState>) => {
    const current = statesRef.current.get(key) ?? { mounted: 6, scrollLeft: 0 };
    statesRef.current.set(key, { ...current, ...patch });
  }, []);
  const collectedTriggerParents = useMemo(
    () => triggerAutomationParents ?? collectRudderMcpTriggerAutomationParents(entries),
    [entries, triggerAutomationParents],
  );
  const value = useMemo(
    () => ({ agents, triggerAutomationParents: collectedTriggerParents, get, update }),
    [agents, collectedTriggerParents, get, update],
  );
  return <RudderMcpPresenterContext.Provider value={value}>{children}</RudderMcpPresenterContext.Provider>;
}

function normalizeToolName(name: string, input: unknown): CoveredRudderMcpToolName | null {
  const directCandidate = name.trim().toLowerCase().replace(/-/g, "_");
  if (Object.prototype.hasOwnProperty.call(registry, directCandidate)) {
    return directCandidate as CoveredRudderMcpToolName;
  }
  const detail = extractMcpToolDetails(name, input);
  const server = detail?.server?.trim().toLowerCase();
  if (!server || !TRUSTED_RUDDER_MCP_SERVERS.has(server)) return null;
  const candidate = (detail?.tool ?? "").trim().toLowerCase().replace(/-/g, "_");
  return Object.prototype.hasOwnProperty.call(registry, candidate)
    ? candidate as CoveredRudderMcpToolName
    : null;
}

export function getRudderMcpPresenterDefinition(name: string, input?: unknown) {
  const toolName = normalizeToolName(name, input);
  return toolName ? { toolName, ...registry[toolName] } : null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function parseRudderMcpResult(result: string | undefined): unknown {
  let parsed = parseJson(result);
  const envelope = asRecord(parsed);
  if (envelope && Object.prototype.hasOwnProperty.call(envelope, "structuredContent")) {
    parsed = envelope.structuredContent;
  } else if (envelope && Array.isArray(envelope.content)) {
    const text = envelope.content
      .map(asRecord)
      .find((part) => part?.type === "text" && typeof part.text === "string")?.text;
    parsed = parseJson(text);
  }
  const structured = asRecord(parsed);
  if (structured && Object.prototype.hasOwnProperty.call(structured, "result")) {
    parsed = parseJson(structured.result);
  }
  return parsed;
}

function readString(record: JsonRecord | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function readBoolean(record: JsonRecord | null, keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof record?.[key] === "boolean") return record[key] as boolean;
  }
  return null;
}

function nestedRecord(record: JsonRecord | null, keys: string[]): JsonRecord | null {
  for (const key of keys) {
    const nested = asRecord(record?.[key]);
    if (nested) return nested;
  }
  return null;
}

function toolArgs(block: TranscriptToolCardEntry) {
  return extractMcpToolDetails(block.name, block.input)?.args ?? asRecord(block.input);
}

function valueRecord(value: unknown, domain: RudderMcpDomain): JsonRecord | null {
  const direct = asRecord(value);
  if (!direct) return null;
  return nestedRecord(direct, [domain, "item", "data", "comment", "trigger", "run", "proposal", "activity", "checkpoint"])
    ?? direct;
}

const collectionKeys: Record<RudderMcpDomain, string[]> = {
  goal: ["goals", "items", "results", "data"],
  issue: ["issues", "comments", "items", "results", "data"],
  project: ["projects", "items", "results", "data"],
  approval: ["issues", "approvals", "items", "results", "data"],
  automation: ["automations", "runs", "triggers", "recentRuns", "items", "results", "data"],
};

function collectionFrom(value: unknown, domain: RudderMcpDomain): JsonRecord[] | null {
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const record = asRecord(value);
  if (!record) return null;
  for (const key of collectionKeys[domain]) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
    }
  }
  return null;
}

function triggerRecordsFrom(value: unknown) {
  const collection = collectionFrom(value, "automation");
  if (collection) return collection;
  const record = valueRecord(value, "automation");
  return record ? [record] : [];
}

export function collectRudderMcpTriggerAutomationParents(entries: RunTranscriptViewProps["entries"]) {
  const calls = new Map<string, { name: string; input: unknown }>();
  const parents = new Map<string, string>();

  for (const entry of entries) {
    if (entry.kind === "tool_call" && entry.toolUseId) {
      calls.set(entry.toolUseId, { name: entry.name, input: entry.input });
      continue;
    }
    if (entry.kind !== "tool_result") continue;

    const call = calls.get(entry.toolUseId);
    const resolved = call ? getRudderMcpPresenterDefinition(call.name, call.input) : null;
    if (!resolved?.toolName.includes("automation_triggers")) continue;

    const args = extractMcpToolDetails(call!.name, call!.input)?.args ?? asRecord(call!.input);
    const inputTriggerId = readString(args, ["trigger", "triggerId", "trigger_id"]);
    const inputAutomationId = readString(args, ["automation", "automationId", "automation_id"]);
    if (inputTriggerId && inputAutomationId) parents.set(inputTriggerId, inputAutomationId);

    const parsed = parseRudderMcpResult(entry.content);
    for (const record of triggerRecordsFrom(parsed)) {
      const triggerId = readString(record, ["triggerId", "id"]);
      const automationId = readString(record, ["automationId"]);
      if (triggerId && automationId) parents.set(triggerId, automationId);
    }
  }

  return parents;
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

function organizationAwareTarget(target: string | null) {
  if (!target || typeof window === "undefined") return target;
  return applyOrganizationPrefix(target, extractOrganizationPrefixFromPath(window.location.pathname));
}

function issueRef(record: JsonRecord | null, args: JsonRecord | null) {
  return readString(record, ["identifier", "issueIdentifier", "issueId", "id"])
    ?? readString(args, ["issue", "issueId", "issue_id", "idOrIdentifier", "id"]);
}

function targetFor(
  domain: RudderMcpDomain,
  record: JsonRecord | null,
  args: JsonRecord | null,
  toolName: CoveredRudderMcpToolName,
  triggerAutomationParents: ReadonlyMap<string, string>,
): string | null {
  if (domain === "issue") {
    const ref = issueRef(record, args);
    if (!ref) return null;
    const commentId = toolName.includes("comment") ? readString(record, ["id", "commentId"]) : null;
    return `/issues/${encodePath(ref)}${commentId ? `#comment-${encodePath(commentId)}` : ""}`;
  }
  if (domain === "goal") {
    const id = readString(record, ["goalId", "id"]) ?? readString(args, ["goal", "goalId", "goal_id"]);
    return id ? `/goals/${encodePath(id)}` : null;
  }
  if (domain === "project") {
    const id = readString(record, ["id", "shortname", "projectId"])
      ?? readString(args, ["project", "projectId", "project_id", "projectRef"]);
    return id ? `/projects/${encodePath(id)}` : null;
  }
  if (domain === "approval") {
    const id = readString(record, ["approvalId", "id"])
      ?? readString(args, ["approval", "approvalId", "approval_id"]);
    return id ? `/messenger/approvals/${encodePath(id)}` : null;
  }

  const linkedIssue = nestedRecord(record, ["linkedIssue", "issue"]);
  const linkedIssueRef = readString(linkedIssue, ["identifier", "id"])
    ?? readString(record, ["linkedIssueIdentifier", "linkedIssueId"]);
  if (linkedIssueRef && (toolName === "rudder_automation_runs" || toolName === "rudder_automation_run")) {
    return `/issues/${encodePath(linkedIssueRef)}`;
  }
  const chatId = readString(record, ["linkedChatConversationId", "chatConversationId"])
    ?? readString(nestedRecord(record, ["linkedChatConversation", "chatConversation"]), ["id"]);
  if (chatId && (toolName === "rudder_automation_runs" || toolName === "rudder_automation_run")) {
    return `/messenger/chat/${encodePath(chatId)}`;
  }
  const triggerId = toolName.includes("triggers")
    ? readString(record, ["triggerId", "id"]) ?? readString(args, ["trigger", "triggerId", "trigger_id"])
    : null;
  const id = readString(record, ["automationId"])
    ?? readString(args, ["automation", "automationId", "automation_id"])
    ?? (triggerId ? triggerAutomationParents.get(triggerId) ?? null : null)
    ?? (toolName.includes("triggers") ? null : readString(record, ["id"]));
  return id ? `/automations/${encodePath(id)}` : null;
}

function presenterDomain(
  definition: RudderMcpPresenterDefinition,
  toolName: CoveredRudderMcpToolName,
): RudderMcpDomain {
  return toolName === "rudder_approval_issues" ? "issue" : definition.domain;
}

function statusLabel(status: string | null) {
  if (!status) return null;
  return status.replace(/_/g, " ");
}

interface SemanticCardModel {
  key: string;
  eyebrow: string;
  title: string | null;
  description: string | null;
  commentBody: string | null;
  status: string | null;
  target: string | null;
  agentRef: string | null;
  timestamp: string | null;
}

function cardModel(
  record: JsonRecord,
  definition: RudderMcpPresenterDefinition,
  toolName: CoveredRudderMcpToolName,
  args: JsonRecord | null,
  triggerAutomationParents: ReadonlyMap<string, string>,
  index: number,
): SemanticCardModel {
  const domain = definition.domain;
  const title = readString(record, ["title", "name", "summary", "label", "body", "identifier"])
    ?? (domain === "automation" && toolName === "rudder_automation_runs" ? `Run ${readString(record, ["id"]) ?? index + 1}` : null)
    ?? (domain === "automation" && toolName.includes("triggers")
      ? readString(record, ["kind", "type"])?.replace(/_/g, " ").concat(" trigger") ?? null
      : null)
    ?? readString(record, ["publicId", "shortId", "id"]);
  const description = readString(record, [
    "description", "instructions", "body", "summary", "rationale", "riskSummary", "failureReason", "prompt", "decisionNote",
  ]);
  const commentBody = toolName.includes("comment")
    ? readString(record, ["body", "commentBody", "content", "text"])
    : null;
  const status = statusLabel(readString(record, ["status", "lifecycle", "decision", "state", "kind", "priority"]));
  const agentRef = readString(record, [
    "assigneeAgentId", "ownerAgentId", "authorAgentId", "createdByAgentId", "requestedByAgentId", "agentId", "leadAgentId",
  ]);
  const timestamp = readString(record, ["updatedAt", "createdAt", "triggeredAt", "lastRotatedAt", "nextRunAt", "completedAt"]);
  return {
    key: readString(record, ["id", "identifier", "publicId"]) ?? `${toolName}-${index}`,
    eyebrow: domain === "automation" && toolName === "rudder_automation_runs"
      ? "Automation run"
      : domain === "automation" && toolName.includes("triggers")
        ? "Automation trigger"
        : domain === "issue" && toolName.includes("comments")
          ? "Comment"
          : domain[0]!.toUpperCase() + domain.slice(1),
    title,
    description: description === title ? null : description,
    commentBody,
    status,
    target: targetFor(domain, record, args, toolName, triggerAutomationParents),
    agentRef,
    timestamp,
  };
}

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function domainIcon(domain: RudderMcpDomain): LucideIcon {
  if (domain === "goal") return Goal;
  if (domain === "issue") return CircleDot;
  if (domain === "project") return FolderKanban;
  if (domain === "approval") return ShieldCheck;
  return Zap;
}

function resolveAgent(ref: string | null, agents: TranscriptAgentDirectoryEntry[]) {
  if (!ref) return null;
  return agents.find((agent) => agent.id === ref || agent.shortRef === ref || agent.urlKey === ref) ?? {
    id: ref,
    name: ref,
    icon: null,
    role: null,
  };
}

function SemanticEntityCard({
  model,
  domain,
  agents,
  compact = false,
}: {
  model: SemanticCardModel;
  domain: RudderMcpDomain;
  agents: TranscriptAgentDirectoryEntry[];
  compact?: boolean;
}) {
  const Icon = domainIcon(domain);
  const agent = resolveAgent(model.agentRef, agents);
  const target = organizationAwareTarget(model.target);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const interactive = Boolean(target) && (hovered || focused);
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/35 text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        {model.status ? (
          <span className="max-w-[9rem] truncate rounded-sm border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
            {model.status}
          </span>
        ) : null}
      </div>
      <div className="mt-3 min-w-0">
        <div className="text-[10px] font-semibold text-muted-foreground">{model.eyebrow}</div>
        {model.title ? <div className="mt-1 line-clamp-2 text-sm font-semibold leading-5 text-foreground" title={model.title}>{model.title}</div> : null}
        {model.description ? (
          <div className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground" title={model.description}>{model.description}</div>
        ) : null}
      </div>
      <div className="mt-auto flex min-w-0 items-end justify-between gap-2 pt-3">
        {agent ? (
          <AgentIdentity
            name={agent.name}
            icon={agent.icon}
            role={agent.role as AgentRole | null | undefined}
            size="sm"
            className="min-w-0 max-w-[10rem] text-muted-foreground"
          />
        ) : <span />}
        {formatDate(model.timestamp) ? <span className="shrink-0 text-[10px] text-muted-foreground">{formatDate(model.timestamp)}</span> : null}
      </div>
    </>
  );
  const className = cn(
    "flex shrink-0 snap-start flex-col overflow-hidden border border-border/70 bg-card/95 p-3 text-left shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_28px_-16px_rgba(15,23,42,0.32)] dark:shadow-[0_2px_6px_rgba(0,0,0,0.28),0_16px_32px_-18px_rgba(0,0,0,0.72)]",
    compact ? "min-h-36 w-full rounded-md" : "h-52 w-[17.5rem] rounded-md",
    target && "cursor-pointer transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/25 hover:bg-card hover:shadow-[0_4px_8px_rgba(15,23,42,0.06),0_18px_36px_-16px_rgba(15,23,42,0.38)] dark:hover:shadow-[0_4px_10px_rgba(0,0,0,0.34),0_22px_40px_-18px_rgba(0,0,0,0.78)] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 active:translate-y-0 active:scale-[0.99]",
    interactive && "-translate-y-0.5 border-foreground/30 bg-card shadow-[0_5px_10px_rgba(15,23,42,0.08),0_20px_40px_-16px_rgba(15,23,42,0.42)] ring-2 ring-ring/35 dark:shadow-[0_5px_12px_rgba(0,0,0,0.38),0_24px_44px_-18px_rgba(0,0,0,0.82)]",
  );
  return target ? (
    <a
      href={target}
      className={className}
      style={interactive ? { transform: "translateY(-2px)" } : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      data-rudder-semantic-card-link="true"
      data-rudder-semantic-card-surface="true"
      data-rudder-semantic-card-interactive={interactive ? "true" : "false"}
    >
      {content}
    </a>
  ) : (
    <div className={className} data-rudder-semantic-card-link="false" data-rudder-semantic-card-surface="true">{content}</div>
  );
}

function EmptyState({ domain }: { domain: RudderMcpDomain }) {
  const Icon = domainIcon(domain);
  return (
    <div className="flex h-28 items-center justify-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/10 text-xs text-muted-foreground" data-rudder-semantic-empty={domain}>
      <Icon className="size-4" aria-hidden />
      No {domain === "automation" ? "automation results" : `${domain}s`} found
    </div>
  );
}

function Rail({
  stateKey,
  models,
  domain,
  agents,
}: {
  stateKey: string;
  models: SemanticCardModel[];
  domain: RudderMcpDomain;
  agents: TranscriptAgentDirectoryEntry[];
}) {
  const store = useContext(RudderMcpPresenterContext);
  const initial = store?.get(stateKey) ?? { mounted: 6, scrollLeft: 0 };
  const [mounted, setMounted] = useState(() => Math.min(models.length, Math.max(6, initial.mounted)));
  const railRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollbarActivityRef = useScrollbarActivityRef();
  const setRailRef = useCallback((element: HTMLDivElement | null) => {
    railRef.current = element;
    scrollbarActivityRef(element);
  }, [scrollbarActivityRef]);

  useEffect(() => {
    if (railRef.current) railRef.current.scrollLeft = initial.scrollLeft;
  }, [initial.scrollLeft]);

  useEffect(() => {
    if (mounted >= models.length || !sentinelRef.current || !railRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setMounted((current) => {
        const next = Math.min(models.length, current + 6);
        store?.update(stateKey, { mounted: next });
        return next;
      });
    }, { root: railRef.current, rootMargin: "0px 160px 0px 0px", threshold: 0.01 });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [models.length, mounted, stateKey, store]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    store?.update(stateKey, { scrollLeft: event.currentTarget.scrollLeft, mounted });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.currentTarget.scrollBy({ left: event.key === "ArrowRight" ? 296 : -296, behavior: "smooth" });
  };

  if (models.length === 0) return <EmptyState domain={domain} />;
  return (
    <div
      ref={setRailRef}
      className="scrollbar-auto-hide flex w-full snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-2"
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="region"
      aria-label={`${domain} results`}
      data-rudder-semantic-rail={domain}
    >
      {models.slice(0, mounted).map((model) => (
        <SemanticEntityCard key={model.key} model={model} domain={domain} agents={agents} />
      ))}
      {mounted < models.length ? <div ref={sentinelRef} className="h-52 w-px shrink-0" aria-hidden data-rudder-semantic-sentinel="true" /> : null}
    </div>
  );
}

function receiptAction(
  toolName: CoveredRudderMcpToolName,
  definition: RudderMcpPresenterDefinition,
  record: JsonRecord,
) {
  if (toolName === "rudder_goal_change_propose" || toolName === "rudder_goal_result_propose") {
    return "Proposed / awaiting review";
  }
  if (toolName === "rudder_goal_checkpoint") {
    const revision = readString(record, ["planRevisionAfter"]);
    return revision ? `Checkpoint saved at plan revision ${revision}` : "Checkpoint and continuation saved";
  }
  if (toolName === "rudder_issue_block") {
    const audit = nestedRecord(record, ["blockAudit"]);
    return readBoolean(audit, ["blocked"]) === true || readString(record, ["status"]) === "blocked"
      ? "Issue blocked"
      : "Assistance claim recorded";
  }
  if (toolName === "rudder_issue_review") return "Review decision recorded";
  if (toolName === "rudder_issue_done") {
    return readString(record, ["status"]) === "done" ? "Issue completed" : "Issue update recorded";
  }
  if (toolName === "rudder_automation_run") {
    const status = statusLabel(readString(record, ["status"]));
    return status ? `Automation run ${status}` : "Automation run accepted";
  }
  if (toolName === "rudder_automation_triggers_rotate_secret") return "Webhook secret rotated";
  return definition.action;
}

function receiptFailed(toolName: CoveredRudderMcpToolName, record: JsonRecord) {
  if (toolName !== "rudder_automation_run") return false;
  const status = readString(record, ["status"])?.toLowerCase();
  return status === "failed" || status === "cancelled" || status === "canceled";
}

function Receipt({
  model,
  domain,
  action,
  failed,
  agents,
}: {
  model: SemanticCardModel;
  domain: RudderMcpDomain;
  action: string;
  failed: boolean;
  agents: TranscriptAgentDirectoryEntry[];
}) {
  const Icon = failed ? AlertCircle : Check;
  const agent = resolveAgent(model.agentRef, agents);
  const target = organizationAwareTarget(model.target);
  const commentScrollRef = useScrollbarActivityRef();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const interactive = Boolean(target) && (hovered || focused);
  const content = (
    <>
      <span className={cn(
        "col-start-1 row-start-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md border",
        failed ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="col-start-2 row-start-1 min-w-0">
        <span className="block text-[10px] font-semibold text-muted-foreground">{domain[0]!.toUpperCase() + domain.slice(1)}</span>
        <span className="mt-0.5 block text-sm font-semibold text-foreground">{action}</span>
        {!model.commentBody && model.title && model.title !== action ? (
          <span className="mt-1 block truncate text-xs text-muted-foreground">{model.title}</span>
        ) : null}
      </span>
      {agent || model.status || formatDate(model.timestamp) ? (
        <span className="col-start-3 row-start-1 flex shrink-0 flex-col items-end gap-1">
          {agent ? (
            <span data-rudder-semantic-agent="true">
              <AgentIdentity
                name={agent.name}
                icon={agent.icon}
                role={agent.role as AgentRole | null | undefined}
                size="sm"
                className="max-w-[11rem] text-muted-foreground"
              />
            </span>
          ) : null}
          {model.status ? <span className="rounded-sm border border-border/60 px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{model.status}</span> : null}
          {formatDate(model.timestamp) ? <span className="text-[10px] text-muted-foreground">{formatDate(model.timestamp)}</span> : null}
        </span>
      ) : null}
      {model.commentBody ? (
        <span
          ref={commentScrollRef}
          className="scrollbar-auto-hide col-start-2 col-end-4 row-start-2 block max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words border-l-2 border-foreground/15 pl-2.5 pr-2 text-xs leading-5 text-foreground/80"
          data-rudder-semantic-comment-body="true"
        >
          {model.commentBody}
        </span>
      ) : null}
    </>
  );
  const className = cn(
    "grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-md border border-border/70 bg-card/95 p-3 text-left shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_28px_-16px_rgba(15,23,42,0.30)] dark:shadow-[0_2px_6px_rgba(0,0,0,0.28),0_16px_32px_-18px_rgba(0,0,0,0.70)]",
    target && "cursor-pointer transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/25 hover:bg-card hover:shadow-[0_4px_8px_rgba(15,23,42,0.06),0_18px_36px_-16px_rgba(15,23,42,0.36)] dark:hover:shadow-[0_4px_10px_rgba(0,0,0,0.34),0_22px_40px_-18px_rgba(0,0,0,0.76)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 active:translate-y-0 active:scale-[0.99]",
    interactive && "-translate-y-0.5 border-foreground/30 bg-card shadow-[0_5px_10px_rgba(15,23,42,0.08),0_20px_40px_-16px_rgba(15,23,42,0.40)] ring-2 ring-ring/35 dark:shadow-[0_5px_12px_rgba(0,0,0,0.38),0_24px_44px_-18px_rgba(0,0,0,0.80)]",
  );
  return target ? (
    <a
      href={target}
      className={className}
      style={interactive ? { transform: "translateY(-2px)" } : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      data-rudder-semantic-card-surface="true"
      data-rudder-semantic-card-interactive={interactive ? "true" : "false"}
    >
      {content}
    </a>
  ) : (
    <div className={className} data-rudder-semantic-card-surface="true">{content}</div>
  );
}

function Unavailable({ failed }: { failed: boolean }) {
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs",
      failed ? "border-red-500/25 bg-red-500/[0.06] text-red-700 dark:text-red-300" : "border-border/65 bg-muted/10 text-muted-foreground",
    )} role="status" data-rudder-semantic-unavailable="true">
      <AlertCircle className="size-4 shrink-0" aria-hidden />
      {failed ? "Action failed. Open Raw for diagnostic details." : "Result unavailable. Open Raw for diagnostic details."}
    </div>
  );
}

export function RudderMcpSemanticPresenter({ block }: { block: TranscriptToolCardEntry }) {
  const resolved = getRudderMcpPresenterDefinition(block.name, block.input);
  const store = useContext(RudderMcpPresenterContext);
  if (!resolved || block.status === "running") return null;

  const parsed = parseRudderMcpResult(block.result);
  const parsedEnvelope = asRecord(parseJson(block.result));
  const failed = block.status === "error" || block.isError === true || parsedEnvelope?.isError === true;
  const args = toolArgs(block);
  if (failed) {
    const failureRecord = valueRecord(parsed, resolved.domain) ?? {};
    const failureModel = cardModel(
      failureRecord,
      resolved,
      resolved.toolName,
      args,
      store?.triggerAutomationParents ?? new Map(),
      0,
    );
    return (
      <Receipt
        model={{
          ...failureModel,
          title: resolved.toolName.includes("comment") ? null : failureModel.title,
          commentBody: null,
        }}
        domain={resolved.domain}
        action="Action failed"
        failed
        agents={store?.agents ?? []}
      />
    );
  }
  if (parsed === undefined || parsed === null) return <Unavailable failed={false} />;

  const stateKey = block.toolUseId ?? `${resolved.toolName}:${block.ts}`;
  if (resolved.kind === "rail") {
    const domain = presenterDomain(resolved, resolved.toolName);
    const rows = collectionFrom(parsed, domain);
    if (!rows) return <Unavailable failed={false} />;
    const presentationDefinition = domain === resolved.domain ? resolved : { ...resolved, domain };
    const models = rows.map((row, index) => cardModel(
      row,
      presentationDefinition,
      resolved.toolName,
      args,
      store?.triggerAutomationParents ?? new Map(),
      index,
    ));
    return <Rail stateKey={stateKey} models={models} domain={domain} agents={store?.agents ?? []} />;
  }

  const record = valueRecord(parsed, resolved.domain);
  if (!record) return <Unavailable failed={false} />;
  const model = cardModel(
    record,
    resolved,
    resolved.toolName,
    args,
    store?.triggerAutomationParents ?? new Map(),
    0,
  );
  if (resolved.kind === "receipt") {
    return (
      <Receipt
        model={model}
        domain={resolved.domain}
        action={receiptAction(resolved.toolName, resolved, record)}
        failed={receiptFailed(resolved.toolName, record)}
        agents={store?.agents ?? []}
      />
    );
  }
  return <SemanticEntityCard model={model} domain={resolved.domain} agents={store?.agents ?? []} compact />;
}
