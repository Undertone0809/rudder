import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import { identityRateLimits } from "./schema.js";

export async function consumeIdentityOperationRateLimit(
  db: IdentityDb,
  input: {
    key: string;
    limit: number;
    windowMs: number;
    now?: Date;
  },
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (!input.key || input.limit < 1 || input.windowMs < 1) {
    throw new Error("invalid_rate_limit");
  }
  const nowMs = (input.now ?? new Date()).getTime();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.key}, 0))`,
    );
    const [current] = await tx
      .select()
      .from(identityRateLimits)
      .where(eq(identityRateLimits.key, input.key))
      .limit(1)
      .for("update");
    const windowEndsAt = (current?.lastRequest ?? 0) + input.windowMs;
    if (!current || windowEndsAt <= nowMs) {
      await tx
        .insert(identityRateLimits)
        .values({
          id: current?.id ?? randomUUID(),
          key: input.key,
          count: 1,
          lastRequest: nowMs,
        })
        .onConflictDoUpdate({
          target: identityRateLimits.key,
          set: { count: 1, lastRequest: nowMs },
        });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (current.count >= input.limit) {
      return {
        allowed: false,
        retryAfterMs: Math.max(1, windowEndsAt - nowMs),
      };
    }
    await tx
      .update(identityRateLimits)
      .set({ count: current.count + 1 })
      .where(eq(identityRateLimits.id, current.id));
    return { allowed: true, retryAfterMs: 0 };
  });
}
