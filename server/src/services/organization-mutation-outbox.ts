import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import { LIVE_EVENT_TYPES, type LiveEventType } from "@rudderhq/shared";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_ERROR_LENGTH = 2_000;

type ClaimedOutboxRow = {
  id: string;
  org_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type OutboxPublisherOptions = {
  intervalMs?: number;
  batchSize?: number;
};

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function isLiveEventType(value: string): value is LiveEventType {
  return (LIVE_EVENT_TYPES as readonly string[]).includes(value);
}

async function claimBatch(db: Db, batchSize: number): Promise<ClaimedOutboxRow[]> {
  const result = await db.execute(sql`
    WITH claim AS (
      SELECT id
      FROM organization_mutation_outbox
      WHERE state = 'pending'
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE organization_mutation_outbox AS outbox
    SET attempts = outbox.attempts + 1,
        next_attempt_at = now() + interval '1 second'
    FROM claim
    WHERE outbox.id = claim.id
    RETURNING outbox.id::text,
      outbox.org_id::text,
      outbox.event_type,
      outbox.payload,
      outbox.attempts
  `);
  const postgresResult = result as unknown as ClaimedOutboxRow[] | {
    rows?: ClaimedOutboxRow[];
  };
  return Array.isArray(postgresResult)
    ? postgresResult
    : (postgresResult.rows ?? []);
}

async function markPublished(db: Db, row: ClaimedOutboxRow) {
  await db.execute(sql`
    UPDATE organization_mutation_outbox
    SET state = 'published', published_at = now(), last_error = NULL
    WHERE id = ${row.id}::uuid
      AND state = 'pending'
      AND attempts = ${row.attempts}
  `);
}

async function markFailed(db: Db, row: ClaimedOutboxRow, error: unknown) {
  await db.execute(sql`
    UPDATE organization_mutation_outbox
    SET last_error = ${errorText(error)},
        next_attempt_at = now() + make_interval(
          secs => LEAST(60::double precision, GREATEST(1::double precision,
            power(2::double precision, LEAST(attempts, 6)::double precision)))
        )
    WHERE id = ${row.id}::uuid
      AND state = 'pending'
      AND attempts = ${row.attempts}
  `);
}

/**
 * Deliver Rust activity events through the transitional Node event bus.
 *
 * Reasoning:
 * - claim leases are persisted before publication, so a process crash leaves
 *   the row eligible for retry instead of losing the event;
 * - publication is completed before the row becomes published, so the Rust
 *   business transaction never relies on an in-process Node side effect;
 * - the service is intentionally scoped to the current outbox table and can
 *   be removed when the Rust websocket/event transport owns delivery.
 */
export function startOrganizationMutationOutboxPublisher(
  db: Db,
  options: OutboxPublisherOptions = {},
) {
  const intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const batchSize = Math.max(1, Math.min(500, options.batchSize ?? DEFAULT_BATCH_SIZE));
  let closed = false;
  let drainInFlight: Promise<void> | null = null;

  const drain = async () => {
    if (closed || drainInFlight) return drainInFlight;
    drainInFlight = (async () => {
      const rows = await claimBatch(db, batchSize);
      for (const row of rows) {
        try {
          if (!isLiveEventType(row.event_type)) {
            throw new Error(`Unsupported organization mutation outbox event type: ${row.event_type}`);
          }
          publishLiveEvent({
            orgId: row.org_id,
            type: row.event_type,
            payload: row.payload,
            dedupeKey: `organization-mutation-outbox:${row.id}`,
          });
          await markPublished(db, row);
        } catch (error) {
          await markFailed(db, row, error);
          logger.warn({ err: error, outboxId: row.id, orgId: row.org_id }, "organization mutation outbox delivery failed");
        }
      }
    })().finally(() => {
      drainInFlight = null;
    });
    return drainInFlight;
  };

  const timer = setInterval(() => {
    void drain().catch((error) => {
      logger.warn({ err: error }, "organization mutation outbox claim failed");
    });
  }, intervalMs);

  void drain().catch((error) => {
    logger.warn({ err: error }, "organization mutation outbox startup drain failed");
  });

  return {
    drain,
    async close() {
      closed = true;
      clearInterval(timer);
      await drainInFlight;
    },
  };
}
