//! Exact catalog proofs for the two shipped non-idempotent history gaps.
//!
//! This module never executes migration SQL. A journal row is repairable only
//! when the current manifest identity is pinned and every catalog effect is
//! still present with its expected shape.

use rudder_migration_core::MigrationEntry;
use sqlx::{PgConnection, Row};
use std::collections::HashMap;

const REPAIRABLE_MIGRATIONS: &[(&str, &str)] = &[
    (
        "0021_chief_vindicator.sql",
        "1278c77d7de2ad85c4d740092bfd97b1fedb7848bec5a09fc0f72443ffae3daa",
    ),
    (
        "0031_zippy_magma.sql",
        "f1af3a309420879d2a98783650b6389a5b1569b5d21beb053780b26c92de3a13",
    ),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Proof {
    Verified,
    Rejected(&'static str),
}

pub(super) fn is_pinned(entry: &MigrationEntry) -> bool {
    REPAIRABLE_MIGRATIONS
        .iter()
        .any(|(file_name, sha256)| entry.file_name == *file_name && entry.sha256 == *sha256)
}

pub(super) async fn verify(
    connection: &mut PgConnection,
    entry: &MigrationEntry,
) -> Result<Proof, sqlx::Error> {
    if !is_pinned(entry) {
        return Ok(Proof::Rejected(
            "migration source is not pinned for catalog repair",
        ));
    }
    match entry.file_name.as_str() {
        "0021_chief_vindicator.sql" => verify_0021(connection).await,
        "0031_zippy_magma.sql" => verify_0031(connection).await,
        _ => Ok(Proof::Rejected(
            "migration source is not supported for catalog repair",
        )),
    }
}

async fn verify_0021(connection: &mut PgConnection) -> Result<Proof, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT udt_schema, udt_name, domain_name, is_nullable, column_default,
               is_identity, is_generated
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'issues'
          AND column_name = 'assignee_agent_runtime_overrides'
        "#,
    )
    .fetch_optional(&mut *connection)
    .await?;
    let Some(row) = row else {
        return Ok(Proof::Rejected("0021 target column is missing"));
    };
    let udt_schema: String = row.try_get("udt_schema")?;
    let udt_name: String = row.try_get("udt_name")?;
    let domain_name: Option<String> = row.try_get("domain_name")?;
    let is_nullable: String = row.try_get("is_nullable")?;
    let column_default: Option<String> = row.try_get("column_default")?;
    let is_identity: String = row.try_get("is_identity")?;
    let is_generated: String = row.try_get("is_generated")?;
    if udt_schema != "pg_catalog"
        || udt_name != "jsonb"
        || domain_name.is_some()
        || is_nullable != "YES"
        || column_default.is_some()
        || is_identity != "NO"
        || is_generated != "NEVER"
    {
        return Ok(Proof::Rejected(
            "0021 target column has an incompatible definition",
        ));
    }
    let legacy_alias_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'issues'
            AND column_name = 'assignee_adapter_overrides'
        )
        "#,
    )
    .fetch_one(&mut *connection)
    .await?;
    if legacy_alias_exists {
        return Ok(Proof::Rejected(
            "0021 legacy alias remains after normalization",
        ));
    }
    Ok(Proof::Verified)
}

#[derive(Clone, Copy)]
struct ColumnSpec {
    table: &'static str,
    name: &'static str,
    udt_name: &'static str,
    nullable: bool,
    default: Option<&'static str>,
}

const FINANCE_COLUMNS: &[ColumnSpec] = &[
    ColumnSpec {
        table: "finance_events",
        name: "id",
        udt_name: "uuid",
        nullable: false,
        default: Some("gen_random_uuid()"),
    },
    ColumnSpec {
        table: "finance_events",
        name: "agent_id",
        udt_name: "uuid",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "issue_id",
        udt_name: "uuid",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "project_id",
        udt_name: "uuid",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "goal_id",
        udt_name: "uuid",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "heartbeat_run_id",
        udt_name: "uuid",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "cost_event_id",
        udt_name: "uuid",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "billing_code",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "description",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "event_kind",
        udt_name: "text",
        nullable: false,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "direction",
        udt_name: "text",
        nullable: false,
        default: Some("'debit'::text"),
    },
    ColumnSpec {
        table: "finance_events",
        name: "biller",
        udt_name: "text",
        nullable: false,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "provider",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "execution_agent_runtime_type",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "pricing_tier",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "region",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "model",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "quantity",
        udt_name: "int4",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "unit",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "amount_cents",
        udt_name: "int4",
        nullable: false,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "currency",
        udt_name: "text",
        nullable: false,
        default: Some("'USD'::text"),
    },
    ColumnSpec {
        table: "finance_events",
        name: "estimated",
        udt_name: "bool",
        nullable: false,
        default: Some("false"),
    },
    ColumnSpec {
        table: "finance_events",
        name: "external_invoice_id",
        udt_name: "text",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "metadata_json",
        udt_name: "jsonb",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "occurred_at",
        udt_name: "timestamptz",
        nullable: false,
        default: None,
    },
    ColumnSpec {
        table: "finance_events",
        name: "created_at",
        udt_name: "timestamptz",
        nullable: false,
        default: Some("now()"),
    },
    ColumnSpec {
        table: "cost_events",
        name: "heartbeat_run_id",
        udt_name: "uuid",
        nullable: true,
        default: None,
    },
    ColumnSpec {
        table: "cost_events",
        name: "biller",
        udt_name: "text",
        nullable: false,
        default: Some("'unknown'::text"),
    },
    ColumnSpec {
        table: "cost_events",
        name: "billing_type",
        udt_name: "text",
        nullable: false,
        default: Some("'unknown'::text"),
    },
    ColumnSpec {
        table: "cost_events",
        name: "cached_input_tokens",
        udt_name: "int4",
        nullable: false,
        default: Some("0"),
    },
];

async fn verify_0031(connection: &mut PgConnection) -> Result<Proof, sqlx::Error> {
    let shape = query_columns(connection).await?;
    let has_company_id = shape
        .contains_key(&("finance_events".to_owned(), "company_id".to_owned()))
        && shape.contains_key(&("cost_events".to_owned(), "company_id".to_owned()));
    let has_org_id = shape.contains_key(&("finance_events".to_owned(), "org_id".to_owned()))
        && shape.contains_key(&("cost_events".to_owned(), "org_id".to_owned()));
    let (tenant_column, referenced_tenant_table) = match (has_company_id, has_org_id) {
        (true, false) => ("company_id", "companies"),
        (false, true) => ("org_id", "organizations"),
        _ => {
            return Ok(Proof::Rejected(
                "0031 tenant-column rename state is inconsistent",
            ));
        }
    };

    for spec in FINANCE_COLUMNS {
        if !column_matches(&shape, spec) {
            return Ok(Proof::Rejected(
                "0031 required column definition is missing or incompatible",
            ));
        }
    }
    let tenant_spec = ColumnSpec {
        table: "finance_events",
        name: tenant_column,
        udt_name: "uuid",
        nullable: false,
        default: None,
    };
    if !column_matches(&shape, &tenant_spec) {
        return Ok(Proof::Rejected(
            "0031 tenant column definition is incompatible",
        ));
    }
    for spec in [
        ColumnSpec {
            table: "cost_events",
            name: tenant_column,
            udt_name: "uuid",
            nullable: false,
            default: None,
        },
        ColumnSpec {
            table: "cost_events",
            name: "provider",
            udt_name: "text",
            nullable: false,
            default: None,
        },
        ColumnSpec {
            table: "cost_events",
            name: "occurred_at",
            udt_name: "timestamptz",
            nullable: false,
            default: None,
        },
    ] {
        if !column_matches(&shape, &spec) {
            return Ok(Proof::Rejected(
                "0031 indexed cost-event column is incompatible",
            ));
        }
    }
    let other_tenant_column = if tenant_column == "company_id" {
        "org_id"
    } else {
        "company_id"
    };
    if shape.contains_key(&("finance_events".to_owned(), other_tenant_column.to_owned()))
        || shape.contains_key(&("cost_events".to_owned(), other_tenant_column.to_owned()))
    {
        return Ok(Proof::Rejected("0031 has conflicting tenant-column names"));
    }
    if !has_primary_key(connection).await? {
        return Ok(Proof::Rejected(
            "0031 finance_events primary key is missing or incompatible",
        ));
    }
    if !foreign_keys_match(connection, tenant_column, referenced_tenant_table).await? {
        return Ok(Proof::Rejected(
            "0031 required foreign-key definitions are missing or incompatible",
        ));
    }
    if !indexes_match(connection, tenant_column).await? {
        return Ok(Proof::Rejected(
            "0031 required index definitions are missing or incompatible",
        ));
    }
    Ok(Proof::Verified)
}

type ColumnMap = HashMap<
    (String, String),
    (
        String,
        String,
        Option<String>,
        bool,
        Option<String>,
        String,
        String,
    ),
>;

async fn query_columns(connection: &mut PgConnection) -> Result<ColumnMap, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        SELECT table_name, column_name, udt_schema, udt_name, domain_name,
               is_nullable, column_default, is_identity, is_generated
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('finance_events', 'cost_events')
        "#,
    )
    .fetch_all(&mut *connection)
    .await?;
    rows.into_iter()
        .map(|row| {
            let table: String = row.try_get("table_name")?;
            let column: String = row.try_get("column_name")?;
            let udt_schema: String = row.try_get("udt_schema")?;
            let udt: String = row.try_get("udt_name")?;
            let domain_name: Option<String> = row.try_get("domain_name")?;
            let nullable: String = row.try_get("is_nullable")?;
            let default: Option<String> = row.try_get("column_default")?;
            let identity: String = row.try_get("is_identity")?;
            let generated: String = row.try_get("is_generated")?;
            Ok((
                (table, column),
                (
                    udt_schema,
                    udt,
                    domain_name,
                    nullable == "YES",
                    default,
                    identity,
                    generated,
                ),
            ))
        })
        .collect()
}

fn column_matches(columns: &ColumnMap, spec: &ColumnSpec) -> bool {
    let Some((udt_schema, udt, domain_name, nullable, default, identity, generated)) =
        columns.get(&(spec.table.to_owned(), spec.name.to_owned()))
    else {
        return false;
    };
    udt_schema == "pg_catalog"
        && udt == spec.udt_name
        && domain_name.is_none()
        && *nullable == spec.nullable
        && default.as_deref() == spec.default
        && identity == "NO"
        && generated == "NEVER"
}

async fn has_primary_key(connection: &mut PgConnection) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT c.contype::text AS contype, c.convalidated, c.condeferrable,
               c.condeferred, i.indisunique, i.indisprimary,
               array_agg(a.attname::text ORDER BY key.ordinality) AS columns
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_index i ON i.indexrelid = c.conindid
        JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
        JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
        WHERE n.nspname = 'public' AND t.relname = 'finance_events'
          AND c.conname = 'finance_events_pkey'
        GROUP BY c.oid, i.indisunique, i.indisprimary
        "#,
    )
    .fetch_optional(&mut *connection)
    .await?;
    let Some(row) = row else { return Ok(false) };
    let constraint_type: String = row.try_get("contype")?;
    let validated: bool = row.try_get("convalidated")?;
    let deferrable: bool = row.try_get("condeferrable")?;
    let deferred: bool = row.try_get("condeferred")?;
    let unique: bool = row.try_get("indisunique")?;
    let primary: bool = row.try_get("indisprimary")?;
    let columns: Vec<String> = row.try_get("columns")?;
    Ok(constraint_type == "p"
        && validated
        && !deferrable
        && !deferred
        && unique
        && primary
        && columns == ["id"])
}

#[derive(Debug)]
struct ForeignKeyShape {
    constraint_type: String,
    validated: bool,
    deferrable: bool,
    deferred: bool,
    match_type: String,
    delete_action: String,
    update_action: String,
    source_table: String,
    source_schema: String,
    source_column: String,
    source_type_is_uuid: bool,
    target_table: String,
    target_schema: String,
    target_column: String,
    target_type_is_uuid: bool,
    source_column_count: i32,
    target_column_count: i32,
}

async fn foreign_keys_match(
    connection: &mut PgConnection,
    tenant_column: &str,
    tenant_table: &str,
) -> Result<bool, sqlx::Error> {
    let specs = [
        (
            "finance_events_company_id_companies_id_fk",
            "finance_events",
            tenant_column,
            tenant_table,
        ),
        (
            "finance_events_agent_id_agents_id_fk",
            "finance_events",
            "agent_id",
            "agents",
        ),
        (
            "finance_events_issue_id_issues_id_fk",
            "finance_events",
            "issue_id",
            "issues",
        ),
        (
            "finance_events_project_id_projects_id_fk",
            "finance_events",
            "project_id",
            "projects",
        ),
        (
            "finance_events_goal_id_goals_id_fk",
            "finance_events",
            "goal_id",
            "goals",
        ),
        (
            "finance_events_heartbeat_run_id_heartbeat_runs_id_fk",
            "finance_events",
            "heartbeat_run_id",
            "heartbeat_runs",
        ),
        (
            "finance_events_cost_event_id_cost_events_id_fk",
            "finance_events",
            "cost_event_id",
            "cost_events",
        ),
        (
            "cost_events_heartbeat_run_id_heartbeat_runs_id_fk",
            "cost_events",
            "heartbeat_run_id",
            "heartbeat_runs",
        ),
    ];
    let names = specs.iter().map(|spec| spec.0).collect::<Vec<_>>();
    let rows = sqlx::query(
        r#"
        SELECT c.conname::text AS conname, c.contype::text AS contype, c.convalidated, c.condeferrable, c.condeferred,
               c.confmatchtype::text AS confmatchtype,
               c.confdeltype::text AS confdeltype, c.confupdtype::text AS confupdtype,
               array_length(c.conkey, 1)::integer AS source_column_count,
               array_length(c.confkey, 1)::integer AS target_column_count,
               src.relname::text AS source_table, sn.nspname::text AS source_schema,
               sa.attname::text AS source_column,
               (sa.atttypid = 'pg_catalog.uuid'::regtype) AS source_type_is_uuid,
               dst.relname::text AS target_table, dn.nspname::text AS target_schema,
               da.attname::text AS target_column,
               (da.atttypid = 'pg_catalog.uuid'::regtype) AS target_type_is_uuid
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class src ON src.oid = c.conrelid
        JOIN pg_catalog.pg_namespace sn ON sn.oid = src.relnamespace
        JOIN pg_catalog.pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = c.conkey[1]
        JOIN pg_catalog.pg_class dst ON dst.oid = c.confrelid
        JOIN pg_catalog.pg_namespace dn ON dn.oid = dst.relnamespace
        JOIN pg_catalog.pg_attribute da ON da.attrelid = dst.oid AND da.attnum = c.confkey[1]
        WHERE c.conname = ANY($1)
        "#,
    )
    .bind(&names)
    .fetch_all(&mut *connection)
    .await?;
    if rows.len() != specs.len() {
        return Ok(false);
    }
    let actual = rows
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("conname")?,
                ForeignKeyShape {
                    constraint_type: row.try_get("contype")?,
                    validated: row.try_get("convalidated")?,
                    deferrable: row.try_get("condeferrable")?,
                    deferred: row.try_get("condeferred")?,
                    match_type: row.try_get("confmatchtype")?,
                    delete_action: row.try_get("confdeltype")?,
                    update_action: row.try_get("confupdtype")?,
                    source_table: row.try_get("source_table")?,
                    source_schema: row.try_get("source_schema")?,
                    source_column: row.try_get("source_column")?,
                    source_type_is_uuid: row.try_get("source_type_is_uuid")?,
                    target_table: row.try_get("target_table")?,
                    target_schema: row.try_get("target_schema")?,
                    target_column: row.try_get("target_column")?,
                    target_type_is_uuid: row.try_get("target_type_is_uuid")?,
                    source_column_count: row.try_get("source_column_count")?,
                    target_column_count: row.try_get("target_column_count")?,
                },
            ))
        })
        .collect::<Result<HashMap<_, _>, sqlx::Error>>()?;
    Ok(specs
        .iter()
        .all(|(name, source_table, source_column, target_table)| {
            actual.get(*name).is_some_and(|row| {
                row.constraint_type == "f"
                    && row.validated
                    && !row.deferrable
                    && !row.deferred
                    && row.match_type == "s"
                    && row.delete_action == "a"
                    && row.update_action == "a"
                    && row.source_table == *source_table
                    && row.source_schema == "public"
                    && row.source_column == *source_column
                    && row.source_type_is_uuid
                    && row.target_table == *target_table
                    && row.target_schema == "public"
                    && row.target_column == "id"
                    && row.target_type_is_uuid
                    && row.source_column_count == 1
                    && row.target_column_count == 1
            })
        }))
}

async fn indexes_match(
    connection: &mut PgConnection,
    tenant_column: &str,
) -> Result<bool, sqlx::Error> {
    let specs: [(&str, &str, &[&str]); 9] = [
        (
            "finance_events_company_occurred_idx",
            "finance_events",
            &[tenant_column, "occurred_at"],
        ),
        (
            "finance_events_company_biller_occurred_idx",
            "finance_events",
            &[tenant_column, "biller", "occurred_at"],
        ),
        (
            "finance_events_company_kind_occurred_idx",
            "finance_events",
            &[tenant_column, "event_kind", "occurred_at"],
        ),
        (
            "finance_events_company_direction_occurred_idx",
            "finance_events",
            &[tenant_column, "direction", "occurred_at"],
        ),
        (
            "finance_events_company_heartbeat_run_idx",
            "finance_events",
            &[tenant_column, "heartbeat_run_id"],
        ),
        (
            "finance_events_company_cost_event_idx",
            "finance_events",
            &[tenant_column, "cost_event_id"],
        ),
        (
            "cost_events_company_provider_occurred_idx",
            "cost_events",
            &[tenant_column, "provider", "occurred_at"],
        ),
        (
            "cost_events_company_biller_occurred_idx",
            "cost_events",
            &[tenant_column, "biller", "occurred_at"],
        ),
        (
            "cost_events_company_heartbeat_run_idx",
            "cost_events",
            &[tenant_column, "heartbeat_run_id"],
        ),
    ];
    let names = specs.iter().map(|spec| spec.0).collect::<Vec<_>>();
    let rows = sqlx::query(
        r#"
        SELECT idx.relname::text AS index_name, tbl.relname::text AS table_name,
               am.amname::text AS access_method, i.indisvalid, i.indisready, i.indislive,
               i.indisunique, i.indisprimary, i.indisexclusion,
               i.indnatts, i.indnkeyatts,
               i.indpred IS NULL AS no_predicate,
               i.indexprs IS NULL AS no_expressions,
               ARRAY(
                 SELECT a.attname::text
                 FROM LATERAL unnest(i.indkey) WITH ORDINALITY AS index_key(attnum, ordinality)
                 JOIN pg_catalog.pg_attribute a
                   ON a.attrelid = tbl.oid AND a.attnum = index_key.attnum
                 WHERE index_key.ordinality <= i.indnkeyatts
                 ORDER BY index_key.ordinality
               ) AS columns,
               ARRAY(
                 SELECT sort_option::smallint
                 FROM LATERAL unnest(i.indoption) WITH ORDINALITY AS index_option(sort_option, ordinality)
                 WHERE index_option.ordinality <= i.indnkeyatts
                 ORDER BY index_option.ordinality
               ) AS sort_options,
               ARRAY(
                 SELECT opc.opcdefault AND opns.nspname = 'pg_catalog'
                        AND opc.opcintype = a.atttypid
                 FROM LATERAL unnest(i.indclass) WITH ORDINALITY AS index_opclass(opclass_oid, ordinality)
                 JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS index_key(attnum, ordinality)
                   USING (ordinality)
                 JOIN pg_catalog.pg_opclass opc ON opc.oid = index_opclass.opclass_oid
                 JOIN pg_catalog.pg_namespace opns ON opns.oid = opc.opcnamespace
                 JOIN pg_catalog.pg_attribute a
                   ON a.attrelid = tbl.oid AND a.attnum = index_key.attnum
                 WHERE index_opclass.ordinality <= i.indnkeyatts
                 ORDER BY index_opclass.ordinality
               ) AS default_opclasses,
               ARRAY(
                 SELECT index_collation.collation_oid = a.attcollation
                 FROM LATERAL unnest(i.indkey) WITH ORDINALITY AS index_key(attnum, ordinality)
                 JOIN LATERAL unnest(i.indcollation) WITH ORDINALITY AS index_collation(collation_oid, ordinality)
                   USING (ordinality)
                 JOIN pg_catalog.pg_attribute a
                   ON a.attrelid = tbl.oid AND a.attnum = index_key.attnum
                 WHERE index_key.ordinality <= i.indnkeyatts
                 ORDER BY index_key.ordinality
               ) AS column_collations_match
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = idx.relnamespace
        JOIN pg_catalog.pg_am am ON am.oid = idx.relam
        WHERE ns.nspname = 'public' AND idx.relname = ANY($1)
        "#,
    )
    .bind(&names)
    .fetch_all(&mut *connection)
    .await?;
    if rows.len() != specs.len() {
        return Ok(false);
    }
    let actual = rows
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("index_name")?,
                IndexShape {
                    table_name: row.try_get("table_name")?,
                    access_method: row.try_get("access_method")?,
                    valid: row.try_get("indisvalid")?,
                    ready: row.try_get("indisready")?,
                    live: row.try_get("indislive")?,
                    unique: row.try_get("indisunique")?,
                    primary: row.try_get("indisprimary")?,
                    exclusion: row.try_get("indisexclusion")?,
                    attribute_count: row.try_get("indnatts")?,
                    key_count: row.try_get("indnkeyatts")?,
                    no_predicate: row.try_get("no_predicate")?,
                    no_expressions: row.try_get("no_expressions")?,
                    columns: row.try_get("columns")?,
                    sort_options: row.try_get("sort_options")?,
                    default_opclasses: row.try_get("default_opclasses")?,
                    column_collations_match: row.try_get("column_collations_match")?,
                },
            ))
        })
        .collect::<Result<HashMap<_, _>, sqlx::Error>>()?;
    Ok(specs.iter().all(|(name, table, expected_columns)| {
        actual.get(*name).is_some_and(|row| {
            row.table_name == *table
                && row.access_method == "btree"
                && row.valid
                && row.ready
                && row.live
                && !row.unique
                && !row.primary
                && !row.exclusion
                && row.attribute_count as usize == expected_columns.len()
                && row.key_count as usize == expected_columns.len()
                && row.no_predicate
                && row.no_expressions
                && row
                    .columns
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice()
                    == *expected_columns
                && row.sort_options.len() == expected_columns.len()
                && row.sort_options.iter().all(|option| *option == 0)
                && row.default_opclasses.len() == expected_columns.len()
                && row.default_opclasses.iter().all(|is_default| *is_default)
                && row.column_collations_match.len() == expected_columns.len()
                && row.column_collations_match.iter().all(|matches| *matches)
        })
    }))
}

#[derive(Debug)]
struct IndexShape {
    table_name: String,
    access_method: String,
    valid: bool,
    ready: bool,
    live: bool,
    unique: bool,
    primary: bool,
    exclusion: bool,
    attribute_count: i16,
    key_count: i16,
    no_predicate: bool,
    no_expressions: bool,
    columns: Vec<String>,
    sort_options: Vec<i16>,
    default_opclasses: Vec<bool>,
    column_collations_match: Vec<bool>,
}
