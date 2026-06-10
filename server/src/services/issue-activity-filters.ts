import { sql } from "drizzle-orm";
import {
  ISSUE_UPDATE_ACTIVITY_METADATA_KEYS,
  LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELDS,
} from "@rudderhq/shared";

const LOW_SIGNAL_ISSUE_UPDATE_ALLOWED_KEYS = [
  ...LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELDS,
  ...ISSUE_UPDATE_ACTIVITY_METADATA_KEYS,
] as const;

export function issueLowSignalContentOnlyActivitySql(alias: string) {
  const lowSignalFieldPresent = sql.join(
    LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELDS.map((key) => sql`${sql.raw(`${alias}.details`)} ? ${key}`),
    sql` or `,
  );
  return sql<boolean>`(
    ${sql.raw(`${alias}.action`)} = 'issue.updated'
    and jsonb_typeof(${sql.raw(`${alias}.details`)}) = 'object'
    and (${lowSignalFieldPresent})
    and not exists (
      select 1
      from jsonb_object_keys(${sql.raw(`${alias}.details`)}) as detail_key(key)
      where detail_key.key not in (${sql.join(LOW_SIGNAL_ISSUE_UPDATE_ALLOWED_KEYS.map((key) => sql`${key}`), sql`, `)})
    )
  )`;
}

export function issueMaterialUpdateActivitySql(alias: string) {
  return sql<boolean>`(
    ${sql.raw(`${alias}.action`)} = 'issue.updated'
    and jsonb_typeof(${sql.raw(`${alias}.details`)}) = 'object'
    and exists (
      select 1
      from jsonb_object_keys(${sql.raw(`${alias}.details`)}) as detail_key(key)
      where detail_key.key not in (${sql.join(LOW_SIGNAL_ISSUE_UPDATE_ALLOWED_KEYS.map((key) => sql`${key}`), sql`, `)})
    )
  )`;
}
