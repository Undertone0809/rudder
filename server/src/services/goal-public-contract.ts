const INTERNAL_GOAL_LANGUAGE = [
  [/\bgoal\s+contract\b/gi, "Goal"],
  [/\bcontract\s+revision\b/gi, "Goal update"],
  [/\bcontracts?\b/gi, "agreement"],
  [/\bobjective\s+mode\b/gi, "Goal type"],
  [/\bevaluator\b/gi, "success check"],
  [/\bevidence\s+requirements?\b/gi, "what we need to verify"],
  [/\bautonomy\s+envelope\b/gi, "working boundaries"],
  [/\bhuman\s+authorit(?:y|ies)\b/gi, "decisions that need you"],
  [/\bcontinuation\b/gi, "next step"],
  [/\bchange\s+proposal\b/gi, "Goal update"],
  [/\bresult\s+proposal\b/gi, "result review"],
  [/\bchange_proposal\b/gi, "Goal update"],
  [/\bresult_proposal\b/gi, "result review"],
  [/\bruntime\s+evidence\b/gi, "supporting evidence"],
  [/\brun\s+evidence\b/gi, "supporting work"],
  [/\bpara-memory-files\b/gi, "shared notes"],
  [/\b(?:the\s+)?[`]?shared notes[`]?\s+skill\b/gi, "shared notes"],
  [/\bdaily[- ]note\b/gi, "notes"],
  [/\b(?:runtime\s+)?evidence\s+(?:demonstrates?|shows?)\s+that\b/gi, "Supporting work shows that"],
] as const;

export function publicGoalText(value: string) {
  const mapped = INTERNAL_GOAL_LANGUAGE.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
  return mapped
    .replace(/\b(?:goal-feedback|goal-start|goal-change-decision|goal-result-evaluation):[0-9a-f-]{8,}\b/gi, "the related update")
    .replace(/\b(?:artifact|run|issue|project|approval|decision|measurement|library-file|library-entry):\/\/[^\s)]+/gi, "supporting work")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "the related item")
    .replace(/\b(?:feedback|activity|proposal|request|run)\s+(?:the related item|[0-9a-f-]{8,})\b/gi, "the related update");
}

function publicGoalToken(value: string) {
  const known: Record<string, string> = {
    bounded_reversible_work: "bounded, reversible work",
    external_or_irreversible_action: "external or irreversible actions",
    external_publication: "publishing externally",
    authority_expansion: "expanding access",
    acceptance: "accepting the result",
    consequentialChanges: "consequential changes",
    externalPublication: "publishing externally",
  };
  return known[value] ?? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

export function publicGoalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicGoalStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function publicGoalBoundarySummary(value: unknown) {
  const record = publicGoalRecord(value);
  const allowed = publicGoalStrings(record.allowed).map(publicGoalToken);
  const approvals = publicGoalStrings(record.requiresHumanApproval).map(publicGoalToken);
  const parts = [
    allowed.length > 0 ? `The Agent may handle ${allowed.join(", ")}.` : null,
    approvals.length > 0 ? `You will be asked before ${approvals.join(", ")}.` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

function publicGoalAuthoritySummary(value: unknown) {
  const decisions = Object.entries(publicGoalRecord(value))
    .filter(([, entry]) => entry === "board_human" || entry === true)
    .map(([key]) => publicGoalToken(key));
  return decisions.length > 0 ? `You decide ${decisions.join(", ")}.` : null;
}

function publicGoalCompletionSummary(value: unknown) {
  const record = publicGoalRecord(value);
  const requiresEvidence = record.terminalEvidenceRequired === true;
  const requiresAcceptance = record.humanAcceptanceRequired === true;
  if (requiresEvidence && requiresAcceptance) return "Supporting work is shown, and you accept the result.";
  if (requiresEvidence) return "Supporting work is shown before the result is considered ready.";
  if (requiresAcceptance) return "You accept the result when it is ready.";
  return null;
}

export function publicGoalContractSummary(value: unknown) {
  const record = publicGoalRecord(value);
  const outcomeStatement = typeof record.outcomeStatement === "string" && record.outcomeStatement.trim()
    ? publicGoalText(record.outcomeStatement)
    : null;
  const criteria = Array.isArray(record.criteria)
    ? record.criteria.flatMap((criterion) => {
      const label = publicGoalRecord(criterion).label;
      return typeof label === "string" && label.trim() ? [{ label: publicGoalText(label) }] : [];
    })
    : [];
  const targetTime = typeof record.evaluationDeadline === "string"
    ? record.evaluationDeadline
    : typeof record.actionDeadline === "string" ? record.actionDeadline : null;
  return {
    ...(outcomeStatement ? { outcomeStatement } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
    ...(targetTime ? { targetTime } : {}),
    ...(publicGoalBoundarySummary(record.autonomyEnvelope)
      ? { boundarySummary: publicGoalBoundarySummary(record.autonomyEnvelope) } : {}),
    ...(publicGoalAuthoritySummary(record.humanAuthorities)
      ? { approvalSummary: publicGoalAuthoritySummary(record.humanAuthorities) } : {}),
    ...(publicGoalCompletionSummary(record.evaluationPolicy)
      ? { completionSummary: publicGoalCompletionSummary(record.evaluationPolicy) } : {}),
  };
}
