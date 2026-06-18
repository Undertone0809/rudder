import type { Db } from "@rudderhq/db";
import { heartbeatRuns } from "@rudderhq/db";
import { isUuidLike } from "@rudderhq/shared";
import { and, desc, inArray, sql } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";

export const MIN_SHORT_RUN_ID_LENGTH = 8;
export const DEFAULT_SHORT_RUN_ID_LENGTH = 12;
const HEX_PREFIX_RE = /^[0-9a-f]+$/iu;

export function formatShortRunId(runId: string): string {
  if (!isUuidLike(runId)) return runId;
  return normalizedUuid(runId).slice(0, DEFAULT_SHORT_RUN_ID_LENGTH);
}

export function isShortRunIdReference(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= MIN_SHORT_RUN_ID_LENGTH && HEX_PREFIX_RE.test(normalized) && !isUuidLike(normalized);
}

export async function resolveHeartbeatRunIdReference(
  db: Db,
  runIdRef: string,
  scope: { orgIds?: string[] } = {},
): Promise<string> {
  const normalized = runIdRef.trim().toLowerCase();
  if (!isShortRunIdReference(normalized)) return runIdRef;
  if (scope.orgIds?.length === 0) throw notFound("Heartbeat run not found");

  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      sql`replace(${heartbeatRuns.id}::text, '-', '') like ${`${normalized}%`}`,
      ...(scope.orgIds ? [inArray(heartbeatRuns.orgId, scope.orgIds)] : []),
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(2);

  if (rows.length === 0) throw notFound("Heartbeat run not found");
  if (rows.length === 1) return rows[0]!.id;

  throw conflict("Run ID prefix is ambiguous", {
    runId: normalized,
    matches: formatUniqueShortRunIds(rows.map((row) => row.id)),
  });
}

function normalizedUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

function formatUniqueShortRunIds(runIds: string[]): string[] {
  const normalizedIds = runIds.map((id) => normalizedUuid(id));
  for (let length = DEFAULT_SHORT_RUN_ID_LENGTH; length <= 32; length += 1) {
    const candidates = normalizedIds.map((id) => id.slice(0, length));
    if (new Set(candidates).size === candidates.length) {
      return candidates;
    }
  }
  return normalizedIds;
}
