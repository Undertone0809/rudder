import type { Db } from "@rudderhq/db";
import {
  agents,
  goals,
  issues,
  organizationMemberships,
  projects,
} from "@rudderhq/db";
import { isUuidLike, parseShortRef, type ShortRefKind } from "@rudderhq/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { conflict, notFound, unprocessable } from "../errors.js";

const SHORT_REF_PREFIX_BY_KIND: Record<ShortRefKind, string> = {
  agent: "agt",
  chat: "cht",
  issue_comment: "cmt",
  run: "run",
  message: "msg",
  project: "prj",
  goal: "gol",
  user: "usr",
  issue: "iss",
};

type EntityKind = "agent" | "project" | "goal" | "issue";

type EntityTable = {
  id: AnyPgColumn;
  orgId: AnyPgColumn;
};

export type EntityReferenceScope = {
  orgId?: string;
  orgIds?: readonly string[];
};

function typedReferenceMessage(label: string, kind: ShortRefKind) {
  return `${label} must be a UUID or typed ${SHORT_REF_PREFIX_BY_KIND[kind]}_<prefix> reference`;
}

function hasTypedReferencePrefix(value: string) {
  return /^[a-z]{3}_/i.test(value);
}

function parseExpectedShortReference(value: string, kind: ShortRefKind, label: string) {
  const parsed = parseShortRef(value);
  if (!parsed) {
    if (hasTypedReferencePrefix(value)) {
      throw unprocessable(typedReferenceMessage(label, kind));
    }
    return null;
  }
  if (parsed.kind !== kind) {
    throw unprocessable(typedReferenceMessage(label, kind));
  }
  return parsed;
}

function organizationCondition(table: EntityTable, scope: EntityReferenceScope) {
  if (scope.orgId !== undefined) return eq(table.orgId, scope.orgId);
  if (scope.orgIds === undefined) return undefined;
  if (scope.orgIds.length === 0) return sql`false`;
  return inArray(table.orgId, [...scope.orgIds]);
}

async function resolveEntityReference(
  db: Db,
  scope: EntityReferenceScope,
  value: string,
  kind: EntityKind,
  label: string,
  table: EntityTable,
): Promise<string> {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw unprocessable(`${label} must not be empty`);
  }
  if (isUuidLike(normalized)) return normalized;

  const parsed = parseExpectedShortReference(normalized, kind, label);
  if (!parsed) {
    throw unprocessable(typedReferenceMessage(label, kind));
  }

  const conditions = [
    sql`replace(lower(${table.id}::text), '-', '') like ${`${parsed.prefix}%`}`,
  ];
  const organizationFilter = organizationCondition(table, scope);
  if (organizationFilter) conditions.push(organizationFilter);

  const rows = await db
    .select({ id: table.id })
    .from(table as any)
    .where(and(...conditions))
    .limit(2) as Array<{ id: string }>;

  if (rows.length === 0) {
    throw notFound(`${label} short reference not found in this organization`);
  }
  if (rows.length > 1) {
    throw conflict(`${label} short reference is ambiguous in this organization. Use a longer typed ref.`, {
      reference: parsed.ref,
    });
  }
  return rows[0]!.id;
}

async function resolveUserReference(db: Db, orgId: string, value: string, label: string): Promise<string> {
  const normalized = value.trim();
  if (normalized.length === 0 || isUuidLike(normalized)) return normalized;

  const parsed = parseExpectedShortReference(normalized, "user", label);
  if (!parsed) return normalized;

  const rows = await db
    .select({ id: organizationMemberships.principalId })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.orgId, orgId),
      eq(organizationMemberships.principalType, "user"),
      eq(organizationMemberships.status, "active"),
      sql`replace(lower(${organizationMemberships.principalId}), '-', '') like ${`${parsed.prefix}%`}`,
    ))
    .limit(2) as Array<{ id: string }>;
  const uniqueIds = [...new Set(rows.map((row) => row.id))];

  if (uniqueIds.length === 0) {
    throw notFound(`${label} short reference not found in this organization`);
  }
  if (uniqueIds.length > 1) {
    throw conflict(`${label} short reference is ambiguous in this organization. Use a longer typed ref.`, {
      reference: parsed.ref,
    });
  }
  return uniqueIds[0]!;
}

/** Resolve an issue path reference inside an authorized organization scope. */
export async function resolveIssueReference(
  db: Db,
  reference: string,
  scope: EntityReferenceScope = {},
): Promise<string> {
  return resolveEntityReference(db, scope, reference, "issue", "Issue ID", issues);
}

const REFERENCE_FIELDS = [
  { key: "agentId", kind: "agent", label: "Agent ID", table: agents },
  { key: "participantAgentId", kind: "agent", label: "Participant agent ID", table: agents },
  { key: "assigneeAgentId", kind: "agent", label: "Assignee agent ID", table: agents },
  { key: "reviewerAgentId", kind: "agent", label: "Reviewer agent ID", table: agents },
  { key: "projectId", kind: "project", label: "Project ID", table: projects },
  { key: "goalId", kind: "goal", label: "Goal ID", table: goals },
  { key: "parentId", kind: "issue", label: "Parent issue ID", table: issues },
  { key: "parentIssueId", kind: "issue", label: "Parent issue ID", table: issues },
  { key: "issueId", kind: "issue", label: "Issue ID", table: issues },
  { key: "previousIssueId", kind: "issue", label: "Previous issue ID", table: issues },
  { key: "nextIssueId", kind: "issue", label: "Next issue ID", table: issues },
] as const;

const USER_REFERENCE_FIELDS = [
  { key: "assigneeUserId", label: "Assignee user ID" },
  { key: "reviewerUserId", label: "Reviewer user ID" },
  { key: "touchedByUserId", label: "Touched-by user ID" },
  { key: "unreadForUserId", label: "Unread-for user ID" },
  { key: "followedByUserId", label: "Followed-by user ID" },
  { key: "involvedUserId", label: "Involved user ID" },
] as const;

/** Resolve all organization-scoped references used by Issue-shaped inputs. */
export async function resolveIssueReferenceInputs<T extends Record<string, unknown>>(
  db: Db,
  orgId: string,
  input: T,
): Promise<T> {
  const resolved: Record<string, unknown> = { ...input };
  for (const field of REFERENCE_FIELDS) {
    const value = resolved[field.key];
    if (typeof value !== "string") continue;
    resolved[field.key] = await resolveEntityReference(
      db,
      { orgId },
      value,
      field.kind,
      field.label,
      field.table,
    );
  }
  for (const field of USER_REFERENCE_FIELDS) {
    const value = resolved[field.key];
    if (typeof value !== "string") continue;
    resolved[field.key] = await resolveUserReference(db, orgId, value, field.label);
  }
  return resolved as T;
}
