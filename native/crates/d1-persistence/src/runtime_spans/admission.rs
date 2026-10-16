use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

use super::context::{assert_current_lease_tx, lock_current_context};
use super::projection::span_and_segment;
use super::validation::{Result, canonical_uuid, http, owner_token};

pub(super) async fn open(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    let super::Request::Open {
        run_id,
        attempt_id,
        attempt_epoch,
        owner_token: raw_owner_token,
        binding_id,
        segment_id,
    } = request
    else {
        return Err(http(400, "Expected an open Run span request"));
    };
    let run_id = canonical_uuid(run_id, "run id")?;
    let attempt_id = canonical_uuid(attempt_id, "attempt id")?;
    let binding_id = canonical_uuid(binding_id, "binding id")?;
    let segment_id = canonical_uuid(segment_id, "segment id")?;
    let owner_token = owner_token(raw_owner_token)?;

    let mut tx = pool.begin().await?;
    let context = lock_current_context(
        &mut tx,
        actor,
        &super::context::CurrentContextInput {
            organization_id,
            run_id: &run_id,
            attempt_id: &attempt_id,
            attempt_epoch: *attempt_epoch,
            owner_token: &owner_token,
            binding_id: &binding_id,
            segment_id: &segment_id,
        },
    )
    .await?;

    let existing = sqlx::query(
        "SELECT id::text AS id, attempt_id::text AS attempt_id, attempt_ref,
                attempt_epoch, owner_token, binding_id::text AS binding_id,
                segment_id::text AS segment_id, ordinal, relation, state,
                (closed_at IS NULL) AS is_open
         FROM run_runtime_spans
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND ordinal=$3
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(&context.run_id)
    .bind(context.attempt_index)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(existing) = existing {
        let span_id: String = existing.try_get("id")?;
        let matches = existing
            .try_get::<Option<String>, _>("attempt_id")?
            .as_deref()
            == Some(context.attempt_id.as_str())
            && existing.try_get::<String, _>("attempt_ref")? == context.attempt_id
            && existing.try_get::<i32, _>("attempt_epoch")? == context.attempt_epoch
            && existing.try_get::<String, _>("owner_token")? == context.owner_token
            && existing.try_get::<String, _>("binding_id")? == context.binding_id
            && existing.try_get::<String, _>("segment_id")? == context.segment_id
            && existing.try_get::<i32, _>("ordinal")? == context.attempt_index
            && existing.try_get::<String, _>("relation")? == "primary"
            && existing.try_get::<String, _>("state")? == "open"
            && existing.try_get::<bool, _>("is_open")?;
        if !matches {
            return Err(http(409, "Run span conflicts with the current attempt"));
        }
        let result = span_and_segment(
            &mut tx,
            organization_id,
            &span_id,
            &context.binding_id,
            &context.segment_id,
        )
        .await?;
        assert_current_lease_tx(
            &mut tx,
            organization_id,
            &context.run_id,
            &context.owner_token,
        )
        .await?;
        tx.commit().await?;
        return Ok(result);
    }

    let span_id: String = sqlx::query_scalar(
        "INSERT INTO run_runtime_spans
           (org_id, run_id, binding_id, segment_id, attempt_id, attempt_ref,
            attempt_epoch, owner_token, ordinal, relation, state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
                 $7, $8, $9, 'primary', 'open')
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(&context.run_id)
    .bind(&context.binding_id)
    .bind(&context.segment_id)
    .bind(&context.attempt_id)
    .bind(&context.attempt_id)
    .bind(context.attempt_epoch)
    .bind(&context.owner_token)
    .bind(context.attempt_index)
    .fetch_one(&mut *tx)
    .await?;

    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(context.run_id.clone()),
    };
    let details = json!({
        "spanId": span_id,
        "bindingId": context.binding_id,
        "segmentId": context.segment_id,
        "attemptEpoch": context.attempt_epoch,
        "ordinal": context.attempt_index
    });
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: organization_id,
            audit: &audit,
            action: "runtime.span.opened",
            entity_type: "run_runtime_span",
            entity_id: &span_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: (actor.actor().kind == "agent").then_some(actor.actor().id.as_str()),
                bind_run: false,
                ..Default::default()
            },
        },
    )
    .await?;

    let result = span_and_segment(
        &mut tx,
        organization_id,
        &span_id,
        &context.binding_id,
        &context.segment_id,
    )
    .await?;
    assert_current_lease_tx(
        &mut tx,
        organization_id,
        &context.run_id,
        &context.owner_token,
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}
