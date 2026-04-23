import { eq } from "drizzle-orm";
import type { Db } from "@rudder/db";
import { assets } from "@rudder/db";

export function assetService(db: Db) {
  return {
    create: (orgId: string, data: Omit<typeof assets.$inferInsert, "orgId">) =>
      db
        .insert(assets)
        .values({ ...data, orgId })
        .returning()
        .then((rows) => rows[0]),

    getById: (id: string) =>
      db
        .select()
        .from(assets)
        .where(eq(assets.id, id))
        .then((rows) => rows[0] ?? null),
  };
}

