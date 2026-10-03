import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { RustFoundationBridge, RustFoundationResponse } from "./rust-foundation-bridge.js";

/** Routing is advisory; both writers repeat ownership checks under the shared
 * organization mutex. A rejected Rust invocation must never select Node. */
export async function forwardRustOrganizationResourceMutation(
  db: Db,
  bridge: RustFoundationBridge | undefined,
  req: Request,
  orgId: string,
  resourceId: string,
  operation: "update" | "delete",
  data: Record<string, unknown>,
): Promise<RustFoundationResponse | null> {
  const result = await db.execute(sql`
    SELECT (
      EXISTS (
        SELECT 1 FROM organization_resource_mutation_state
        WHERE org_id = ${orgId}::uuid AND resource_id = ${resourceId}::uuid AND owner = 'rust'
      ) OR EXISTS (
        SELECT 1 FROM project_resource_attachments a
        JOIN project_goal_mutation_state p ON p.project_id = a.project_id AND p.org_id = a.org_id
        WHERE a.org_id = ${orgId}::uuid AND a.resource_id = ${resourceId}::uuid AND p.owner = 'rust'
      )
    ) AS requires_rust
  `);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  const row = rows[0] as { requires_rust?: boolean } | undefined;
  if (row?.requires_rust === false) return null;
  if (row?.requires_rust !== true) {
    throw new HttpError(503, "Organization resource authority could not be verified");
  }
  if (bridge?.projectGoalSetMode !== "required" || !bridge.organizationResourceMutation) {
    throw new HttpError(503, "Rust organization resource authority is unavailable");
  }
  const key = req.header("x-rudder-idempotency-key")?.trim() || randomUUID();
  const body = Buffer.from(JSON.stringify({ data, runId: req.actor.runId ?? null }), "utf8");
  try {
    return await bridge.organizationResourceMutation(req, orgId, resourceId, operation, body, key);
  } catch {
    throw new HttpError(503, "Rust organization resource authority is unavailable");
  }
}
