import { and, eq } from "drizzle-orm";
import type { Db } from "@rudder/db";
import { agents } from "@rudder/db";
import type { HireApprovedPayload } from "@rudder/agent-runtime-utils";
import { findServerAdapter } from "../agent-runtimes/registry.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

const HIRE_APPROVED_MESSAGE =
  "Tell your user that your hire was approved, now they should assign you a task in Rudder or ask you to create issues.";

export interface NotifyHireApprovedInput {
  orgId: string;
  agentId: string;
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt?: Date;
}

/**
 * Invokes the adapter's onHireApproved hook when an agent is approved (join-request or hire_agent approval).
 * Failures are non-fatal: we log and write to activity, never throw.
 */
export async function notifyHireApproved(
  db: Db,
  input: NotifyHireApprovedInput,
): Promise<void> {
  const { orgId, agentId, source, sourceId } = input;
  const approvedAt = input.approvedAt ?? new Date();

  const row = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .then((rows) => rows[0] ?? null);

  if (!row) {
    logger.warn({ orgId, agentId, source, sourceId }, "hire hook: agent not found in organization, skipping");
    return;
  }

  const agentRuntimeType = row.agentRuntimeType ?? "process";
  const adapter = findServerAdapter(agentRuntimeType);
  const onHireApproved = adapter?.onHireApproved;
  if (!onHireApproved) {
    return;
  }

  const payload: HireApprovedPayload = {
    orgId,
    agentId,
    agentName: row.name,
    agentRuntimeType,
    source,
    sourceId,
    approvedAt: approvedAt.toISOString(),
    message: HIRE_APPROVED_MESSAGE,
  };

  const agentRuntimeConfig =
    typeof row.agentRuntimeConfig === "object" && row.agentRuntimeConfig !== null && !Array.isArray(row.agentRuntimeConfig)
      ? (row.agentRuntimeConfig as Record<string, unknown>)
      : {};

  try {
    const result = await onHireApproved(payload, agentRuntimeConfig);
    if (result.ok) {
      await logActivity(db, {
        orgId,
        actorType: "system",
        actorId: "hire_hook",
        action: "hire_hook.succeeded",
        entityType: "agent",
        entityId: agentId,
        details: { source, sourceId, agentRuntimeType },
      });
      return;
    }

    logger.warn(
      { orgId, agentId, agentRuntimeType, source, sourceId, error: result.error, detail: result.detail },
      "hire hook: adapter returned failure",
    );
    await logActivity(db, {
      orgId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.failed",
      entityType: "agent",
      entityId: agentId,
      details: { source, sourceId, agentRuntimeType, error: result.error, detail: result.detail },
    });
  } catch (err) {
    logger.error(
      { err, orgId, agentId, agentRuntimeType, source, sourceId },
      "hire hook: adapter threw",
    );
    await logActivity(db, {
      orgId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.error",
      entityType: "agent",
      entityId: agentId,
      details: {
        source,
        sourceId,
        agentRuntimeType,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
