import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import type { ApprovalComment } from "@rudderhq/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/context/OrganizationContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { resolveBoardActorLabel } from "@/lib/activity-actors";
import { Identity } from "./Identity";
import { MarkdownBody } from "./MarkdownBody";
import {
  ApprovalPayloadRenderer,
  approvalLabel,
  defaultTypeIcon,
  typeIcon,
} from "./ApprovalPayload";
import { ApprovalInset, ApprovalPanel } from "./approval-ui";
import { StatusBadge } from "./StatusBadge";

interface ApprovalDetailDialogProps {
  approvalId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ApprovalDetailDialog({
  approvalId,
  open,
  onOpenChange,
}: ApprovalDetailDialogProps) {
  const { selectedOrganizationId, setSelectedOrganizationId } = useOrganization();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [decisionNote, setDecisionNote] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId ?? "__none__"),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: Boolean(approvalId && open),
  });
  const resolvedOrgId = approval?.orgId ?? selectedOrganizationId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId ?? "__none__"),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: Boolean(approvalId && open),
  });

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId ?? "__none__"),
    queryFn: () => approvalsApi.listIssues(approvalId!),
    enabled: Boolean(approvalId && open),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedOrgId ?? ""),
    queryFn: () => agentsApi.list(resolvedOrgId ?? ""),
    enabled: Boolean(resolvedOrgId && open),
  });

  const { data: currentBoardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: open,
  });
  const currentBoardUserId = currentBoardAccess?.user?.id ?? currentBoardAccess?.userId ?? null;

  useEffect(() => {
    setDecisionNote("");
    setCommentBody("");
    setError(null);
    setShowRawPayload(false);
  }, [approvalId]);

  useEffect(() => {
    if (!approval?.orgId || approval.orgId === selectedOrganizationId) return;
    setSelectedOrganizationId(approval.orgId, { source: "route_sync" });
  }, [approval?.orgId, selectedOrganizationId, setSelectedOrganizationId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.orgId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.orgId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(approval.orgId, "pending"),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.messenger.approvals(approval.orgId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.orgId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!, decisionNote.trim() || undefined),
    onSuccess: () => {
      setDecisionNote("");
      setError(null);
      refresh();
      navigate(`/messenger/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!, decisionNote.trim() || undefined),
    onSuccess: () => {
      setDecisionNote("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!, decisionNote.trim() || undefined),
    onSuccess: () => {
      setDecisionNote("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Comment failed"),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Delete failed"),
  });

  const payload = (approval?.payload ?? {}) as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval?.status === "pending" || approval?.status === "revision_requested";
  const isBudgetApproval = approval?.type === "budget_override_required";
  const TypeIcon = approval ? (typeIcon[approval.type] ?? defaultTypeIcon) : defaultTypeIcon;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval?.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label: (linkedIssues?.length ?? 0) > 1 ? "Review linked issues" : "Review linked issue",
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: "Open hired agent",
            to: `/agents/${linkedAgentId}`,
          }
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!flex max-h-[calc(100vh-2rem)] !flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        data-testid="approval-detail-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>
            {approval ? approvalLabel(approval.type, approval.payload as Record<string, unknown> | null) : "Approval"}
          </DialogTitle>
          <DialogDescription>Full approval details stay inside Messenger.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col bg-[color:color-mix(in_oklab,var(--surface-inset)_68%,white)]">
          <div className="border-b border-border/70 px-6 py-4">
            <div className="space-y-1">
              <h2 className="text-[20px] font-semibold tracking-tight text-foreground">Approval</h2>
              <p className="text-sm text-muted-foreground">
                Review the full request without leaving the thread.
              </p>
            </div>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
            data-testid="approval-detail-scroll-area"
          >
            {isLoading ? (
              <div className="py-10 text-sm text-muted-foreground">Loading approval…</div>
            ) : !approval ? (
              <div className="py-10 text-sm text-muted-foreground">Approval not found.</div>
            ) : (
              <div className="space-y-4">
                {showApprovedBanner ? (
                  <div className="rounded-[var(--radius-md)] border border-green-300 bg-green-50 px-4 py-3 dark:border-green-700/40 dark:bg-green-900/20">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2">
                        <div className="relative mt-0.5">
                          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                          <Sparkles className="absolute -right-2 -top-1 h-3 w-3 animate-pulse text-green-500 dark:text-green-200" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-green-800 dark:text-green-100">Approval confirmed</p>
                          <p className="text-xs text-green-700 dark:text-green-200/90">
                            Requesting agent was notified to review this approval and linked issues.
                          </p>
                        </div>
                      </div>
                      {resolvedCta ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-[calc(var(--radius-sm)-1px)] border-green-400 text-green-800 hover:bg-green-100 dark:border-green-600/50 dark:text-green-100 dark:hover:bg-green-900/30"
                          asChild
                        >
                          <Link to={resolvedCta.to}>{resolvedCta.label}</Link>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <ApprovalPanel className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <TypeIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 space-y-1">
                        <h3 className="text-[18px] font-semibold tracking-tight">
                          {approvalLabel(approval.type, approval.payload as Record<string, unknown> | null)}
                        </h3>
                        <ApprovalInset className="inline-flex max-w-full items-center px-2 py-1 text-[11px] font-mono text-muted-foreground">
                          <span className="truncate">{approval.id}</span>
                        </ApprovalInset>
                      </div>
                    </div>
                    <StatusBadge status={approval.status} />
                  </div>

                  <div className="space-y-3 text-sm">
                    {approval.requestedByAgentId ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Requested by</span>
                        <Identity
                          name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)}
                          size="sm"
                        />
                      </div>
                    ) : null}

                    <ApprovalInset className="px-3 py-3">
                      <ApprovalPayloadRenderer type={approval.type} payload={payload} />
                    </ApprovalInset>

                    {approval.decisionNote ? (
                      <ApprovalInset className="px-3 py-3">
                        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                          Decision note
                        </div>
                        <p className="mt-2 text-sm leading-6 text-foreground/90">{approval.decisionNote}</p>
                      </ApprovalInset>
                    ) : null}

                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setShowRawPayload((value) => !value)}
                    >
                      <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
                      See full request
                    </button>
                    {showRawPayload ? (
                      <ApprovalInset as="pre" className="overflow-x-auto p-3 text-xs">
                        {JSON.stringify(payload, null, 2)}
                      </ApprovalInset>
                    ) : null}
                  </div>

                  {error ? <p className="text-sm text-destructive">{error}</p> : null}

                  {approval.status === "pending" ? (
                    <label className="block space-y-2">
                      <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                        Decision note
                      </span>
                      <Textarea
                        value={decisionNote}
                        onChange={(event) => setDecisionNote(event.target.value)}
                        placeholder="Optional note for approval, rejection, or requested changes."
                        rows={3}
                        className="min-h-[112px] rounded-[calc(var(--radius-sm)-1px)] border-border/80 bg-background/70"
                        data-testid="approval-decision-note"
                      />
                    </label>
                  ) : null}

                  {linkedIssues && linkedIssues.length > 0 ? (
                    <div className="space-y-2 border-t border-border/60 pt-3">
                      <p className="text-xs text-muted-foreground">Linked issues</p>
                      <div className="space-y-1.5">
                        {linkedIssues.map((issue) => (
                          <Link
                            key={issue.id}
                            to={`/issues/${issue.identifier ?? issue.id}`}
                            className="block rounded-[calc(var(--radius-sm)-1px)] border border-border/70 px-2.5 py-2 text-xs hover:bg-accent/20"
                          >
                            <span className="mr-2 font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            <span>{issue.title}</span>
                          </Link>
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        Linked issues remain open until the requesting agent follows up and closes them.
                      </p>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                    {isActionable && !isBudgetApproval ? (
                      <>
                        <Button
                          size="sm"
                          className="bg-green-700 text-white hover:bg-green-600"
                          onClick={() => approveMutation.mutate()}
                          disabled={approveMutation.isPending}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => rejectMutation.mutate()}
                          disabled={rejectMutation.isPending}
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}

                    {isBudgetApproval && approval.status === "pending" ? (
                      <p className="text-sm text-muted-foreground">
                        Resolve this budget stop from the budget controls on{" "}
                        <Link to="/costs" className="underline underline-offset-2">/costs</Link>.
                      </p>
                    ) : null}

                    {approval.status === "pending" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => revisionMutation.mutate()}
                        disabled={revisionMutation.isPending}
                      >
                        Request revision
                      </Button>
                    ) : null}

                    {approval.status === "revision_requested" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => resubmitMutation.mutate()}
                        disabled={resubmitMutation.isPending}
                      >
                        Mark resubmitted
                      </Button>
                    ) : null}

                    {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-destructive/40 text-destructive"
                        onClick={() => {
                          if (!window.confirm("Delete this disapproved agent? This cannot be undone.")) return;
                          deleteAgentMutation.mutate(linkedAgentId);
                        }}
                        disabled={deleteAgentMutation.isPending}
                      >
                        Delete disapproved agent
                      </Button>
                    ) : null}
                  </div>
                </ApprovalPanel>

                <ApprovalPanel className="space-y-3">
                  <h3 className="text-sm font-medium">Comments ({comments?.length ?? 0})</h3>
                  <div className="space-y-2">
                    {(comments ?? []).map((comment: ApprovalComment) => (
                      <ApprovalInset key={comment.id} className="p-3">
                        <div className="mb-1 flex items-center justify-between">
                          {comment.authorAgentId ? (
                            <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                              <Identity
                                name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                                size="sm"
                              />
                            </Link>
                          ) : (
                            <Identity
                              name={resolveBoardActorLabel("user", comment.authorUserId, currentBoardUserId)}
                              size="sm"
                            />
                          )}
                          <span className="text-xs text-muted-foreground">
                            {new Date(comment.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
                      </ApprovalInset>
                    ))}
                  </div>
                  <Textarea
                    value={commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    placeholder="Add a comment..."
                    rows={3}
                    className="min-h-[132px] rounded-[calc(var(--radius-sm)-1px)] border-border/80 bg-background/70"
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={() => addCommentMutation.mutate()}
                      disabled={!commentBody.trim() || addCommentMutation.isPending}
                    >
                      {addCommentMutation.isPending ? "Posting…" : "Comment"}
                    </Button>
                  </div>
                </ApprovalPanel>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
