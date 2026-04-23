import { UserPlus, Lightbulb, MessageSquare, Settings2, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatCents } from "../lib/utils";
import {
  ApprovalCodeBlock,
  ApprovalField,
  ApprovalInlineCode,
  ApprovalTag,
} from "./approval-ui";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  chat_issue_creation: "Chat Issue Proposal",
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

function ChatIssueCreationPayload({ payload }: { payload: Record<string, unknown> }) {
  const proposal =
    payload.proposedIssue && typeof payload.proposedIssue === "object" && !Array.isArray(payload.proposedIssue)
      ? (payload.proposedIssue as Record<string, unknown>)
      : payload;
  const description =
    typeof proposal.description === "string" && proposal.description.trim().length > 0
      ? proposal.description.trim()
      : null;

  return (
    <div className="space-y-2 text-sm">
      <PayloadField label="Chat" value={payload.chatConversationId} />
      <PayloadField label="Title" value={proposal.title} />
      <PayloadField label="Priority" value={proposal.priority} />
      <PayloadField label="Project" value={proposal.projectId} />
      <PayloadField label="Goal" value={proposal.goalId} />
      <PayloadField label="Assignee" value={proposal.assigneeAgentId ?? proposal.assigneeUserId} />
      {description ? (
        <ApprovalCodeBlock className="max-h-48 overflow-y-auto whitespace-pre-wrap">
          {description}
        </ApprovalCodeBlock>
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

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "chat_issue_creation") return <ChatIssueCreationPayload payload={payload} />;
  if (type === "chat_operation") return <ChatOperationPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
