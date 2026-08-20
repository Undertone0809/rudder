import type { Db } from "@rudderhq/db";
import {
  agents,
  authUsers,
  operatorProfiles,
  organizationMemberships,
} from "@rudderhq/db";
import { shortRefFor } from "@rudderhq/shared";
import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNotNull,
  not,
  or,
  sql,
} from "drizzle-orm";
import { badRequest } from "../errors.js";

export type OrganizationMemberType = "human" | "agent";

export type OrganizationMemberDirectoryFilters = {
  orgId: string;
  query?: string | null;
  type?: OrganizationMemberType | "all" | null;
  limit?: number;
  cursor?: string | null;
  fullIds?: boolean;
};

export type OrganizationMemberDirectoryItem = {
  name: string;
  type: OrganizationMemberType;
  role: string;
  ref: string;
};

export type OrganizationMemberDirectoryPage = {
  total: number;
  items: OrganizationMemberDirectoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

type MemberCursor = {
  name: string;
  type: OrganizationMemberType;
  principalId: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw badRequest(`'limit' must be between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function encodeCursor(cursor: MemberCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null | undefined): MemberCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<MemberCursor>;
    if (
      typeof parsed.name !== "string"
      || (parsed.type !== "agent" && parsed.type !== "human")
      || typeof parsed.principalId !== "string"
      || parsed.principalId.trim().length === 0
    ) {
      throw new Error("invalid member cursor");
    }
    return {
      name: parsed.name,
      type: parsed.type,
      principalId: parsed.principalId,
    };
  } catch {
    throw badRequest("Invalid organization member cursor.");
  }
}

function safeMemberRef(type: OrganizationMemberType, principalId: string, fullIds = false) {
  if (fullIds) return principalId;
  try {
    return shortRefFor(type === "agent" ? "agent" : "user", principalId);
  } catch {
    const compact = principalId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "unknown";
    return `${type === "agent" ? "agt" : "usr"}_${compact}`;
  }
}

function isVisibleAgentMembership() {
  return and(
    eq(organizationMemberships.principalType, "agent"),
    isNotNull(agents.id),
    not(inArray(agents.status, ["terminated", "suspended", "pending", "pending_approval"])),
    sql`coalesce(${agents.metadata}->>'hidden', 'false') <> 'true'`,
    sql`coalesce(${agents.metadata}->>'systemManaged', '') <> 'rudder_copilot'`,
  );
}

function memberNameExpression() {
  return sql<string>`case
    when ${organizationMemberships.principalType} = 'agent'
      then coalesce(nullif(trim(${agents.name}), ''), 'Agent')
    else coalesce(
      nullif(trim(${operatorProfiles.nickname}), ''),
      nullif(trim(${authUsers.name}), ''),
      'Human'
    )
  end`;
}

function memberTypeExpression() {
  return sql<string>`case
    when ${organizationMemberships.principalType} = 'agent' then 'agent'
    else 'human'
  end`;
}

function memberFromClause(db: Db) {
  return db
    .select({
      principalId: organizationMemberships.principalId,
      principalType: organizationMemberships.principalType,
      membershipRole: organizationMemberships.membershipRole,
      agentId: agents.id,
      agentName: agents.name,
      agentRole: agents.role,
      agentStatus: agents.status,
      agentMetadata: agents.metadata,
      userId: authUsers.id,
      userName: authUsers.name,
      nickname: operatorProfiles.nickname,
    })
    .from(organizationMemberships)
    .leftJoin(
      agents,
      and(
        eq(organizationMemberships.principalType, "agent"),
        sql`${agents.id}::text = ${organizationMemberships.principalId}`,
        eq(agents.orgId, organizationMemberships.orgId),
      ),
    )
    .leftJoin(
      authUsers,
      and(
        eq(organizationMemberships.principalType, "user"),
        eq(authUsers.id, organizationMemberships.principalId),
      ),
    )
    .leftJoin(operatorProfiles, eq(operatorProfiles.userId, authUsers.id));
}

function memberPredicates(input: OrganizationMemberDirectoryFilters) {
  const predicates = [
    eq(organizationMemberships.orgId, input.orgId),
    eq(organizationMemberships.status, "active"),
    or(
      and(
        eq(organizationMemberships.principalType, "user"),
        not(eq(organizationMemberships.principalId, "local-board")),
        isNotNull(authUsers.id),
      ),
      isVisibleAgentMembership(),
    )!,
  ];
  if (input.type === "human") {
    predicates.push(and(
      eq(organizationMemberships.principalType, "user"),
      not(eq(organizationMemberships.principalId, "local-board")),
      isNotNull(authUsers.id),
    )!);
  }
  if (input.type === "agent") predicates.push(eq(organizationMemberships.principalType, "agent"));
  const query = input.query?.trim();
  if (query) predicates.push(ilike(memberNameExpression(), `%${query}%`));
  return predicates;
}

function cursorPredicate(cursor: MemberCursor) {
  const name = memberNameExpression();
  const type = memberTypeExpression();
  return or(
    sql`${name} > ${cursor.name}`,
    and(sql`${name} = ${cursor.name}`, sql`${type} > ${cursor.type}`),
    and(
      sql`${name} = ${cursor.name}`,
      sql`${type} = ${cursor.type}`,
      sql`${organizationMemberships.principalId} > ${cursor.principalId}`,
    ),
  )!;
}

export function organizationMemberService(db: Db) {
  async function list(input: OrganizationMemberDirectoryFilters): Promise<OrganizationMemberDirectoryPage> {
    const limit = normalizeLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const predicates = memberPredicates(input);
    if (cursor) predicates.push(cursorPredicate(cursor));

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(organizationMemberships)
      .leftJoin(
        agents,
        and(
          eq(organizationMemberships.principalType, "agent"),
          sql`${agents.id}::text = ${organizationMemberships.principalId}`,
          eq(agents.orgId, organizationMemberships.orgId),
        ),
      )
      .leftJoin(
        authUsers,
        and(
          eq(organizationMemberships.principalType, "user"),
          eq(authUsers.id, organizationMemberships.principalId),
        ),
      )
      .leftJoin(operatorProfiles, eq(operatorProfiles.userId, authUsers.id))
      .where(and(...memberPredicates(input)));
    const total = Number(countRows[0]?.count ?? 0);

    const name = memberNameExpression();
    const type = memberTypeExpression();
    const rows = await memberFromClause(db)
      .where(and(...predicates))
      .orderBy(asc(name), asc(type), asc(organizationMemberships.principalId))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => {
      const memberType: OrganizationMemberType = row.principalType === "agent" ? "agent" : "human";
      const nameValue = memberType === "agent"
        ? row.agentName?.trim() || "Agent"
        : row.nickname?.trim() || row.userName?.trim() || "Human";
      const role = memberType === "agent"
        ? row.agentRole?.trim() || "agent"
        : row.membershipRole?.trim() || "member";
      return {
        name: nameValue,
        type: memberType,
        role,
        ref: safeMemberRef(memberType, row.principalId, input.fullIds),
      };
    });
    const last = pageRows.at(-1);
    return {
      total,
      items,
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor({
            name: items.at(-1)?.name ?? "",
            type: items.at(-1)?.type ?? "human",
            principalId: last.principalId,
          })
        : null,
    };
  }

  async function countActiveVisible(orgId: string) {
    const result = await list({ orgId, limit: 1 });
    return result.total;
  }

  return { list, countActiveVisible };
}
