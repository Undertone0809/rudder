import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Link } from "@/lib/router";
import type { Agent, ChatConversation, IssueLabel, Project } from "@rudderhq/shared";
import { Check, ChevronDown, Lightbulb, MessageSquare, Settings2, ShieldAlert, ShieldCheck, Tag, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { formatPriorityLabel } from "../lib/priorities";
import { cn, formatCents } from "../lib/utils";
import { AgentIdentity } from "./AgentAvatar";
import {
  ApprovalCodeBlock,
  ApprovalField,
  ApprovalInlineCode,
  ApprovalTag,
} from "./approval-ui";
import { MarkdownBody } from "./MarkdownBody";

export interface ApprovalPayloadContext {
  agents?: Agent[] | null;
  projects?: Project[] | null;
  labels?: IssueLabel[] | null;
  selectedLabelIds?: string[] | null;
  onSelectedLabelIdsChange?: (labelIds: string[]) => void;
  labelPickerDisabled?: boolean;
  chatConversation?: Pick<ChatConversation, "id" | "title"> | null;
  currentUserId?: string | null;
}

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  chat_issue_creation: "Issue proposed from chat",
  chat_operation: "Chat Operation Proposal",
};

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  if (type === "hire_agent" && payload?.name) {
    return `${base}: ${String(payload.name)}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  chat_issue_creation: MessageSquare,
  chat_operation: Settings2,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <ApprovalField label={label}>
      <span>{String(value)}</span>
    </ApprovalField>
  );
}

function lookupProject(projectId: unknown, projects: Project[] | null | undefined) {
  if (typeof projectId !== "string" || !projectId.trim()) return null;
  return projects?.find((project) => project.id === projectId) ?? null;
}

function lookupAgent(agentId: unknown, agents: Agent[] | null | undefined) {
  if (typeof agentId !== "string" || !agentId.trim()) return null;
  return agents?.find((agent) => agent.id === agentId) ?? null;
}

function labelIdsFromProposal(proposal: Record<string, unknown>) {
  return Array.isArray(proposal.labelIds)
    ? proposal.labelIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

function proposedIssueFromApprovalPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return null;
  return payload.proposedIssue && typeof payload.proposedIssue === "object" && !Array.isArray(payload.proposedIssue)
    ? (payload.proposedIssue as Record<string, unknown>)
    : payload;
}

export function chatIssueApprovalLabelIds(payload: Record<string, unknown> | null | undefined) {
  const proposal = proposedIssueFromApprovalPayload(payload);
  return proposal ? labelIdsFromProposal(proposal) : [];
}

export function chatIssueApprovalNeedsLabelSelection(
  payload: Record<string, unknown> | null | undefined,
  labels: IssueLabel[] | null | undefined,
  selectedLabelIds = chatIssueApprovalLabelIds(payload),
) {
  const proposedByAgentId = typeof payload?.proposedByAgentId === "string" ? payload.proposedByAgentId.trim() : "";
  return proposedByAgentId.length > 0 && (labels?.length ?? 0) >= 5 && selectedLabelIds.length === 0;
}

export function approvalPayloadWithChatIssueLabelIds(
  payload: Record<string, unknown>,
  labelIds: string[],
) {
  const uniqueLabelIds = [...new Set(labelIds.filter((id) => id.trim().length > 0))];
  const proposedIssue =
    payload.proposedIssue && typeof payload.proposedIssue === "object" && !Array.isArray(payload.proposedIssue)
      ? { ...(payload.proposedIssue as Record<string, unknown>), labelIds: uniqueLabelIds }
      : { ...payload, labelIds: uniqueLabelIds };
  return { ...payload, proposedIssue };
}

export function ChatIssueApprovalLabelPicker({
  labels,
  selectedLabelIds,
  onChange,
  required,
  disabled,
}: {
  labels?: IssueLabel[] | null;
  selectedLabelIds: string[];
  onChange: (labelIds: string[]) => void;
  required: boolean;
  disabled?: boolean;
}) {
  const labelListScrollRef = useScrollbarActivityRef();
  if (!labels || labels.length === 0) return null;
  const selected = new Set(selectedLabelIds);
  return (
    <div className="space-y-2 rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-background/70 p-3" data-testid="chat-issue-approval-label-picker">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          <Tag className="h-3.5 w-3.5 shrink-0" />
          <span>Labels</span>
        </div>
        {required ? (
          <span className="shrink-0 text-xs font-medium text-destructive">Required before approval</span>
        ) : null}
      </div>
      <div ref={labelListScrollRef} className="scrollbar-auto-hide max-h-36 space-y-1 overflow-y-auto overscroll-contain pr-1">
        {labels.map((label) => {
          const isSelected = selected.has(label.id);
          return (
            <button
              key={label.id}
              type="button"
              aria-pressed={isSelected}
              disabled={disabled}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60",
                isSelected && "bg-accent text-accent-foreground",
              )}
              onClick={() => {
                onChange(
                  isSelected
                    ? selectedLabelIds.filter((id) => id !== label.id)
                    : [...selectedLabelIds, label.id],
                );
              }}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
              {isSelected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChatIssueApprovalLabelPopover({
  labels,
  selectedLabelIds,
  onChange,
  required,
  disabled,
  children,
}: {
  labels: IssueLabel[];
  selectedLabelIds: string[];
  onChange: (labelIds: string[]) => void;
  required: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const labelListScrollRef = useScrollbarActivityRef();
  const selected = new Set(selectedLabelIds);
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1" collisionPadding={16}>
        <div className="px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-foreground">Issue labels</div>
            {required ? (
              <div className="text-[11px] font-medium text-destructive">Required</div>
            ) : null}
          </div>
        </div>
        <div ref={labelListScrollRef} className="scrollbar-auto-hide max-h-56 space-y-0.5 overflow-y-auto overscroll-contain p-1 pt-0">
          {labels.map((label) => {
            const isSelected = selected.has(label.id);
            return (
              <button
                key={label.id}
                type="button"
                aria-pressed={isSelected}
                disabled={disabled}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-60",
                  isSelected && "bg-accent text-accent-foreground",
                )}
                onClick={() => {
                  onChange(
                    isSelected
                      ? selectedLabelIds.filter((id) => id !== label.id)
                      : [...selectedLabelIds, label.id],
                  );
                }}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
                {isSelected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabelsField({
  labelIds,
  labels,
  required,
  onChange,
  disabled,
}: {
  labelIds: string[];
  labels?: IssueLabel[] | null;
  required: boolean;
  onChange?: (labelIds: string[]) => void;
  disabled?: boolean;
}) {
  if (labelIds.length === 0 && !required) return null;
  const labelById = new Map((labels ?? []).map((label) => [label.id, label]));
  const selectedLabels = labelIds.map((id) => labelById.get(id)).filter((label): label is IssueLabel => Boolean(label));
  const unresolvedIds = labelIds.filter((id) => !labelById.has(id));
  const editable = Boolean(onChange && labels && labels.length > 0);
  const renderLabelItems = (variant: "plain" | "chip") => (
    <>
      {selectedLabels.map((label) => (
        <span
          key={label.id}
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs font-medium",
            variant === "chip" && "rounded-md border border-border/70 bg-background/70 px-2 py-1",
          )}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {unresolvedIds.map((id) => (
        <ApprovalInlineCode key={id}>{id}</ApprovalInlineCode>
      ))}
    </>
  );
  const renderedLabels =
    selectedLabels.length > 0 || unresolvedIds.length > 0 ? (
      <span className="flex flex-wrap gap-1.5">
        {renderLabelItems(editable ? "plain" : "chip")}
      </span>
    ) : (
      <span className="text-xs font-medium text-destructive">
        Required before approval
      </span>
    );

  return (
    <ApprovalField label="Labels" align="start">
      {editable ? (
        <ChatIssueApprovalLabelPopover
          labels={labels!}
          selectedLabelIds={labelIds}
          onChange={onChange!}
          required={required}
          disabled={disabled}
        >
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background/70 px-1.5 py-1 text-left transition-colors hover:border-border hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60",
              required && labelIds.length === 0 && "border-destructive/40 bg-destructive/5 hover:bg-destructive/10",
            )}
            data-testid="chat-issue-label-popover-trigger"
          >
            {selectedLabels.length > 0 || unresolvedIds.length > 0 ? renderedLabels : (
              <span className="px-1 text-xs font-medium text-destructive">
                {required ? "Required before approval" : "Select label"}
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </ChatIssueApprovalLabelPopover>
      ) : renderedLabels}
    </ApprovalField>
  );
}

export function chatConversationIdFromApprovalPayload(payload: Record<string, unknown> | null | undefined) {
  const chatConversationId = payload?.chatConversationId;
  return typeof chatConversationId === "string" && chatConversationId.trim() ? chatConversationId : null;
}

function ChatField({ chatConversationId, chatConversation }: {
  chatConversationId: unknown;
  chatConversation?: Pick<ChatConversation, "id" | "title"> | null;
}) {
  if (typeof chatConversationId !== "string" || !chatConversationId.trim()) return null;
  const resolvedConversation = chatConversation?.id === chatConversationId ? chatConversation : null;
  return (
    <ApprovalField label="Source chat" align="start">
      {resolvedConversation ? (
        <div className="space-y-0.5">
          <Link className="font-medium text-foreground underline-offset-4 hover:underline" to={`/messenger/chat/${resolvedConversation.id}`}>
            {resolvedConversation.title.trim() || "Untitled chat"}
          </Link>
        </div>
      ) : (
        <span className="font-medium">Chat conversation</span>
      )}
    </ApprovalField>
  );
}

function ProjectField({ projectId, projects }: { projectId: unknown; projects?: Project[] | null }) {
  if (typeof projectId !== "string" || !projectId.trim()) return null;
  const project = lookupProject(projectId, projects);
  return (
    <ApprovalField label="Project">
      <span className="font-medium">{project?.name?.trim() || "Unknown project"}</span>
    </ApprovalField>
  );
}

function AssigneeField({
  fieldLabel = "Assignee",
  agentId,
  userId,
  agents,
  currentUserId,
}: {
  fieldLabel?: string;
  agentId: unknown;
  userId: unknown;
  agents?: Agent[] | null;
  currentUserId?: string | null;
}) {
  if (typeof agentId === "string" && agentId.trim()) {
    const agent = lookupAgent(agentId, agents);
    return (
      <ApprovalField label={fieldLabel}>
        {agent ? (
          <AgentIdentity name={agent.name} icon={agent.icon} role={agent.role} size="sm" />
        ) : (
          <span className="font-medium">Unknown agent</span>
        )}
      </ApprovalField>
    );
  }

  if (typeof userId === "string" && userId.trim()) {
    const fallbackLabel = fieldLabel === "Reviewer" ? "Human reviewer" : "Human assignee";
    const userLabel = formatAssigneeUserLabel(userId, currentUserId) ?? fallbackLabel;
    const readableLabel = userLabel === userId.slice(0, 5) ? fallbackLabel : userLabel;
    return (
      <ApprovalField label={fieldLabel}>
        <span className="font-medium">{readableLabel}</span>
      </ApprovalField>
    );
  }

  return null;
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <ApprovalField label="Skills" align="start">
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <ApprovalTag key={item}>{item}</ApprovalTag>
        ))}
      </div>
    </ApprovalField>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="space-y-2 text-sm">
      <ApprovalField label="Name">
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </ApprovalField>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <ApprovalField label="Capabilities" align="start">
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </ApprovalField>
      )}
      {!!payload.agentRuntimeType && (
        <ApprovalField label="Runtime">
          <ApprovalInlineCode>
            {String(payload.agentRuntimeType)}
          </ApprovalInlineCode>
        </ApprovalField>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="space-y-2 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <ApprovalCodeBlock className="max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
          {String(plan)}
        </ApprovalCodeBlock>
      )}
      {!plan && (
        <pre className="max-h-48 overflow-x-auto rounded-[calc(var(--radius-sm)-1px)] border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="space-y-2 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <ApprovalCodeBlock>
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </ApprovalCodeBlock>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

function ChatIssueCreationPayload({
  payload,
  context,
}: {
  payload: Record<string, unknown>;
  context?: ApprovalPayloadContext;
}) {
  const proposal = proposedIssueFromApprovalPayload(payload) ?? payload;
  const description =
    typeof proposal.description === "string" && proposal.description.trim().length > 0
      ? proposal.description.trim()
      : null;
  const labelIds = context?.selectedLabelIds ?? labelIdsFromProposal(proposal);
  const labelsRequired = chatIssueApprovalNeedsLabelSelection(payload, context?.labels, labelIds);

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-[calc(var(--radius-sm)-1px)] border border-primary/15 bg-primary/5 px-3 py-2">
        <div className="text-sm font-medium text-foreground">Agent proposed a new issue from chat</div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Review the draft before Rudder creates it on the issue board.</p>
      </div>
      <ChatField chatConversationId={payload.chatConversationId} chatConversation={context?.chatConversation} />
      <PayloadField label="Issue" value={proposal.title} />
      <PayloadField label="Priority" value={typeof proposal.priority === "string" ? formatPriorityLabel(proposal.priority) : proposal.priority} />
      <ProjectField projectId={proposal.projectId} projects={context?.projects} />
      <PayloadField label="Goal" value={proposal.goalId} />
      <LabelsField
        labelIds={labelIds}
        labels={context?.labels}
        required={labelsRequired}
        onChange={context?.onSelectedLabelIdsChange}
        disabled={context?.labelPickerDisabled}
      />
      <AssigneeField
        agentId={proposal.assigneeAgentId}
        userId={proposal.assigneeUserId}
        agents={context?.agents}
        currentUserId={context?.currentUserId}
      />
      <AssigneeField
        fieldLabel="Reviewer"
        agentId={proposal.reviewerAgentId}
        userId={proposal.reviewerUserId}
        agents={context?.agents}
        currentUserId={context?.currentUserId}
      />
      {description ? (
        <ApprovalField label="Description" align="start">
          <ApprovalCodeBlock className="max-h-64 overflow-y-auto text-sm text-foreground/90">
            <MarkdownBody className="text-sm leading-6 text-foreground/90" enableImagePreview={false}>
              {description}
            </MarkdownBody>
          </ApprovalCodeBlock>
        </ApprovalField>
      ) : null}
    </div>
  );
}

function ChatOperationPayload({ payload }: { payload: Record<string, unknown> }) {
  const proposal =
    payload.operationProposal && typeof payload.operationProposal === "object" && !Array.isArray(payload.operationProposal)
      ? (payload.operationProposal as Record<string, unknown>)
      : payload;
  const patch =
    proposal.patch && typeof proposal.patch === "object" && !Array.isArray(proposal.patch)
      ? proposal.patch
      : null;

  return (
    <div className="space-y-2 text-sm">
      <PayloadField label="Chat" value={payload.chatConversationId} />
      <PayloadField label="Target" value={proposal.targetType && proposal.targetId ? `${String(proposal.targetType)}:${String(proposal.targetId)}` : null} />
      <PayloadField label="Summary" value={proposal.summary} />
      {patch ? (
        <pre className="max-h-48 overflow-x-auto rounded-[calc(var(--radius-sm)-1px)] border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
          {JSON.stringify(patch, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  context,
}: {
  type: string;
  payload: Record<string, unknown>;
  context?: ApprovalPayloadContext;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "chat_issue_creation") return <ChatIssueCreationPayload payload={payload} context={context} />;
  if (type === "chat_operation") return <ChatOperationPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
