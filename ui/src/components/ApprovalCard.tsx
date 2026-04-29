import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "./AgentAvatar";
import { approvalLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "./ApprovalPayload";
import { ApprovalInset, ApprovalPanel } from "./approval-ui";
import { StatusBadge } from "./StatusBadge";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@rudderhq/shared";

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onRequestRevision,
  onOpen,
  detailLink,
  detailLabel = "View details",
  supportingText,
  extraActions,
  allowBudgetActions = false,
  isPending,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove: () => void;
  onReject: () => void;
  onRequestRevision?: () => void;
  onOpen?: () => void;
  detailLink?: string;
  detailLabel?: string;
  supportingText?: ReactNode;
  extraActions?: ReactNode;
  allowBudgetActions?: boolean;
  isPending: boolean;
}) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null);
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const showResolutionButtons = (allowBudgetActions || approval.type !== "budget_override_required") && isActionable;
  const showRequestRevision = Boolean(onRequestRevision) && approval.status === "pending";
  const showActions = showResolutionButtons || showRequestRevision || Boolean(extraActions) || Boolean(detailLink || onOpen);

  return (
    <ApprovalPanel className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-2.5">
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{label}</span>
              <StatusBadge status={approval.status} />
            </div>
            {requesterAgent && (
              <span className="text-xs text-muted-foreground">
                requested by <AgentIdentity name={requesterAgent.name} icon={requesterAgent.icon} size="sm" className="inline-flex" />
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
          {timeAgo(approval.createdAt)}
        </span>
      </div>

      {supportingText ? <p className="text-xs text-muted-foreground">{supportingText}</p> : null}

      <ApprovalInset className="px-3 py-3">
        <ApprovalPayloadRenderer type={approval.type} payload={approval.payload} />
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
                disabled={isPending}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={onReject}
                disabled={isPending}
              >
                Reject
              </Button>
            </>
          ) : null}
          {showRequestRevision ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onRequestRevision}
              disabled={isPending}
            >
              Request revision
            </Button>
          ) : null}
          {extraActions}
          {detailLink ? (
            <Button variant="ghost" size="sm" className="text-xs" asChild>
              <Link to={detailLink}>{detailLabel}</Link>
            </Button>
          ) : onOpen ? (
            <Button variant="ghost" size="sm" className="text-xs" onClick={onOpen}>
              {detailLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </ApprovalPanel>
  );
}
