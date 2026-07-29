import { hashOpaqueSecret, normalizeVerifiedEmail } from "@rudderhq/identity-core";
import { and, eq, sql } from "drizzle-orm";
import type { IdentityDb } from "./client.js";
import { identityEmailRateLimits } from "./schema.js";

export type IdentityEmailRateLimitAction = "otp-send" | "password-reset";

export async function consumeIdentityEmailRateLimit(
  db: IdentityDb,
  input: {
    email: string;
    action: IdentityEmailRateLimitAction;
    maxAttempts: number;
    windowSeconds: number;
    blockSeconds: number;
    now?: Date;
  },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = input.now ?? new Date();
  const bucketKeyHash = hashOpaqueSecret(normalizeVerifiedEmail(input.email));

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.action}:${bucketKeyHash}`}))`,
    );
    const current = await tx
      .select()
      .from(identityEmailRateLimits)
      .where(
        and(
          eq(identityEmailRateLimits.bucketKeyHash, bucketKeyHash),
          eq(identityEmailRateLimits.action, input.action),
        ),
      )
      .limit(1);
    const bucket = current[0];
    if (bucket?.blockedUntil && bucket.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.blockedUntil.getTime() - now.getTime()) / 1_000),
        ),
      };
    }

    const windowExpired =
      !bucket ||
      now.getTime() - bucket.windowStartedAt.getTime() >= input.windowSeconds * 1_000;
    const attempts = windowExpired ? 1 : bucket.attempts + 1;
    const allowed = attempts <= input.maxAttempts;
    const blockedUntil = allowed
      ? null
      : new Date(now.getTime() + input.blockSeconds * 1_000);

    await tx
      .insert(identityEmailRateLimits)
      .values({
        bucketKeyHash,
        action: input.action,
        windowStartedAt: windowExpired ? now : bucket.windowStartedAt,
        attempts,
        blockedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          identityEmailRateLimits.bucketKeyHash,
          identityEmailRateLimits.action,
        ],
        set: {
          windowStartedAt: windowExpired ? now : bucket!.windowStartedAt,
          attempts,
          blockedUntil,
          updatedAt: now,
        },
      });

    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : input.blockSeconds,
    };
  });
}
