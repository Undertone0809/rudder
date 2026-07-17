import type { Db } from "@rudderhq/db";
import {
  assets,
  chatAttachments,
  issueAttachments,
  organizationLogos,
} from "@rudderhq/db";
import { and, eq, inArray, sql } from "drizzle-orm";

function orphanedAssetConditions(orgId: string, assetIds: string[]) {
  return and(
    eq(assets.orgId, orgId),
    inArray(assets.id, assetIds),
    sql<boolean>`not exists (
      select 1 from ${chatAttachments} where ${chatAttachments.assetId} = ${assets.id}
    )`,
    sql<boolean>`not exists (
      select 1 from ${issueAttachments} where ${issueAttachments.assetId} = ${assets.id}
    )`,
    sql<boolean>`not exists (
      select 1 from ${organizationLogos} where ${organizationLogos.assetId} = ${assets.id}
    )`,
  );
}

export function orphanedAssetService(db: Db) {
  return {
    list: async (orgId: string, assetIds: string[]) => {
      const ids = [...new Set(assetIds)];
      if (ids.length === 0) return [];
      return db
        .select({ id: assets.id, orgId: assets.orgId, objectKey: assets.objectKey })
        .from(assets)
        .where(orphanedAssetConditions(orgId, ids));
    },

    remove: async (orgId: string, assetIds: string[]) => {
      const ids = [...new Set(assetIds)];
      if (ids.length === 0) return [];
      return db
        .delete(assets)
        .where(orphanedAssetConditions(orgId, ids))
        .returning({ id: assets.id });
    },
  };
}
