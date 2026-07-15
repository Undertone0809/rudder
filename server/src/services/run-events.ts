import type { Db } from "@rudderhq/db";
import { heartbeatRunEvents } from "@rudderhq/db";
import { eq, sql } from "drizzle-orm";

type NewRunEvent = Omit<typeof heartbeatRunEvents.$inferInsert, "id" | "seq" | "createdAt">;

export async function appendHeartbeatRunEvent(db: Db, event: NewRunEvent) {
  return db.transaction(async (tx) => {
    // A transaction-scoped advisory lock serializes every writer for one run,
    // including watchdogs that execute outside the adapter's local sequence.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${event.runId}))`);
    const [current] = await tx
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, event.runId));
    const seq = Number(current?.maxSeq ?? 0) + 1;
    return tx
      .insert(heartbeatRunEvents)
      .values({ ...event, seq })
      .returning()
      .then((rows) => rows[0]!);
  });
}
