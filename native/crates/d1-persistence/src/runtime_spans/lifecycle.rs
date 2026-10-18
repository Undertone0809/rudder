use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

use super::context::{
    CurrentContextInput, LockedContext, assert_current_lease_tx,
    lock_current_context_allow_sealed_segment,
};
use super::projection::span_and_segment;
use super::validation::{
    Result, canonical_uuid, completeness, http, owner_token,
};

/// Close the exact primary span owned by one Run Attempt.
///
/// The durable owner/epoch fence is checked under the same row locks used by
/// admission and locator binding. A terminal retry returns the original
/// projection without inserting a second activity row.
pub(super) async fn close(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    let super::Request::Close {
        span_id: raw_span_id,
        run_id: raw_run_id,
        attempt_id: raw_attempt_id,
        attempt_epoch,
        owner_token: raw_owner_token,
        completeness: raw_completeness,
    } = request
    else {
        return Err(http(400, "Expected a Run span close request"));
    };
    let span_id = canonical_uuid(raw_span_id, "span id")?;
    let run_id = canonical_uuid(raw_run_id, "run id")?;
    let attempt_id = canonical_uuid(raw_attempt_id, "attempt id")?;
    let owner_token = owner_token(raw_owner_token)?;
    let completeness = completeness(raw_completeness)?;

    let mut tx = pool.begin().await?;
    let context = lock_for_span(
        &mut tx,
        actor,
        organization_id,
        &span_id,
        &run_id,
        &attempt_id,
        *attempt_epoch,
        &owner_token,
    )
    .await?;
    let span = locked_span(&mut tx, organization_id, &span_id).await?;
    ensure_span_fence(&span, &context, &run_id, &attempt_id, *attempt_epoch, &owner_token)?;
    let current_state: String = span.try_get("state")?;
    let current_completeness: String = span.try_get("completeness")?;
    let closed_at: Option<String> = span.try_get("closed_at")?;
    let desired_state = if completeness == "unknown" {
        "unresolved"
    } else {
        "sealed"
    };

    if current_state != "open" || closed_at.is_some() {
        if current_state == desired_state
            && current_completeness == completeness
            && closed_at.is_some()
        {
            let result = span_and_segment(
                &mut tx,
                organization_id,
                &span_id,
                &context.binding_id,
                &context.segment_id,
            )
            .await?;
            tx.commit().await?;
            return Ok(result);
        }
        return Err(http(409, "Run span is already closed with different state"));
    }

    let updated = sqlx::query(
        "UPDATE run_runtime_spans
         SET state=$7, completeness=$8, closed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid
           AND attempt_id=$4::uuid AND attempt_epoch=$5 AND owner_token=$6
           AND state='open' AND closed_at IS NULL",
    )
    .bind(organization_id)
    .bind(&span_id)
    .bind(&run_id)
    .bind(&attempt_id)
    .bind(*attempt_epoch)
    .bind(&owner_token)
    .bind(desired_state)
    .bind(completeness)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(http(409, "Run span owner or lifecycle changed concurrently"));
    }
    assert_current_lease_tx(&mut tx, organization_id, &run_id, &owner_token).await?;

    write_span_activity(
        &mut tx,
        actor,
        organization_id,
        &run_id,
        "runtime.span.closed",
        &span_id,
        json!({
            "spanId": span_id,
            "attemptId": attempt_id,
            "attemptEpoch": attempt_epoch,
            "state": desired_state,
            "completeness": completeness,
        }),
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
    tx.commit().await?;
    Ok(result)
}

pub(super) async fn seal_segment(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    segment_transition(pool, actor, organization_id, request, false).await
}

pub(super) async fn reconcile_segment(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    segment_transition(pool, actor, organization_id, request, true).await
}

async fn segment_transition(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
    reconcile: bool,
) -> Result<Value> {
    let (raw_span_id, raw_run_id, raw_attempt_id, attempt_epoch, raw_owner_token) = match request {
        super::Request::SealSegment {
            span_id,
            run_id,
            attempt_id,
            attempt_epoch,
            owner_token,
        }
        | super::Request::ReconcileSegment {
            span_id,
            run_id,
            attempt_id,
            attempt_epoch,
            owner_token,
        } => (span_id, run_id, attempt_id, attempt_epoch, owner_token),
        _ => return Err(http(400, "Expected a Segment seal request")),
    };
    let span_id = canonical_uuid(raw_span_id, "span id")?;
    let run_id = canonical_uuid(raw_run_id, "run id")?;
    let attempt_id = canonical_uuid(raw_attempt_id, "attempt id")?;
    let owner_token = owner_token(raw_owner_token)?;

    let mut tx = pool.begin().await?;
    let context = lock_for_span(
        &mut tx,
        actor,
        organization_id,
        &span_id,
        &run_id,
        &attempt_id,
        *attempt_epoch,
        &owner_token,
    )
    .await?;
    let span = locked_span(&mut tx, organization_id, &span_id).await?;
    ensure_span_fence(&span, &context, &run_id, &attempt_id, *attempt_epoch, &owner_token)?;
    let span_state: String = span.try_get("state")?;
    let span_closed: Option<String> = span.try_get("closed_at")?;
    if reconcile && (span_state == "open" || span_closed.is_none()) {
        return Err(http(409, "Run span must be closed before Segment reconciliation"));
    }
    if !reconcile && span_state != "open" {
        return Err(http(409, "Run span is not open for Segment sealing"));
    }

    let segment = sqlx::query(
        "SELECT state, sealed_at::text AS sealed_at
         FROM native_segments
         WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(&context.binding_id)
    .bind(&context.segment_id)
    .fetch_one(&mut *tx)
    .await?;
    let segment_state: String = segment.try_get("state")?;
    let segment_sealed_at: Option<String> = segment.try_get("sealed_at")?;
    if segment_state == "sealed" && segment_sealed_at.is_some() {
        let result = span_and_segment(
            &mut tx,
            organization_id,
            &span_id,
            &context.binding_id,
            &context.segment_id,
        )
        .await?;
        tx.commit().await?;
        return Ok(result);
    }
    if segment_state == "superseded" || segment_sealed_at.is_some() {
        return Err(http(409, "Native Segment has already transitioned"));
    }
    if !matches!(segment_state.as_str(), "pending" | "open") {
        return Err(http(409, "Native Segment is not sealable"));
    }

    let updated = sqlx::query(
        "UPDATE native_segments
         SET state='sealed', sealed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid
           AND state IN ('pending','open') AND sealed_at IS NULL",
    )
    .bind(organization_id)
    .bind(&context.binding_id)
    .bind(&context.segment_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(http(409, "Native Segment lifecycle changed concurrently"));
    }
    assert_current_lease_tx(&mut tx, organization_id, &run_id, &owner_token).await?;

    let action = if reconcile {
        "runtime.span.segment_reconciled"
    } else {
        "runtime.span.segment_sealed"
    };
    write_span_activity(
        &mut tx,
        actor,
        organization_id,
        &run_id,
        action,
        &span_id,
        json!({
            "spanId": span_id,
            "segmentId": context.segment_id,
            "attemptId": attempt_id,
            "attemptEpoch": attempt_epoch,
            "state": "sealed",
        }),
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
    tx.commit().await?;
    Ok(result)
}

async fn lock_for_span(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: &VerifiedActor,
    organization_id: &str,
    span_id: &str,
    run_id: &str,
    attempt_id: &str,
    attempt_epoch: i32,
    owner_token: &str,
) -> Result<LockedContext> {
    let hint = sqlx::query(
        "SELECT run_id::text AS run_id, binding_id::text AS binding_id,
                segment_id::text AS segment_id
         FROM run_runtime_spans WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(span_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run span not found"))?;
    let stored_run_id: String = hint.try_get("run_id")?;
    if stored_run_id != run_id {
        return Err(http(409, "Run span does not match the requested Run"));
    }
    let binding_id: String = hint.try_get("binding_id")?;
    let segment_id: String = hint.try_get("segment_id")?;
    lock_current_context_allow_sealed_segment(
        tx,
        actor,
        &CurrentContextInput {
            organization_id,
            run_id,
            attempt_id,
            attempt_epoch,
            owner_token,
            binding_id: &binding_id,
            segment_id: &segment_id,
        },
    )
    .await
}

async fn locked_span(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    organization_id: &str,
    span_id: &str,
) -> Result<sqlx::postgres::PgRow> {
    sqlx::query(
        "SELECT run_id::text AS run_id, binding_id::text AS binding_id,
                segment_id::text AS segment_id, attempt_id::text AS attempt_id,
                attempt_epoch, owner_token, ordinal, relation, state,
                completeness, closed_at::text AS closed_at
         FROM run_runtime_spans
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(span_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run span not found"))
}

fn ensure_span_fence(
    span: &sqlx::postgres::PgRow,
    context: &LockedContext,
    run_id: &str,
    attempt_id: &str,
    attempt_epoch: i32,
    owner_token: &str,
) -> Result<()> {
    let matches = span.try_get::<String, _>("run_id")? == run_id
        && span.try_get::<String, _>("binding_id")? == context.binding_id
        && span.try_get::<String, _>("segment_id")? == context.segment_id
        && span.try_get::<Option<String>, _>("attempt_id")?.as_deref() == Some(attempt_id)
        && span.try_get::<i32, _>("attempt_epoch")? == attempt_epoch
        && span.try_get::<String, _>("owner_token")? == owner_token
        && span.try_get::<i32, _>("ordinal")? == context.attempt_index
        && span.try_get::<String, _>("relation")? == "primary";
    if matches {
        Ok(())
    } else {
        Err(http(409, "Run span does not match the current attempt"))
    }
}

async fn write_span_activity(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: &VerifiedActor,
    organization_id: &str,
    run_id: &str,
    action: &str,
    span_id: &str,
    details: Value,
) -> Result<()> {
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(run_id.to_owned()),
    };
    write_activity_options(
        tx,
        ActivityWrite {
            org: organization_id,
            audit: &audit,
            action,
            entity_type: "run_runtime_span",
            entity_id: span_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: (actor.actor().kind == "agent").then_some(actor.actor().id.as_str()),
                bind_run: false,
                ..Default::default()
            },
        },
    )
    .await?;
    Ok(())
}
