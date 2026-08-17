import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import type { Agent, Approval, MessengerApprovalOrigin } from "@rudderhq/shared";
import { CircleCheckBig, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { timeAgo } from "../lib/timeAgo";
import { AgentIdentity } from "./AgentAvatar";
import { ApprovalInset, ApprovalPanel } from "./approval-ui";
import {
  approvalLabel,
  ApprovalPayloadRenderer,
  defaultTypeIcon,
  typeIcon,
  type ApprovalPayloadContext,
} from "./ApprovalPayload";
import { ApprovalRejectDialog } from "./ApprovalRejectDialog";
import { StatusBadge } from "./StatusBadge";

export function ApprovalCard({
  approval,
  requesterAgent,
  origin,
  onApprove,
  onReject,
  supportingText,
  payloadContext,
  extraActions,
  allowBudgetActions = false,
  isPending,
  approveDisabled = false,
}: {
  approval: Approval;
  requesterAgent: Pick<Agent, "name" | "icon" | "role"> | null;
  origin?: MessengerApprovalOrigin | null;
  onApprove: () => void;
  onReject: (reason?: string) => void | Promise<unknown>;
  supportingText?: ReactNode;
  payloadContext?: ApprovalPayloadContext;
  extraActions?: ReactNode;
  allowBudgetActions?: boolean;
  isPending: boolean;
  approveDisabled?: boolean;
}) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null);
  const isActionable = approval.status === "pending";
  const showResolutionButtons = (allowBudgetActions || approval.type !== "budget_override_required") && isActionable;
  const showActions = showResolutionButtons || Boolean(extraActions);
  const OriginIcon = origin?.kind === "chat" ? MessageSquare : CircleCheckBig;
  const originLabel = origin?.kind === "issue" && origin.identifier
    ? `${origin.identifier} · ${origin.title}`
    : origin?.title;

  return (
    <ApprovalPanel className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex min-h-5 min-w-0 items-center gap-2.5" data-testid="approval-title-row">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" data-testid="approval-type-icon" />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{label}</span>
              <StatusBadge status={approval.status} />
            </div>
          </div>
          {requesterAgent ? (
            <span className="block pl-[26px] text-xs text-muted-foreground">
              requested by <AgentIdentity name={requesterAgent.name} icon={requesterAgent.icon} role={requesterAgent.role} size="sm" className="inline-flex" />
            </span>
          ) : null}
          {origin ? (
            <div className="flex min-w-0 items-center gap-1.5 pl-[26px] text-xs text-muted-foreground">
              <span className="shrink-0">From</span>
              <Link
                to={origin.href}
                className="flex min-w-0 items-center gap-1.5 font-medium text-foreground/80 underline-offset-4 hover:underline"
                aria-label={`Open source ${origin.kind} ${originLabel}`}
                data-testid="approval-origin-link"
              >
                <OriginIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{originLabel}</span>
              </Link>
            </div>
          ) : null}
        </div>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
          {timeAgo(approval.createdAt)}
        </span>
      </div>

      {supportingText ? <p className="text-xs text-muted-foreground">{supportingText}</p> : null}

      <ApprovalInset className="px-3 py-3">
        <ApprovalPayloadRenderer type={approval.type} payload={approval.payload} context={payloadContext} />
      </ApprovalInset>

      {approval.decisionNote && (
        <ApprovalInset className="px-3 py-2.5 text-xs italic text-muted-foreground">
          Note: {approval.decisionNote}
        </ApprovalInset>
      )}

      {showActions ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          {showResolutionButtons ? (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={onApprove}
                disabled={isPending || approveDisabled}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setRejectOpen(true)}
                disabled={isPending}
              >
                Reject
              </Button>
            </>
          ) : null}
          {extraActions}
        </div>
      ) : null}
      <ApprovalRejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onReject={onReject}
        isPending={isPending}
      />
    </ApprovalPanel>
  );
}
