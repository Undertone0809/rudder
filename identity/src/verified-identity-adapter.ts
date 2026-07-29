import { normalizeVerifiedEmail } from "@rudderhq/identity-core";
import {
  type IdentityDb,
  identityAuthAccounts,
  identityDeviceCodes,
  identityRateLimits,
  identitySessions,
  identityUsers,
  identityVerifications,
} from "@rudderhq/identity-db";
import * as drizzleAdapterModule from "better-auth/adapters/drizzle";
import { randomUUID } from "node:crypto";

type AdapterCreateInput = {
  model: string;
  data: Record<string, unknown>;
  forceAllowId?: boolean;
};

type CompatibleAdapter = {
  create(input: AdapterCreateInput): Promise<Record<string, unknown> | null>;
  [key: string]: unknown;
};

type DrizzleAdapterFactory = (
  database: unknown,
  config: unknown,
) => (options: unknown) => CompatibleAdapter;

// Better Auth 1.6 exposes this runtime symbol, but some Vercel trace workers
// resolve the compatibility declaration without its named re-export. Reading
// through the namespace keeps the runtime contract while avoiding that
// declaration-only named-import failure.
const drizzleAdapter = (
  drizzleAdapterModule as unknown as { drizzleAdapter: DrizzleAdapterFactory }
).drizzleAdapter;

/**
 * Better Auth resolves existing users by email for sequential OAuth, OTP, and
 * password flows. Its default adapter still performs a plain INSERT if two
 * first verified logins race. This adapter makes the verified-user create an
 * atomic PostgreSQL upsert, so every authentication path converges on the
 * unique normalized email before its provider account is linked.
 */
export function verifiedIdentityAdapter(db: IdentityDb) {
  const baseFactory = drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: identityUsers,
      session: identitySessions,
      account: identityAuthAccounts,
      verification: identityVerifications,
      rateLimit: identityRateLimits,
      deviceCode: identityDeviceCodes,
    },
  });

  return (options: unknown) => {
    const adapter = baseFactory(options);
    return {
      ...adapter,
      create: async (input: AdapterCreateInput) => {
        if (
          input.model !== "user" ||
          input.data.emailVerified !== true ||
          typeof input.data.email !== "string"
        ) {
          return adapter.create(input);
        }

        const normalizedEmail = normalizeVerifiedEmail(input.data.email);
        const now = new Date();
        const [user] = await db
          .insert(identityUsers)
          .values({
            id: typeof input.data.id === "string" ? input.data.id : randomUUID(),
            email: normalizedEmail,
            emailVerified: true,
            name:
              typeof input.data.name === "string" && input.data.name.trim()
                ? input.data.name.trim()
                : normalizedEmail.split("@")[0]!,
            image: typeof input.data.image === "string" ? input.data.image : null,
            createdAt: input.data.createdAt instanceof Date ? input.data.createdAt : now,
            updatedAt: input.data.updatedAt instanceof Date ? input.data.updatedAt : now,
          })
          .onConflictDoUpdate({
            target: identityUsers.email,
            set: {
              emailVerified: true,
              updatedAt: now,
            },
          })
          .returning();
        if (!user) throw new Error("Unable to resolve verified identity");
        return user;
      },
    };
  };
}
