import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { heartbeatRuns, type Db } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { parseObject } from "../../agent-runtimes/utils.js";
import { logger } from "../../middleware/logger.js";
import { sanitizeStartupContextContextForPersistence } from "./heartbeat.core.js";

export function buildPersistableHeartbeatContext(context: Record<string, unknown>) {
  return sanitizeStartupContextContextForPersistence(context) ?? {};
}

export async function acknowledgeUnstartedWriter(input: {
  runId: string;
  spanId: string | null;
  runWasRunningAtEntry: boolean;
  providerDispatchStarted: boolean;
  acknowledge: (runId: string, result: AgentRuntimeExecutionResult, spanId: string) => Promise<unknown>;
}) {
  // Only a fresh executor can prove it never called a provider. A recovered
  // running Run may still have a writer from its previous owner.
  if (input.runWasRunningAtEntry || input.providerDispatchStarted || !input.spanId) return;
  await input.acknowledge(input.runId, {
    summary: "",
    exitCode: null,
    signal: null,
    timedOut: false,
    submissionPhase: "pre_submission",
    nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
  }, input.spanId).catch((error) => {
    logger.error({ err: error, runId: input.runId, spanId: input.spanId }, "failed to persist pre-dispatch writer quiescence");
  });
}

export const EXECUTOR_OWNED_CONTEXT_KEYS = [
  "transcriptSource",
  "executionWorkspaceId",
  "rudderGitIdentity",
  "rudderScene",
  "rudderWorkspace",
  "rudderWorkspaces",
  "rudderStartupContext",
  "rudderStartupContextMetrics",
  "rudderRuntimeServiceIntents",
  "rudderSessionHandoffMarkdown",
  "rudderSessionRotationReason",
  "rudderPreviousSessionId",
  "rudderRuntimeServices",
  "rudderRuntimePrimaryUrl",
  "managedMcpPolicySnapshot",
] as const;

export function providerIdentityFromResult(result: Record<string, unknown>) {
  const payload = result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
    ? result.resultJson as Record<string, unknown>
    : {};
  const read = (...values: unknown[]) => values.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )?.trim() ?? null;
  return {
    providerThreadId: read(
      result.providerThreadId,
      result.sessionDisplayId,
      result.sessionId,
      payload.providerThreadId,
      payload.providerSessionId,
      payload.threadId,
    ),
    providerTurnId: read(
      result.providerTurnId,
      payload.providerTurnId,
      payload.turnId,
      payload.executionId,
      payload.messageId,
    ),
  };
}

export function createPersistRunningExecutionContext(
  db: Db,
  mergeCoalescedContextSnapshot: (incoming: Record<string, unknown>, existing: Record<string, unknown>) => Record<string, unknown>,
) {
  return async function persistRunningExecutionContext(
    runId: string,
    desiredContext: Record<string, unknown>,
    patch: Partial<typeof heartbeatRuns.$inferInsert> = {},
    expectedExecutionOwnerToken?: string | null,
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
      const currentRun = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!currentRun || currentRun.status !== "running") return null;
      if (expectedExecutionOwnerToken !== undefined
        && currentRun.executionOwnerToken !== expectedExecutionOwnerToken) return null;

      const persistableContext = buildPersistableHeartbeatContext(desiredContext);
      const mergedContext = mergeCoalescedContextSnapshot(
        persistableContext,
        parseObject(currentRun.contextSnapshot),
      );
      for (const key of EXECUTOR_OWNED_CONTEXT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(persistableContext, key)) {
          mergedContext[key] = persistableContext[key];
        } else {
          delete mergedContext[key];
        }
      }

      return tx
        .update(heartbeatRuns)
        .set({
          ...patch,
          contextSnapshot: mergedContext,
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
  };
}
