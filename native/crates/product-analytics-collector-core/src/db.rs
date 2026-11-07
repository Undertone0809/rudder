use crate::{
    CollectorConfig, CollectorError, MigrationConfig,
    contract::{
        AckErrorCode, Authorization, AuthorizationMode, BatchResponse, EventAck, ValidatedEvent,
        accepted, batch_size, duplicate, event_ids, rejected, validate_event,
    },
};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions};
use std::{collections::BTreeSet, time::Duration};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const SCHEMA: &str = "rudder_analytics";
const RAW_EVENTS: &str = "rudder_analytics.product_analytics_collector_events";
const INSTALLATIONS: &str = "rudder_analytics.product_analytics_collector_installations";
const SUBJECTS: &str = "rudder_analytics.product_analytics_collector_subjects";
const QUALITY: &str = "rudder_analytics.product_analytics_collector_quality_counters";
const DAILY_ROLLUPS: &str = "rudder_analytics.product_analytics_collector_daily_rollups";
const PRIVACY_AGGREGATES: &str = "rudder_analytics.product_analytics_collector_privacy_aggregates";
const WORK_LOOP_REVISIONS: &str =
    "rudder_analytics.product_analytics_collector_work_loop_revisions";
const MIGRATION_HISTORY: &str = "rudder_analytics._product_analytics_migrations";
const EXPIRE_EVENTS_FUNCTION: &str =
    "rudder_analytics.expire_product_analytics_raw_events(timestamptz)";
const ERASE_INSTALLATION_FUNCTION: &str =
    "rudder_analytics.erase_product_analytics_installation(text)";
const ERASE_SUBJECT_FUNCTION: &str = "rudder_analytics.erase_product_analytics_subject(text)";

#[derive(Clone)]
pub struct CollectorPools {
    pub ingest: PgPool,
    pub maintenance: PgPool,
    pub reader: PgPool,
}

impl CollectorPools {
    pub async fn connect(config: &CollectorConfig) -> Result<Self, CollectorError> {
        let ingest = connect_pool(&config.database_url, 8).await?;
        let maintenance = connect_pool(&config.maintenance_database_url, 4).await?;
        let reader = connect_pool(&config.report_database_url, 4).await?;
        if let Err(error) = assert_role_boundary(
            &ingest,
            config.expected_database_role.as_deref(),
            RoleBoundary::Collector,
        )
        .await
        {
            close_pools(&ingest, &maintenance, &reader).await;
            return Err(error);
        }
        if let Err(error) = assert_role_boundary(
            &maintenance,
            config.maintenance_database_role.as_deref(),
            RoleBoundary::Rollup,
        )
        .await
        {
            close_pools(&ingest, &maintenance, &reader).await;
            return Err(error);
        }
        if let Err(error) = assert_role_boundary(
            &reader,
            config.report_database_role.as_deref(),
            RoleBoundary::Reader,
        )
        .await
        {
            close_pools(&ingest, &maintenance, &reader).await;
            return Err(error);
        }
        Ok(Self {
            ingest,
            maintenance,
            reader,
        })
    }

    pub async fn close(&self) {
        self.ingest.close().await;
        self.maintenance.close().await;
        self.reader.close().await;
    }
}

#[derive(Clone, Copy)]
enum RoleBoundary {
    Collector,
    Rollup,
    Reader,
}

async fn connect_pool(url: &str, max_connections: u32) -> Result<PgPool, CollectorError> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect(url)
        .await
        .map_err(CollectorError::Database)
}

async fn close_pools(ingest: &PgPool, maintenance: &PgPool, reader: &PgPool) {
    ingest.close().await;
    maintenance.close().await;
    reader.close().await;
}

async fn assert_role_boundary(
    pool: &PgPool,
    expected_role: Option<&str>,
    boundary: RoleBoundary,
) -> Result<(), CollectorError> {
    let current_user: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(pool)
        .await?;
    if expected_role.is_some_and(|expected| expected != current_user) {
        return Err(CollectorError::Configuration(
            "product_analytics_database_role_mismatch".into(),
        ));
    }
    let schema_exists: bool =
        sqlx::query_scalar("SELECT has_schema_privilege(current_user, $1, 'USAGE')")
            .bind(SCHEMA)
            .fetch_one(pool)
            .await?;
    if !schema_exists {
        return Err(CollectorError::Configuration(
            "product_analytics_schema_usage_denied".into(),
        ));
    }
    let has_create: bool =
        sqlx::query_scalar("SELECT has_schema_privilege(current_user, $1, 'CREATE')")
            .bind(SCHEMA)
            .fetch_one(pool)
            .await?;
    if has_create {
        return Err(CollectorError::Configuration(
            "product_analytics_schema_create_denied".into(),
        ));
    }
    assert_table_privilege_profile(pool, boundary).await?;
    assert_function_privilege_profile(pool, boundary).await?;
    assert_no_role_memberships(pool).await?;
    Ok(())
}

async fn assert_table_privilege_profile(
    pool: &PgPool,
    boundary: RoleBoundary,
) -> Result<(), CollectorError> {
    const TABLES: &[&str] = &[
        RAW_EVENTS,
        INSTALLATIONS,
        SUBJECTS,
        QUALITY,
        DAILY_ROLLUPS,
        PRIVACY_AGGREGATES,
        WORK_LOOP_REVISIONS,
        MIGRATION_HISTORY,
    ];
    const PRIVILEGES: &[&str] = &[
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
    ];

    let rows = sqlx::query(
        "SELECT n.nspname || '.' || c.relname AS relation_name, p.privilege FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) AS p(privilege) WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,p.privilege)",
    )
    .bind(SCHEMA)
    .fetch_all(pool)
    .await?;
    let actual = rows
        .iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("relation_name")?,
                row.try_get::<String, _>("privilege")?,
            ))
        })
        .collect::<Result<BTreeSet<_>, sqlx::Error>>()?;

    let has_table_grant_option: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) AS p(privilege) WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,p.privilege || ' WITH GRANT OPTION'))",
    )
    .bind(SCHEMA)
    .fetch_one(pool)
    .await?;
    if has_table_grant_option {
        return Err(CollectorError::Configuration(
            "product_analytics_database_privilege_denied".into(),
        ));
    }

    let has_column_grant_option: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND a.attacl IS NOT NULL AND acl.is_grantable AND acl.privilege_type IN ('SELECT','INSERT','UPDATE','REFERENCES') AND CASE WHEN acl.grantee=0 THEN true ELSE pg_has_role((SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user),acl.grantee,'USAGE') END)",
    )
    .bind(SCHEMA)
    .fetch_one(pool)
    .await?;
    if has_column_grant_option {
        return Err(CollectorError::Configuration(
            "product_analytics_database_privilege_denied".into(),
        ));
    }

    let has_partial_column_privileges: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']::text[]) AS p(privilege) WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND has_column_privilege(current_user,c.oid,a.attnum,p.privilege) AND NOT has_table_privilege(current_user,c.oid,p.privilege))",
    )
    .bind(SCHEMA)
    .fetch_one(pool)
    .await?;
    if has_partial_column_privileges {
        return Err(CollectorError::Configuration(
            "product_analytics_database_privilege_denied".into(),
        ));
    }

    let mut expected = BTreeSet::new();
    for table in TABLES {
        for privilege in PRIVILEGES {
            if table_privilege_allowed(boundary, table, privilege) {
                expected.insert(((*table).to_owned(), (*privilege).to_owned()));
            }
        }
    }
    if actual != expected {
        return Err(CollectorError::Configuration(
            "product_analytics_database_privilege_denied".into(),
        ));
    }
    Ok(())
}

fn table_privilege_allowed(boundary: RoleBoundary, table: &str, privilege: &str) -> bool {
    matches!(
        (boundary, table, privilege),
        (RoleBoundary::Collector, RAW_EVENTS, "SELECT" | "INSERT")
            | (
                RoleBoundary::Collector,
                INSTALLATIONS | SUBJECTS | QUALITY,
                "SELECT" | "INSERT" | "UPDATE",
            )
            | (
                RoleBoundary::Rollup,
                RAW_EVENTS | INSTALLATIONS | QUALITY,
                "SELECT"
            )
            | (RoleBoundary::Rollup, QUALITY, "DELETE")
            | (
                RoleBoundary::Rollup,
                DAILY_ROLLUPS | PRIVACY_AGGREGATES | WORK_LOOP_REVISIONS,
                "SELECT" | "INSERT" | "UPDATE" | "DELETE",
            )
            | (
                RoleBoundary::Reader,
                DAILY_ROLLUPS | PRIVACY_AGGREGATES | QUALITY,
                "SELECT"
            )
    )
}

async fn assert_function_privilege_profile(
    pool: &PgPool,
    boundary: RoleBoundary,
) -> Result<(), CollectorError> {
    let has_security_definer_grant_option: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN ('f','p') AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION'))",
    )
    .bind(SCHEMA)
    .fetch_one(pool)
    .await?;
    if has_security_definer_grant_option {
        return Err(CollectorError::Configuration(
            "product_analytics_database_privilege_denied".into(),
        ));
    }

    let rows = sqlx::query(
        "SELECT p.proname AS function_name, pg_catalog.oidvectortypes(p.proargtypes) AS argument_types FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind IN ('f','p') AND has_function_privilege(current_user,p.oid,'EXECUTE')",
    )
    .bind(SCHEMA)
    .fetch_all(pool)
    .await?;
    let actual = rows
        .iter()
        .map(|row| {
            Ok((
                row.try_get::<String, _>("function_name")?,
                row.try_get::<String, _>("argument_types")?,
            ))
        })
        .collect::<Result<BTreeSet<_>, sqlx::Error>>()?;
    let expected = if matches!(boundary, RoleBoundary::Collector) {
        BTreeSet::from([
            (
                "expire_product_analytics_raw_events".to_owned(),
                "timestamp with time zone".to_owned(),
            ),
            (
                "erase_product_analytics_installation".to_owned(),
                "text".to_owned(),
            ),
            (
                "erase_product_analytics_subject".to_owned(),
                "text".to_owned(),
            ),
        ])
    } else {
        BTreeSet::new()
    };
    if actual != expected {
        return Err(CollectorError::Configuration(
            "product_analytics_database_privilege_denied".into(),
        ));
    }
    Ok(())
}

async fn assert_no_role_memberships(pool: &PgPool) -> Result<(), CollectorError> {
    let has_membership: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))",
    )
    .fetch_one(pool)
    .await?;
    if has_membership {
        return Err(CollectorError::Configuration(
            "product_analytics_database_role_membership_denied".into(),
        ));
    }
    Ok(())
}

pub async fn ingest_batch(
    pool: &PgPool,
    authorization: &Authorization,
    events: &[Value],
    now: OffsetDateTime,
) -> Result<BatchResponse, CollectorError> {
    let _database_consent_epoch = database_integer_epoch(authorization.consent_epoch)?;
    let received_at = format_time(now)?;
    if events.len() > crate::contract::MAX_BATCH_EVENTS
        || batch_size(events)? > crate::contract::MAX_BATCH_BYTES
    {
        record_quality(pool, now, 0, 0, 1, 0).await?;
        return Ok(BatchResponse {
            accepted: 0,
            duplicate: 0,
            rejected: vec![rejected("batch", AckErrorCode::TooLarge, false)],
            received_at,
        });
    }
    let mut validated = Vec::with_capacity(events.len());
    let mut acks = Vec::new();
    for value in events {
        match validate_event(value, now) {
            Ok(event) => {
                if authorization
                    .pseudonymous_installation_id
                    .as_deref()
                    .is_some_and(|expected| expected != event.pseudonymous_installation_id)
                {
                    acks.push(rejected(
                        &event.event_id,
                        AckErrorCode::InvalidEvent,
                        event.late,
                    ));
                } else {
                    validated.push(event);
                }
            }
            Err(ack) => acks.push(ack),
        }
    }
    let mut tx = pool.begin().await?;
    let state = read_consent_state(&mut tx, authorization).await?;
    if !state_matches(authorization, state.as_ref()) {
        for value in events {
            let event_id = value
                .get("eventId")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if !acks.iter().any(|ack| ack.event_id == event_id) {
                acks.push(rejected(event_id, AckErrorCode::Revoked, false));
            }
        }
        let rejected_count = acks.len() as i32;
        record_quality_tx(&mut tx, now, 0, 0, rejected_count, 0).await?;
        tx.commit().await?;
        return Ok(BatchResponse {
            accepted: 0,
            duplicate: 0,
            rejected: acks,
            received_at,
        });
    }
    let mut accepted_count = 0_usize;
    let mut duplicate_count = 0_usize;
    let mut late_count = 0_i32;
    for event in validated {
        let ack = insert_or_dedupe(&mut tx, authorization, &event, now).await?;
        if ack.status == crate::contract::AckStatus::Accepted {
            accepted_count += 1;
        }
        if ack.status == crate::contract::AckStatus::Duplicate {
            duplicate_count += 1;
        }
        if ack.late {
            late_count += 1;
        }
        acks.push(ack);
    }
    let rejected_count = acks
        .iter()
        .filter(|ack| ack.status == crate::contract::AckStatus::Rejected)
        .count() as i32;
    record_quality_tx(
        &mut tx,
        now,
        accepted_count as i32,
        duplicate_count as i32,
        rejected_count,
        late_count,
    )
    .await?;
    tx.commit().await?;
    Ok(BatchResponse {
        accepted: accepted_count,
        duplicate: duplicate_count,
        rejected: acks
            .into_iter()
            .filter(|ack| ack.status == crate::contract::AckStatus::Rejected)
            .collect(),
        received_at,
    })
}

pub async fn reject_invalid_schema_batch(
    pool: &PgPool,
    now: OffsetDateTime,
) -> Result<BatchResponse, CollectorError> {
    record_quality(pool, now, 0, 0, 1, 0).await?;
    Ok(BatchResponse {
        accepted: 0,
        duplicate: 0,
        rejected: vec![rejected("batch", AckErrorCode::InvalidSchema, false)],
        received_at: format_time(now)?,
    })
}

#[derive(Clone, Debug)]
pub struct ConsentState {
    pub consent_version: String,
    pub consent_epoch: u64,
    pub revoked: bool,
}

pub async fn advance_consent(
    pool: &PgPool,
    installation_id: &str,
    analytics_subject: Option<&str>,
    consent_version: &str,
    consent_epoch: u64,
    revoked: bool,
) -> Result<ConsentState, CollectorError> {
    if installation_id.is_empty()
        || installation_id.len() > 256
        || consent_version.is_empty()
        || consent_version.len() > 80
        || consent_epoch < 1
        || consent_epoch > i32::MAX as u64
    {
        return Err(CollectorError::InvalidRequest("invalid_consent_state"));
    }
    let mut tx = pool.begin().await?;
    let revoked_at = if revoked { "now()" } else { "NULL" };
    if let Some(subject) = analytics_subject {
        if subject.len() != 64 || !subject.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CollectorError::InvalidRequest("invalid_analytics_subject"));
        }
        sqlx::query(&format!(
            "INSERT INTO {INSTALLATIONS} (installation_id, mode, consent_version, consent_epoch, analytics_subject, revoked, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'account_linked', $2, 0, NULL, true, now(), now(), now()) ON CONFLICT (installation_id) DO NOTHING"
        ))
        .bind(installation_id)
        .bind(consent_version)
        .execute(&mut *tx)
        .await?;
        sqlx::query(&format!(
            "INSERT INTO {SUBJECTS} (installation_id, analytics_subject, consent_version, consent_epoch, consented_at, revoked_at, updated_at) VALUES ($1, $2, $3, $4, now(), {revoked_at}, now()) ON CONFLICT (installation_id, analytics_subject) DO UPDATE SET consent_version = EXCLUDED.consent_version, consent_epoch = EXCLUDED.consent_epoch, revoked_at = EXCLUDED.revoked_at, updated_at = now() WHERE {SUBJECTS}.consent_epoch < EXCLUDED.consent_epoch"
        )).bind(installation_id).bind(subject).bind(consent_version).bind(consent_epoch as i32).execute(&mut *tx).await?;
        let row = sqlx::query(&format!("SELECT consent_version, consent_epoch, revoked_at IS NOT NULL AS revoked FROM {SUBJECTS} WHERE installation_id=$1 AND analytics_subject=$2"))
            .bind(installation_id).bind(subject).fetch_one(&mut *tx).await?;
        let state = ConsentState {
            consent_version: row.try_get("consent_version")?,
            consent_epoch: row.try_get::<i32, _>("consent_epoch")? as u64,
            revoked: row.try_get("revoked")?,
        };
        tx.commit().await?;
        return Ok(state);
    }
    sqlx::query(&format!(
        "INSERT INTO {INSTALLATIONS} (installation_id, mode, consent_version, consent_epoch, analytics_subject, revoked, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'anonymous', $2, $3, NULL, $4, now(), now(), now()) ON CONFLICT (installation_id) DO UPDATE SET consent_version = EXCLUDED.consent_version, consent_epoch = EXCLUDED.consent_epoch, revoked = EXCLUDED.revoked, updated_at = now() WHERE {INSTALLATIONS}.consent_epoch < EXCLUDED.consent_epoch"
    )).bind(installation_id).bind(consent_version).bind(consent_epoch as i32).bind(revoked).execute(&mut *tx).await?;
    let row = sqlx::query(&format!("SELECT consent_version, consent_epoch, revoked FROM {INSTALLATIONS} WHERE installation_id=$1"))
        .bind(installation_id).fetch_one(&mut *tx).await?;
    let state = ConsentState {
        consent_version: row.try_get("consent_version")?,
        consent_epoch: row.try_get::<i32, _>("consent_epoch")? as u64,
        revoked: row.try_get("revoked")?,
    };
    tx.commit().await?;
    Ok(state)
}

async fn read_consent_state(
    tx: &mut Transaction<'_, Postgres>,
    authorization: &Authorization,
) -> Result<Option<ConsentState>, CollectorError> {
    if authorization.mode == AuthorizationMode::AccountLinked {
        let Some(subject) = authorization.analytics_subject.as_deref() else {
            return Ok(None);
        };
        let row = sqlx::query(&format!("SELECT consent_version, consent_epoch, revoked_at IS NOT NULL AS revoked FROM {SUBJECTS} WHERE installation_id=$1 AND analytics_subject=$2 FOR UPDATE"))
            .bind(&authorization.installation_id).bind(subject).fetch_optional(&mut **tx).await?;
        return row
            .map(|row| {
                Ok(ConsentState {
                    consent_version: row.try_get("consent_version")?,
                    consent_epoch: row.try_get::<i32, _>("consent_epoch")? as u64,
                    revoked: row.try_get("revoked")?,
                })
            })
            .transpose();
    }
    let row = sqlx::query(&format!("SELECT consent_version, consent_epoch, revoked FROM {INSTALLATIONS} WHERE installation_id=$1 FOR UPDATE"))
        .bind(&authorization.installation_id).fetch_optional(&mut **tx).await?;
    row.map(|row| {
        Ok(ConsentState {
            consent_version: row.try_get("consent_version")?,
            consent_epoch: row.try_get::<i32, _>("consent_epoch")? as u64,
            revoked: row.try_get("revoked")?,
        })
    })
    .transpose()
}

fn state_matches(authorization: &Authorization, state: Option<&ConsentState>) -> bool {
    state.is_some_and(|state| {
        !state.revoked
            && state.consent_epoch == authorization.consent_epoch
            && state.consent_version == authorization.consent_version
    })
}

async fn insert_or_dedupe(
    tx: &mut Transaction<'_, Postgres>,
    authorization: &Authorization,
    event: &ValidatedEvent,
    now: OffsetDateTime,
) -> Result<EventAck, CollectorError> {
    let properties = serde_json::to_string(&Value::Object(event.properties.clone()))
        .map_err(|error| CollectorError::Internal(error.to_string()))?;
    let occurred_at = event.occurred_at_raw.as_str();
    let effective_at = if event.late {
        format_time(now)?
    } else {
        occurred_at.to_owned()
    };
    let inserted = sqlx::query(&format!(
        "INSERT INTO {RAW_EVENTS} (event_id, installation_id, analytics_subject, event_name, schema_version, occurred_at, received_at, effective_at, environment, app_version, release_channel, deployment_mode, coarse_platform, actor_kind, origin, is_internal, pseudonymous_installation_id, pseudonymous_org_id, pseudonymous_work_id, pseudonymous_work_cycle_id, pseudonymous_root_run_id, pseudonymous_run_id, completion_revision, properties, confidence, is_backfill, late, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, $3, $4, 1, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8, $9, $10, $11, NULL, $12, $13, false, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24, $25, $26, $27) ON CONFLICT (event_id) DO NOTHING RETURNING event_id"
    ))
        .bind(&event.event_id).bind(&authorization.installation_id).bind(if authorization.mode == AuthorizationMode::AccountLinked { authorization.analytics_subject.as_deref() } else { None })
        .bind(&event.event_name).bind(occurred_at).bind(format_time(now)?).bind(effective_at).bind(&event.environment).bind(&event.app_version).bind(&event.release_channel).bind(&event.deployment_mode).bind(&event.actor_kind).bind(&event.origin).bind(&event.pseudonymous_installation_id).bind(&event.pseudonymous_org_id).bind(&event.pseudonymous_work_id).bind(&event.pseudonymous_work_cycle_id).bind(&event.pseudonymous_root_run_id).bind(&event.pseudonymous_run_id).bind(event.completion_revision).bind(properties).bind(&event.confidence).bind(event.is_backfill).bind(event.late).bind(&authorization.consent_version).bind(database_integer_epoch(authorization.consent_epoch)?).bind(&event.payload_sha256)
        .fetch_optional(&mut **tx).await?;
    if inserted.is_some() {
        if event.environment == "production" {
            sqlx::query(&format!(
                "UPDATE {INSTALLATIONS} SET first_observed_event_at = LEAST(COALESCE(first_observed_event_at, $2::timestamptz), $2::timestamptz) WHERE installation_id = $1"
            ))
            .bind(&authorization.installation_id)
            .bind(occurred_at)
            .execute(&mut **tx)
            .await?;
        }
        return Ok(accepted(&event.event_id, event.late));
    }
    let payload_sha256: String = sqlx::query_scalar(&format!(
        "SELECT payload_sha256 FROM {RAW_EVENTS} WHERE event_id=$1::uuid"
    ))
    .bind(&event.event_id)
    .fetch_one(&mut **tx)
    .await?;
    if payload_sha256 == event.payload_sha256 {
        Ok(duplicate(&event.event_id, event.late))
    } else {
        Ok(rejected(
            &event.event_id,
            AckErrorCode::Conflict,
            event.late,
        ))
    }
}

async fn record_quality(
    pool: &PgPool,
    now: OffsetDateTime,
    accepted: i32,
    duplicate: i32,
    rejected: i32,
    late: i32,
) -> Result<(), CollectorError> {
    let mut tx = pool.begin().await?;
    record_quality_tx(&mut tx, now, accepted, duplicate, rejected, late).await?;
    tx.commit().await?;
    Ok(())
}

async fn record_quality_tx(
    tx: &mut Transaction<'_, Postgres>,
    now: OffsetDateTime,
    accepted: i32,
    duplicate: i32,
    rejected: i32,
    late: i32,
) -> Result<(), CollectorError> {
    let day = now.date().to_string();
    sqlx::query(&format!(
        "INSERT INTO {QUALITY} (day, received_batches, accepted_events, duplicate_events, rejected_events, late_events, updated_at) VALUES ($1::date, 1, $2, $3, $4, $5, $6::timestamptz) ON CONFLICT (day) DO UPDATE SET received_batches={QUALITY}.received_batches + 1, accepted_events={QUALITY}.accepted_events + EXCLUDED.accepted_events, duplicate_events={QUALITY}.duplicate_events + EXCLUDED.duplicate_events, rejected_events={QUALITY}.rejected_events + EXCLUDED.rejected_events, late_events={QUALITY}.late_events + EXCLUDED.late_events, updated_at=EXCLUDED.updated_at"
    )).bind(day).bind(accepted).bind(duplicate).bind(rejected).bind(late).bind(format_time(now)?).execute(&mut **tx).await?;
    Ok(())
}

pub async fn delete_installation(
    pool: &PgPool,
    installation_id: &str,
) -> Result<(), CollectorError> {
    sqlx::query("SELECT rudder_analytics.erase_product_analytics_installation($1)")
        .bind(installation_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_subject(pool: &PgPool, analytics_subject: &str) -> Result<(), CollectorError> {
    sqlx::query("SELECT rudder_analytics.erase_product_analytics_subject($1)")
        .bind(analytics_subject)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn migrate(config: &MigrationConfig) -> Result<(), CollectorError> {
    let pool = connect_pool(&config.database_url, 1).await?;
    let current: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(&pool)
        .await?;
    if current != config.expected_role {
        pool.close().await;
        return Err(CollectorError::Configuration(
            "product_analytics_migration_role_mismatch".into(),
        ));
    }
    sqlx::query("CREATE SCHEMA IF NOT EXISTS rudder_analytics")
        .execute(&pool)
        .await?;
    assert_migration_ownership(&pool, &config.expected_role).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS rudder_analytics._product_analytics_migrations (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())").execute(&pool).await?;
    for (tag, content) in MIGRATIONS {
        let applied: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM rudder_analytics._product_analytics_migrations WHERE tag=$1)").bind(*tag).fetch_one(&pool).await?;
        if applied {
            continue;
        }
        let mut tx = pool.begin().await?;
        for statement in content
            .split("--> statement-breakpoint")
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
        {
            sqlx::query(statement)
                .execute(&mut *tx)
                .await
                .map_err(|error| CollectorError::Migration(format!("{tag}: {error}")))?;
        }
        sqlx::query("INSERT INTO rudder_analytics._product_analytics_migrations (tag) VALUES ($1)")
            .bind(*tag)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    assert_migration_ownership(&pool, &config.expected_role).await?;
    grant_roles(
        &pool,
        &config.collector_role,
        &config.rollup_role,
        &config.reader_role,
    )
    .await?;
    pool.close().await;
    Ok(())
}

async fn assert_migration_ownership(
    pool: &PgPool,
    expected_role: &str,
) -> Result<(), CollectorError> {
    let ownership_mismatch: bool = sqlx::query_scalar(
        "SELECT n.nspowner <> r.oid OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND c.relowner <> r.oid) OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace=n.oid AND p.proowner <> r.oid) OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.typnamespace=n.oid AND t.typowner <> r.oid) FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.rolname=$1 WHERE n.nspname='rudder_analytics'",
    )
    .bind(expected_role)
    .fetch_one(pool)
    .await?;
    if ownership_mismatch {
        return Err(CollectorError::Configuration(
            "product_analytics_migration_object_owner_mismatch".into(),
        ));
    }
    Ok(())
}

async fn grant_roles(
    pool: &PgPool,
    collector: &str,
    rollup: &str,
    reader: &str,
) -> Result<(), CollectorError> {
    for role in [collector, rollup, reader] {
        if !valid_identifier(role) {
            return Err(CollectorError::Configuration(
                "invalid_product_analytics_role_name".into(),
            ));
        }
    }
    let sql = format!(
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA rudder_analytics FROM \"{collector}\", \"{rollup}\", \"{reader}\"; \
         REVOKE ALL ON FUNCTION {EXPIRE_EVENTS_FUNCTION}, {ERASE_INSTALLATION_FUNCTION}, {ERASE_SUBJECT_FUNCTION} FROM \"{collector}\", \"{rollup}\", \"{reader}\"; \
         GRANT USAGE ON SCHEMA rudder_analytics TO \"{collector}\", \"{rollup}\", \"{reader}\"; \
         GRANT SELECT, INSERT ON {RAW_EVENTS} TO \"{collector}\"; \
         GRANT SELECT, INSERT, UPDATE ON {INSTALLATIONS}, {SUBJECTS}, {QUALITY} TO \"{collector}\"; \
         GRANT SELECT ON {RAW_EVENTS}, {INSTALLATIONS} TO \"{rollup}\"; \
         GRANT SELECT, INSERT, UPDATE, DELETE ON {DAILY_ROLLUPS}, {PRIVACY_AGGREGATES}, {WORK_LOOP_REVISIONS} TO \"{rollup}\"; \
         GRANT SELECT, DELETE ON {QUALITY} TO \"{rollup}\"; \
         GRANT EXECUTE ON FUNCTION {EXPIRE_EVENTS_FUNCTION}, {ERASE_INSTALLATION_FUNCTION}, {ERASE_SUBJECT_FUNCTION} TO \"{collector}\"; \
         GRANT SELECT ON {DAILY_ROLLUPS}, {PRIVACY_AGGREGATES}, {QUALITY} TO \"{reader}\"; \
         REVOKE ALL ON rudder_analytics._product_analytics_migrations FROM \"{collector}\", \"{rollup}\", \"{reader}\";"
    );
    sqlx::raw_sql(&sql).execute(pool).await?;
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && !value.as_bytes()[0].is_ascii_digit()
}

fn database_integer_epoch(value: u64) -> Result<i32, CollectorError> {
    i32::try_from(value).map_err(|_| CollectorError::InvalidRequest("consent_epoch_out_of_range"))
}

fn format_time(value: OffsetDateTime) -> Result<String, CollectorError> {
    value
        .format(&Rfc3339)
        .map_err(|error| CollectorError::Internal(error.to_string()))
}

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0140_faulty_kitty_pryde.sql",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/db/src/migrations/0140_faulty_kitty_pryde.sql"
        )),
    ),
    (
        "0141_product_analytics_revision_origin.sql",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/db/src/migrations/0141_product_analytics_revision_origin.sql"
        )),
    ),
    (
        "0142_product_analytics_quality_counters.sql",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/db/src/migrations/0142_product_analytics_quality_counters.sql"
        )),
    ),
    (
        "rust_product_analytics_collector_role_capabilities.sql",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/migrations/rust_product_analytics_collector_role_capabilities.sql"
        )),
    ),
    // This column is SQLx-owned; the TypeScript schema is metadata only. Do not add a duplicate Drizzle migration.
    (
        "rust_product_analytics_collector_first_observed_event.sql",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/migrations/rust_product_analytics_collector_first_observed_event.sql"
        )),
    ),
];

#[allow(dead_code)]
fn _event_ids(events: &[Value]) -> Vec<String> {
    event_ids(events)
}
