import type { Db } from "@rudderhq/db";
import { assets } from "@rudderhq/db";
import { eq } from "drizzle-orm";
import { lockNodeMutationAuthority } from "./organization-mutation-fence.js";

export function assetService(db: Db) {
  return {
    create: (orgId: string, data: Omit<typeof assets.$inferInsert, "orgId">) =>
      db.transaction(async (tx) => {
        await lockNodeMutationAuthority(tx, orgId);
        const rows = await tx
          .insert(assets)
          .values({ ...data, orgId })
          .returning();
        return rows[0];
      }),

    getById: (id: string) =>
      db
        .select()
        .from(assets)
        .where(eq(assets.id, id))
        .then((rows) => rows[0] ?? null),
  };
}
