import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Serializes authority changes with OAuth grant activation across processes.
 * This lock must be acquired before connection/grant/session/secret row locks.
 */
export async function lockManagedMcpOAuthAuthorizer(
  tx: Transaction,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${"managed-mcp-oauth-authorizer:" + userId}, 0)
    )
  `);
}
