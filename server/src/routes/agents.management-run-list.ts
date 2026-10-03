import type { Db } from "@rudderhq/db";
import type { HeartbeatRun } from "@rudderhq/shared";
import type { Request } from "express";
import {
  filterRunsByRunIntelligenceAccess,
  type RunIntelligenceAccessScope,
} from "../services/run-intelligence-access.js";

type HeartbeatRunList = {
  list(
    orgId: string,
    agentId: string | undefined,
    limit: number | undefined,
    filters: { startDate?: Date; endDate?: Date; goalId?: string },
  ): Promise<HeartbeatRun[]>;
};

export async function listAgentRunsForRequest(
  req: Request,
  orgId: string,
  heartbeat: HeartbeatRunList,
  db: Db,
  scope: RunIntelligenceAccessScope,
) {
  const agentId = req.query.agentId as string | undefined;
  const limitParam = req.query.limit as string | undefined;
  const startDateParam = req.query.startDate as string | undefined;
  const endDateParam = req.query.endDate as string | undefined;
  const goalIdParam = req.query.goalId as string | undefined;
  const startDate = startDateParam ? new Date(startDateParam) : undefined;
  const endDate = endDateParam ? new Date(endDateParam) : undefined;
  const filters = {
    startDate: startDate && Number.isFinite(startDate.getTime()) ? startDate : undefined,
    endDate: endDate && Number.isFinite(endDate.getTime()) ? endDate : undefined,
    goalId: goalIdParam && /^[0-9a-f-]{36}$/i.test(goalIdParam) ? goalIdParam : undefined,
  };
  const hasDateRange = Boolean(filters.startDate || filters.endDate);
  const limit = limitParam
    ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 100))
    : hasDateRange
      ? undefined
      : 100;
  const runs = await heartbeat.list(orgId, agentId, limit, filters);
  return filterRunsByRunIntelligenceAccess<HeartbeatRun>(db, runs, scope);
}
