//! Transactional product-analytics event recording shared by Rust writers.
//!
//! Keep the local event ledger authoritative and apply the same installation,
//! consent, and bounded-outbox rules used by the existing Node writer.

use crate::StoreError;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

pub(crate) struct ProductAnalyticsEvent<'a> {
    pub org_id: Option<&'a str>,
    pub event_name: &'a str,
    pub occurred_at: Option<&'a str>,
    pub source_transition: &'a str,
    pub confidence: &'a str,
    pub actor_type: &'a str,
    pub actor_id: Option<&'a str>,
    pub entity_type: Option<&'a str>,
    pub entity_id: Option<&'a str>,
    pub work_surface: Option<&'a str>,
    pub work_id: Option<&'a str>,
    pub work_cycle_id: Option<&'a str>,
    pub root_run_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub completion_revision: Option<i32>,
    pub origin: &'a str,
    pub dedupe_key: &'a str,
    pub properties: &'a Value,
}

/// Record one event and apply the existing consent-gated upload outbox policy.
/// A duplicate dedupe key returns `None` and does not create another outbox row.
pub(crate) async fn write_product_analytics_event(
    tx: &mut Transaction<'_, Postgres>,
    event: ProductAnalyticsEvent<'_>,
) -> Result<Option<String>, StoreError> {
    let installation_id = sqlx::query_scalar::<_, String>(
        "SELECT installation_id
         FROM product_analytics_installations
         ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let environment = if std::env::var("NODE_ENV").is_ok_and(|value| value == "production") {
        "production"
    } else {
        "development"
    };
    let local_user_id = if event.actor_type == "human" {
        event.actor_id
    } else {
        None
    };

    let event_id = sqlx::query_scalar::<_, String>(
        "INSERT INTO product_analytics_events
           (org_id,installation_id,event_name,schema_version,occurred_at,source_transition,
            confidence,actor_type,actor_id,local_user_id,environment,app_version,release_channel,
            deployment_mode,origin,work_surface,work_id,work_cycle_id,root_run_id,run_id,
            completion_revision,entity_type,entity_id,dedupe_key,properties,is_backfill)
         VALUES ($1::uuid,$2,$3,1,COALESCE($4::timestamptz,clock_timestamp()),$5,
            $6,$7,$8,$9,$10,'unknown','stable','self_hosted',$11,$12,$13,$14,
            $15::uuid,$16::uuid,$17,$18,$19,$20,$21::jsonb,false)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text",
    )
    .bind(event.org_id)
    .bind(installation_id.as_deref())
    .bind(event.event_name)
    .bind(event.occurred_at)
    .bind(event.source_transition)
    .bind(event.confidence)
    .bind(event.actor_type)
    .bind(event.actor_id)
    .bind(local_user_id)
    .bind(environment)
    .bind(event.origin)
    .bind(event.work_surface)
    .bind(event.work_id.or(event.entity_id))
    .bind(event.work_cycle_id)
    .bind(event.root_run_id)
    .bind(event.run_id)
    .bind(event.completion_revision)
    .bind(event.entity_type)
    .bind(event.entity_id)
    .bind(event.dedupe_key)
    .bind(event.properties.to_string())
    .fetch_optional(&mut **tx)
    .await?;

    let Some(event_id) = event_id else {
        return Ok(None);
    };
    if let Some(work_cycle_id) = event.work_cycle_id {
        match event.event_name {
            "output_ready" => {
                sqlx::query(
                    "UPDATE product_analytics_work_cycles
                     SET output_ready_at=COALESCE($3::timestamptz,clock_timestamp()),
                         updated_at=clock_timestamp()
                     WHERE org_id=$1::uuid AND work_cycle_id=$2",
                )
                .bind(event.org_id)
                .bind(work_cycle_id)
                .bind(event.occurred_at)
                .execute(&mut **tx)
                .await?;
            }
            "review_decision_recorded" => {
                let decision = event.properties.get("decision").and_then(Value::as_str);
                sqlx::query(
                    "UPDATE product_analytics_work_cycles
                     SET review_decision=$3,updated_at=clock_timestamp()
                     WHERE org_id=$1::uuid AND work_cycle_id=$2",
                )
                .bind(event.org_id)
                .bind(work_cycle_id)
                .bind(decision)
                .execute(&mut **tx)
                .await?;
            }
            _ => {}
        }
    }
    let Some(installation_id) = installation_id else {
        return Ok(Some(event_id));
    };
    let installation = sqlx::query(
        "SELECT mode,state FROM product_analytics_installations WHERE installation_id=$1",
    )
    .bind(&installation_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(installation) = installation else {
        return Ok(Some(event_id));
    };
    let mode: String = installation.try_get("mode")?;
    let mut state: Value = installation.try_get("state")?;
    if environment != "production" || mode == "off" {
        return Ok(Some(event_id));
    }

    let scope = if mode == "account_linked" {
        "account_linked_user"
    } else {
        "anonymous_installation"
    };
    let consent_user_id = (scope == "account_linked_user")
        .then_some(local_user_id)
        .flatten();
    let backlog = sqlx::query(
        "SELECT count(*)::bigint AS count,
                COALESCE(sum(length(events.properties::text)),0)::bigint AS bytes
         FROM product_analytics_outbox outbox
         JOIN product_analytics_events events ON events.id=outbox.event_id
         WHERE outbox.installation_id=$1
           AND outbox.state IN ('pending','claimed','retry_wait')",
    )
    .bind(&installation_id)
    .fetch_one(&mut **tx)
    .await?;
    let backlog_count: i64 = backlog.try_get("count")?;
    let backlog_bytes: i64 = backlog.try_get("bytes")?;
    if backlog_count >= 10_000 || backlog_bytes >= 32 * 1024 * 1024 {
        if !state.is_object() {
            state = json!({});
        }
        state["coverageGap"] = json!(true);
        sqlx::query(
            "UPDATE product_analytics_installations
             SET state=$2::jsonb,updated_at=clock_timestamp()
             WHERE installation_id=$1",
        )
        .bind(&installation_id)
        .bind(state.to_string())
        .execute(&mut **tx)
        .await?;
        return Ok(Some(event_id));
    }

    let consent = sqlx::query(
        "SELECT policy_version,consent_epoch
         FROM product_analytics_consent_ledger
         WHERE installation_id=$1 AND scope=$2 AND decision='granted'
           AND local_user_id IS NOT DISTINCT FROM $3
         ORDER BY consent_epoch DESC LIMIT 1",
    )
    .bind(&installation_id)
    .bind(scope)
    .bind(consent_user_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(consent) = consent {
        sqlx::query(
            "INSERT INTO product_analytics_outbox
               (event_id,installation_id,delivery_mode,consent_scope,consented_local_user_id,
                consent_version,consent_epoch)
             VALUES ($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        )
        .bind(&event_id)
        .bind(&installation_id)
        .bind(&mode)
        .bind(scope)
        .bind(consent_user_id)
        .bind(consent.try_get::<String, _>("policy_version")?)
        .bind(consent.try_get::<i32, _>("consent_epoch")?)
        .execute(&mut **tx)
        .await?;
    }

    Ok(Some(event_id))
}
