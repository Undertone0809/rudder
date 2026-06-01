import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { runDiagnosticFindings } from "@rudderhq/db";
import { buildRunDiagnosticFindings, type RunDiagnosticDraft } from "@rudderhq/run-intelligence-core";
import type {
  PatchRunDiagnosticFinding,
  RunDiagnosticFinding,
  RunDiagnosticFindingStatus,
  RunDiagnosticSummary,
} from "@rudderhq/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getObservedRunDetail } from "./run-intelligence.js";

const ACTIVE_STATUSES: RunDiagnosticFindingStatus[] = ["open", "acknowledged", "needs_human"];
const TERMINAL_STATUSES = new Set<RunDiagnosticFindingStatus>(["resolved", "ignored", "converted_to_issue"]);

function toFinding(row: typeof runDiagnosticFindings.$inferSelect): RunDiagnosticFinding {
  return {
    id: row.id,
    orgId: row.orgId,
    runId: row.runId,
    agentId: row.agentId,
    issueId: row.issueId,
    kind: row.kind as RunDiagnosticFinding["kind"],
    severity: row.severity as RunDiagnosticFinding["severity"],
    status: row.status as RunDiagnosticFindingStatus,
    fingerprint: row.fingerprint,
    summary: row.summary,
    detailsJson: row.detailsJson ?? null,
    evidenceJson: row.evidenceJson ?? [],
    rawExcerpt: row.rawExcerpt ?? null,
    source: row.source,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    occurrenceCount: row.occurrenceCount,
    resolvedAt: row.resolvedAt ?? null,
    resolutionNote: row.resolutionNote ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizePatch(input: PatchRunDiagnosticFinding): PatchRunDiagnosticFinding {
  const status = input.status;
  if (
    status != null &&
    !["open", "acknowledged", "resolved", "ignored", "needs_human", "converted_to_issue"].includes(status)
  ) {
    throw unprocessable("Invalid diagnostic status");
  }
  return {
    ...(status ? { status } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "resolutionNote")
      ? { resolutionNote: input.resolutionNote?.trim() || null }
      : {}),
  };
}

export function runDiagnosticsService(db: Db) {
  async function upsertDraft(input: {
    orgId: string;
    runId: string;
    agentId: string;
    issueId: string | null;
    draft: RunDiagnosticDraft;
  }): Promise<RunDiagnosticFinding> {
    const now = new Date();
    const sameRun = await db
      .select()
      .from(runDiagnosticFindings)
      .where(and(
        eq(runDiagnosticFindings.orgId, input.orgId),
        eq(runDiagnosticFindings.runId, input.runId),
        eq(runDiagnosticFindings.fingerprint, input.draft.fingerprint),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (sameRun) {
      const [updated] = await db
        .update(runDiagnosticFindings)
        .set({
          kind: input.draft.kind,
          severity: input.draft.severity,
          summary: input.draft.summary,
          detailsJson: input.draft.detailsJson ?? null,
          evidenceJson: input.draft.evidenceJson,
          rawExcerpt: input.draft.rawExcerpt ?? null,
          source: input.draft.source ?? "run_diagnostics",
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(runDiagnosticFindings.id, sameRun.id))
        .returning();
      return toFinding(updated ?? sameRun);
    }

    const activeExisting = await db
      .select()
      .from(runDiagnosticFindings)
      .where(and(
        eq(runDiagnosticFindings.orgId, input.orgId),
        eq(runDiagnosticFindings.fingerprint, input.draft.fingerprint),
        inArray(runDiagnosticFindings.status, ACTIVE_STATUSES),
      ))
      .orderBy(desc(runDiagnosticFindings.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (activeExisting) {
      const [updated] = await db
        .update(runDiagnosticFindings)
        .set({
          runId: input.runId,
          agentId: input.agentId,
          issueId: input.issueId,
          kind: input.draft.kind,
          severity: input.draft.severity,
          summary: input.draft.summary,
          detailsJson: input.draft.detailsJson ?? null,
          evidenceJson: input.draft.evidenceJson,
          rawExcerpt: input.draft.rawExcerpt ?? null,
          source: input.draft.source ?? "run_diagnostics",
          lastSeenAt: now,
          occurrenceCount: sql`${runDiagnosticFindings.occurrenceCount} + 1`,
          updatedAt: now,
        })
        .where(eq(runDiagnosticFindings.id, activeExisting.id))
        .returning();
      return toFinding(updated ?? activeExisting);
    }

    const [created] = await db
      .insert(runDiagnosticFindings)
      .values({
        orgId: input.orgId,
        runId: input.runId,
        agentId: input.agentId,
        issueId: input.issueId,
        kind: input.draft.kind,
        severity: input.draft.severity,
        status: "open",
        fingerprint: input.draft.fingerprint,
        summary: input.draft.summary,
        detailsJson: input.draft.detailsJson ?? null,
        evidenceJson: input.draft.evidenceJson,
        rawExcerpt: input.draft.rawExcerpt ?? null,
        source: input.draft.source ?? "run_diagnostics",
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toFinding(created!);
  }

  return {
    list: async (input: {
      orgId: string;
      status?: RunDiagnosticFindingStatus | null;
      runId?: string | null;
      limit?: number | null;
    }): Promise<RunDiagnosticFinding[]> => {
      const conditions = [eq(runDiagnosticFindings.orgId, input.orgId)];
      if (input.status) conditions.push(eq(runDiagnosticFindings.status, input.status));
      if (input.runId) conditions.push(eq(runDiagnosticFindings.runId, input.runId));
      const rows = await db
        .select()
        .from(runDiagnosticFindings)
        .where(and(...conditions))
        .orderBy(desc(runDiagnosticFindings.updatedAt))
        .limit(Math.max(1, Math.min(200, input.limit ?? 50)));
      return rows.map(toFinding);
    },

    summary: async (orgId: string): Promise<RunDiagnosticSummary> => {
      const rows = await db
        .select()
        .from(runDiagnosticFindings)
        .where(eq(runDiagnosticFindings.orgId, orgId))
        .limit(1000);
      const summary: RunDiagnosticSummary = { total: rows.length, open: 0, byKind: {}, bySeverity: {} };
      for (const row of rows) {
        if (row.status === "open") summary.open += 1;
        summary.byKind[row.kind] = (summary.byKind[row.kind] ?? 0) + 1;
        summary.bySeverity[row.severity] = (summary.bySeverity[row.severity] ?? 0) + 1;
      }
      return summary;
    },

    update: async (
      orgId: string,
      findingId: string,
      patch: PatchRunDiagnosticFinding,
    ): Promise<RunDiagnosticFinding> => {
      const normalized = normalizePatch(patch);
      const existing = await db
        .select()
        .from(runDiagnosticFindings)
        .where(and(eq(runDiagnosticFindings.orgId, orgId), eq(runDiagnosticFindings.id, findingId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Run diagnostic finding not found");

      const nextStatus = normalized.status ?? (existing.status as RunDiagnosticFindingStatus);
      const now = new Date();
      const [updated] = await db
        .update(runDiagnosticFindings)
        .set({
          ...normalized,
          resolvedAt: TERMINAL_STATUSES.has(nextStatus) ? now : null,
          updatedAt: now,
        })
        .where(eq(runDiagnosticFindings.id, existing.id))
        .returning();
      return toFinding(updated ?? existing);
    },

    analyzeRun: async (runId: string): Promise<RunDiagnosticFinding[]> => {
      const detail = await getObservedRunDetail(db, runId);
      if (!detail) throw notFound("Heartbeat run not found");
      const drafts = buildRunDiagnosticFindings(detail);
      const issueId = detail.issue?.id ?? null;
      const stored: RunDiagnosticFinding[] = [];
      for (const draft of drafts) {
        stored.push(await upsertDraft({
          orgId: detail.run.orgId,
          runId: detail.run.id,
          agentId: detail.run.agentId,
          issueId,
          draft,
        }));
      }
      return stored;
    },

    analyzeRunIfEnabled: async (
      runId: string,
      isEnabled: () => Promise<boolean>,
    ): Promise<RunDiagnosticFinding[]> => {
      if (!await isEnabled()) return [];
      try {
        return await runDiagnosticsService(db).analyzeRun(runId);
      } catch (err) {
        logger.warn({ err, runId }, "failed to analyze heartbeat run diagnostics");
        return [];
      }
    },
  };
}
