import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import type { GoalWorkspaceFacet } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock3, Plus, Target, UserRound } from "lucide-react";
import { useEffect, useMemo } from "react";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDate } from "../lib/utils";

type BoardFacet = GoalWorkspaceFacet;

type GoalCardView = {
  id: string;
  title: string;
  facet: BoardFacet;
  focus: boolean;
  ownerAgentId: string | null;
  ownerName: string | null;
  progress: string;
  nextStep: string;
  attentionReason: string | null;
  targetTime: Date | string | null;
};

const facets: Array<{
  id: Exclude<BoardFacet, "closed">;
  label: string;
  empty: string;
}> = [
  { id: "agent_advancing", label: "Agent advancing", empty: "No Agent-owned next action." },
  { id: "needs_attention", label: "Needs your attention", empty: "Nothing needs your input." },
  { id: "waiting_external", label: "Waiting for external result", empty: "No Goals are waiting externally." },
  { id: "ready_for_acceptance", label: "Ready for acceptance", empty: "No results are ready for review." },
];

const historyFacet = { id: "closed" as const, label: "History", empty: "No accepted Goals yet." };

const mobileFacetOrder: Record<BoardFacet, number> = {
  ready_for_acceptance: 0,
  needs_attention: 1,
  waiting_external: 2,
  agent_advancing: 3,
  closed: 4,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readNestedString(record: Record<string, unknown>, key: string, nestedKey = "summary") {
  return readString(asRecord(record[key]), nestedKey);
}

function normalizeFacet(value: unknown): BoardFacet | null {
  if (value === "closed") return "closed";
  if (value === "ready_for_acceptance") return value;
  if (value === "needs_attention" || value === "needs_your_attention") return "needs_attention";
  if (value === "waiting_external" || value === "waiting_for_external_result") return "waiting_external";
  return "agent_advancing";
}

function normalizeCards(payload: unknown): GoalCardView[] {
  const payloadRecord = asRecord(payload);
  const rawCards = Array.isArray(payload)
    ? payload
    : Array.isArray(payloadRecord.cards)
      ? payloadRecord.cards
      : [];

  return rawCards.flatMap((value) => {
    const record = asRecord(value);
    const goal = asRecord(record.goal);
    const id = readString(record, "id") ?? readString(goal, "id");
    const title = readString(record, "title") ?? readString(goal, "title");
    if (!id || !title) return [];
    const attention = asRecord(record.attention);
    const owner = asRecord(record.owner);
    const targetTime = record.targetTime ?? goal.actionDeadline ?? null;
    const facet = normalizeFacet(record.facet ?? (goal.lifecycle === "closed" ? "closed" : undefined));
    if (!facet) return [];
    return [{
      id,
      title,
      facet,
      focus: record.focus === true || goal.focus === true,
      ownerAgentId: readString(record, "ownerAgentId") ?? readString(goal, "ownerAgentId"),
      ownerName: readString(record, "ownerName") ?? readString(owner, "name"),
      progress: readString(record, "progressSummary")
        ?? readNestedString(record, "currentProgress")
        ?? "No evidence-backed progress has been recorded yet.",
      nextStep: readString(record, "nextStepSummary")
        ?? readNestedString(record, "nextStep")
        ?? "No next step is available yet.",
      attentionReason: readString(record, "attentionReason") ?? readString(attention, "reason"),
      targetTime: typeof targetTime === "string" || targetTime instanceof Date ? targetTime : null,
    }];
  });
}

function FacetLabel({ facet }: { facet: BoardFacet }) {
  const definition = facet === "closed" ? historyFacet : facets.find((candidate) => candidate.id === facet) ?? facets[0];
  return (
    <span className={cn(
      "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
      facet === "ready_for_acceptance" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      facet === "needs_attention" && "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
      facet === "waiting_external" && "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      facet === "agent_advancing" && "border-border bg-muted/35 text-muted-foreground",
    )}>
      {definition.label}
    </span>
  );
}

function GoalCard({ card, ownerName, mobile = false }: { card: GoalCardView; ownerName: string; mobile?: boolean }) {
  return (
    <Link
      to={`/goals/${card.id}`}
      className="block min-w-0 rounded-md border border-border bg-background px-3 py-3 transition-colors hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h3 className="min-w-0 whitespace-normal break-words text-sm font-semibold leading-5">{card.title}</h3>
        {card.focus ? <span className="shrink-0 text-[11px] font-medium text-[color:var(--accent-base)]">Focus</span> : null}
      </div>
      {mobile ? <div className="mt-2"><FacetLabel facet={card.facet} /></div> : null}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5 text-foreground/85">{card.progress}</p>
      {card.attentionReason ? (
        <p className="mt-2 whitespace-pre-wrap break-words border-l-2 border-amber-500/45 pl-2 text-xs leading-5 text-foreground">
          {card.attentionReason}
        </p>
      ) : null}
      <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-start gap-1.5">
          <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{ownerName}</span>
        </div>
        <div className="flex min-w-0 items-start gap-1.5">
          <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{card.nextStep}</span>
        </div>
        {card.targetTime ? (
          <div className="flex min-w-0 items-start gap-1.5">
            <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">Target {formatDate(card.targetTime)}</span>
          </div>
        ) : null}
      </div>
    </Link>
  );
}

export function Goals() {
  const { selectedOrganizationId } = useOrganization();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Goals" }]), [setBreadcrumbs]);

  const workspaceQuery = useQuery({
    queryKey: ["goals", "workspace", selectedOrganizationId],
    queryFn: () => goalsApi.listWorkspace(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });

  const cards = useMemo(() => normalizeCards(workspaceQuery.data), [workspaceQuery.data]);
  const ownerNames = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name])),
    [agentsQuery.data],
  );
  const sortedMobileCards = useMemo(
    () => cards.filter((card) => card.facet !== "closed")
      .sort((left, right) => mobileFacetOrder[left.facet] - mobileFacetOrder[right.facet]),
    [cards],
  );
  const historyCards = useMemo(() => cards.filter((card) => card.facet === "closed"), [cards]);

  if (!selectedOrganizationId) return <EmptyState icon={Target} message="Select an organization to view Goals." />;
  if (workspaceQuery.isLoading) return <PageSkeleton variant="list" />;

  const ownerNameFor = (card: GoalCardView) => card.ownerName
    ?? (card.ownerAgentId ? ownerNames.get(card.ownerAgentId) ?? `Agent ${card.ownerAgentId.slice(0, 8)}` : "Unassigned");

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden pb-6">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Goals</h1>
          <p className="text-sm text-muted-foreground">Work grouped by who or what acts next.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openNewGoal()} className="shrink-0">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Goal
        </Button>
      </div>

      {workspaceQuery.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{workspaceQuery.error.message}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void workspaceQuery.refetch()} disabled={workspaceQuery.isFetching}>Retry</Button>
        </div>
      ) : null}

      {cards.length === 0 && !workspaceQuery.error ? (
        <EmptyState icon={Target} message="No Goals yet." action="New Goal" onAction={() => openNewGoal()} />
      ) : (
        <>
          <div data-testid="goal-derived-board" className="hidden min-w-0 grid-cols-2 gap-3 md:grid lg:grid-cols-4">
            {facets.map((facet) => {
              const facetCards = cards.filter((card) => card.facet === facet.id);
              return (
                <section key={facet.id} aria-labelledby={`goal-facet-${facet.id}`} className="min-w-0 border-t border-border pt-2">
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <h2 id={`goal-facet-${facet.id}`} className="min-w-0 text-sm font-semibold">{facet.label}</h2>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{facetCards.length}</span>
                  </div>
                  <div className="space-y-2">
                    {facetCards.length > 0
                      ? facetCards.map((card) => <GoalCard key={card.id} card={card} ownerName={ownerNameFor(card)} />)
                      : <p className="px-1 py-2 text-xs leading-5 text-muted-foreground">{facet.empty}</p>}
                  </div>
                </section>
              );
            })}
          </div>

          <div data-testid="goal-mobile-attention-list" className="min-w-0 space-y-2 md:hidden">
            {sortedMobileCards.map((card) => (
              <GoalCard key={card.id} card={card} ownerName={ownerNameFor(card)} mobile />
            ))}
          </div>
          {historyCards.length > 0 ? (
            <section aria-labelledby="goal-history" className="min-w-0 border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <h2 id="goal-history" className="text-sm font-semibold">History</h2>
                <span className="text-xs tabular-nums text-muted-foreground">{historyCards.length}</span>
              </div>
              <div className="grid min-w-0 gap-2 md:grid-cols-2">
                {historyCards.map((card) => <GoalCard key={card.id} card={card} ownerName={ownerNameFor(card)} />)}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
