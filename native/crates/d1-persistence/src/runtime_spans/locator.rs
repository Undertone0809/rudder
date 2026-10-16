use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

use super::context::{assert_current_lease_tx, lock_current_context};
use super::projection::span_and_segment;
use super::validation::{
    Result, canonical_uuid, http, opaque_locator, optional_locator, owner_token,
};

pub(super) async fn bind(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    let super::Request::BindLocator {
        span_id: raw_span_id,
        attempt_id: raw_attempt_id,
        attempt_epoch,
        owner_token: raw_owner_token,
        native_session_id: raw_native_session_id,
        root_session_id: raw_root_session_id,
        leaf_id: raw_leaf_id,
    } = request
    else {
        return Err(http(400, "Expected a locator binding request"));
    };
    let span_id = canonical_uuid(raw_span_id, "span id")?;
    let attempt_id = canonical_uuid(raw_attempt_id, "attempt id")?;
    let owner_token = owner_token(raw_owner_token)?;
    let native_session_id = opaque_locator(raw_native_session_id, "native session id")?;
    let root_session_id = optional_locator(raw_root_session_id.as_deref(), "root session id")?;
    let leaf_id = optional_locator(raw_leaf_id.as_deref(), "leaf id")?;

    let mut tx = pool.begin().await?;
    // Read the identifiers needed for the common lock order without locking the
    // span first. Both operations then lock Conversation -> Run -> attempt ->
    // binding/segment -> span, avoiding lifecycle lock-order cycles.
    let hint = sqlx::query(
        "SELECT run_id::text AS run_id, binding_id::text AS binding_id,
                segment_id::text AS segment_id
         FROM run_runtime_spans WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(&span_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run span not found"))?;
    let run_id: String = hint.try_get("run_id")?;
    let binding_id: String = hint.try_get("binding_id")?;
    let segment_id: String = hint.try_get("segment_id")?;

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

    let span = sqlx::query(
        "SELECT run_id::text AS run_id, binding_id::text AS binding_id,
                segment_id::text AS segment_id, attempt_id::text AS attempt_id,
                attempt_epoch, owner_token, ordinal, relation, state,
                (closed_at IS NULL) AS is_open
         FROM run_runtime_spans WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(organization_id)
    .bind(&span_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run span not found"))?;

    let matches_current = span.try_get::<String, _>("run_id")? == context.run_id
        && span.try_get::<String, _>("binding_id")? == context.binding_id
        && span.try_get::<String, _>("segment_id")? == context.segment_id
        && span.try_get::<Option<String>, _>("attempt_id")?.as_deref()
            == Some(context.attempt_id.as_str())
        && span.try_get::<i32, _>("attempt_epoch")? == context.attempt_epoch
        && span.try_get::<String, _>("owner_token")? == context.owner_token
        && span.try_get::<i32, _>("ordinal")? == context.attempt_index
        && span.try_get::<String, _>("relation")? == "primary"
        && span.try_get::<String, _>("state")? == "open"
        && span.try_get::<bool, _>("is_open")?;
    if !matches_current {
        return Err(http(409, "Run span does not match the current attempt"));
    }

    let stored_locator = (
        context.native_session_id.as_deref(),
        context.root_session_id.as_deref(),
        context.leaf_id.as_deref(),
    );
    let requested_locator = (
        Some(native_session_id.as_str()),
        root_session_id.as_deref(),
        leaf_id.as_deref(),
    );
    if stored_locator == requested_locator {
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
    if stored_locator != (None, None, None) {
        return Err(http(409, "Native session locator is already bound"));
    }

    let updated = sqlx::query(
        "UPDATE native_segments
         SET native_session_id=$4, root_session_id=$5, leaf_id=$6,
             state='open', updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid
           AND native_session_id IS NULL AND root_session_id IS NULL AND leaf_id IS NULL
           AND state IN ('pending','open')",
    )
    .bind(organization_id)
    .bind(&context.binding_id)
    .bind(&context.segment_id)
    .bind(&native_session_id)
    .bind(&root_session_id)
    .bind(&leaf_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(http(409, "Native segment locator changed concurrently"));
    }

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
        "attemptEpoch": context.attempt_epoch
    });
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: organization_id,
            audit: &audit,
            action: "runtime.span.locator_bound",
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
