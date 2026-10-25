//! Publicly authorized cancellation intent for native Goal Runs.
//!
//! The lookup is read-only so the public ingress can keep legacy Run requests
//! on the existing proxy path without consuming their request body. Once a
//! native Goal Run is selected, authorization and the cleanup-gated stop
//! request are applied together in a D1 transaction.

use crate::{
    activity::{self, ActivityActor, ActivityOptions, ActivityWrite},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_runs,
};
use serde_json::json;
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeGoalRunCancelTarget {
    pub organization_id: String,
    pub run_id: String,
}

#[derive(Debug, Error)]
pub enum NativeGoalRunCancelError {
    #[error("Run not found")]
    NotFound,
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Forbidden")]
    Forbidden,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Select an unambiguous native Goal Run without altering or reading the HTTP
/// body. A legacy, missing, invalid, or ambiguous reference remains eligible
/// for the original Node route.
pub async fn resolve_native_goal_run_cancel_target(
    pool: &PgPool,
    reference: &str,
    scoped_authorizer: Option<&dyn NativeAgentAuthorizer>,
    side_chat_owner_id: Option<&str>,
) -> Result<Option<NativeGoalRunCancelTarget>, sqlx::Error> {
    let reference = reference.trim();
    let parsed_uuid = Uuid::parse_str(reference).ok();
    let is_uuid = parsed_uuid.is_some();
    let (query, value) = if let Some(id) = parsed_uuid {
        (
            "SELECT r.org_id::text AS organization_id,r.id::text AS run_id,
                    r.execution_authority,r.scene,r.target_type,r.goal_id::text AS goal_id
             FROM heartbeat_runs r WHERE r.id=$1::uuid",
            id.to_string(),
        )
    } else if let Some(prefix) = run_id_prefix(reference) {
        (
            "SELECT r.org_id::text AS organization_id,r.id::text AS run_id,
                    r.execution_authority,r.scene,r.target_type,r.goal_id::text AS goal_id
             FROM heartbeat_runs r
             WHERE replace(r.id::text,'-','') LIKE $1 || '%'",
            prefix,
        )
    } else {
        return Ok(None);
    };

    let rows = if is_uuid {
        // Preserve the legacy exact-UUID behavior: resolve globally, then let
        // the transactional authorizer return the existing cross-org 403.
        sqlx::query(query).bind(value).fetch_all(pool).await?
    } else if let Some(authorizer) = scoped_authorizer {
        // Node applies both its organization scope and the caller-specific
        // side-chat visibility predicate before deciding whether a short
        // reference is unique. Apply side-chat visibility in SQL before
        // collecting candidates, then apply the existing Rust authorization
        // predicate per distinct org. Limiting globally first would hide an
        // in-scope visible match behind foreign or private rows.
        let mut tx = pool.begin().await?;
        let visible_query = format!(
            "{query} AND {} ORDER BY r.created_at DESC,r.id DESC",
            crate::run_visibility::predicate("r", 2)
        );
        let candidates = sqlx::query(&visible_query)
            .bind(value)
            .bind(side_chat_owner_id)
            .fetch_all(&mut *tx)
            .await?;
        let mut org_access = HashMap::<String, bool>::new();
        let mut scoped = Vec::new();
        for row in candidates {
            let organization_id: String = row.try_get("organization_id")?;
            let allowed = if let Some(allowed) = org_access.get(&organization_id) {
                *allowed
            } else {
                let allowed = matches!(
                    authorizer.revalidate(&mut tx, &organization_id).await?,
                    NativeAgentAccess::Authorized
                );
                org_access.insert(organization_id, allowed);
                allowed
            };
            if allowed {
                scoped.push(row);
            }
        }
        tx.commit().await?;
        scoped
    } else {
        // When Rust cannot resolve an identity, retain the old fail-closed
        // classification for one globally unique native target. Ambiguous
        // short references stay on the legacy auth/resolution path.
        if is_uuid {
            sqlx::query(query).bind(value).fetch_all(pool).await?
        } else {
            sqlx::query(
                "SELECT r.org_id::text AS organization_id,r.id::text AS run_id,
                        r.execution_authority,r.scene,r.target_type,r.goal_id::text AS goal_id
                 FROM heartbeat_runs r WHERE replace(r.id::text,'-','') LIKE $1 || '%'
                 ORDER BY r.created_at DESC,r.id DESC LIMIT 2",
            )
            .bind(value)
            .fetch_all(pool)
            .await?
        }
    };
    if rows.len() != 1 {
        return Ok(None);
    }
    let row = &rows[0];
    let is_goal_run = row.try_get::<String, _>("execution_authority")? == "native_rust"
        && row.try_get::<String, _>("scene")? == "heartbeat"
        && row.try_get::<String, _>("target_type")? == "wakeup_request"
        && row.try_get::<Option<String>, _>("goal_id")?.is_some();
    if !is_goal_run {
        return Ok(None);
    }

    let target = NativeGoalRunCancelTarget {
        organization_id: row.try_get("organization_id")?,
        run_id: row.try_get("run_id")?,
    };
    Ok(Some(target))
}

/// Whether this is a short Run reference rather than a full UUID. The public
/// ingress uses this to obtain an authorization scope before classifying the
/// reference, while exact UUID resolution keeps its legacy global semantics.
pub fn is_short_run_id_reference(reference: &str) -> bool {
    Uuid::parse_str(reference.trim()).is_err() && run_id_prefix(reference).is_some()
}

/// Revalidate the public identity and its organization access on the same
/// transaction that records the cooperative stop request. Agent and Board
/// callers use the existing organization-scoped NativeAgentAuthorizer checks
/// used by the legacy public cancel route.
pub async fn request_authorized_cancel(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    target: &NativeGoalRunCancelTarget,
    actor_kind: &str,
    actor_id: &str,
) -> Result<(), NativeGoalRunCancelError> {
    let organization_id = Uuid::parse_str(&target.organization_id)
        .map_err(|_| NativeGoalRunCancelError::NotFound)?
        .to_string();
    let run_id = Uuid::parse_str(&target.run_id)
        .map_err(|_| NativeGoalRunCancelError::NotFound)?
        .to_string();
    let mut tx = pool.begin().await?;
    let result = request_in_transaction(
        &mut tx,
        authorizer,
        &organization_id,
        &run_id,
        actor_kind,
        actor_id,
    )
    .await;
    match result {
        Ok(()) => tx
            .commit()
            .await
            .map_err(NativeGoalRunCancelError::Database),
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

async fn request_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    authorizer: &dyn NativeAgentAuthorizer,
    organization_id: &str,
    run_id: &str,
    actor_kind: &str,
    actor_id: &str,
) -> Result<(), NativeGoalRunCancelError> {
    let row = sqlx::query(
        "SELECT r.agent_id::text AS agent_id,r.status
         FROM heartbeat_runs r
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid
           AND r.execution_authority='native_rust' AND r.goal_id IS NOT NULL
           AND r.scene='heartbeat' AND r.target_type='wakeup_request'
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(NativeGoalRunCancelError::NotFound)?;

    match authorizer.revalidate(tx, organization_id).await? {
        NativeAgentAccess::Authorized => {}
        NativeAgentAccess::Unauthorized => return Err(NativeGoalRunCancelError::Unauthorized),
        NativeAgentAccess::Forbidden => return Err(NativeGoalRunCancelError::Forbidden),
    }

    let agent_id: String = row.try_get("agent_id")?;
    match actor_kind {
        "user" | "agent" => {}
        _ => return Err(NativeGoalRunCancelError::Unauthorized),
    }

    let status: String = row.try_get("status")?;
    if status != "running" {
        return Ok(());
    }

    let requested = goal_runs::request_cancel_in_transaction(
        tx,
        organization_id,
        run_id,
        "Cancelled by Rudder",
    )
    .await
    .map_err(|error| match error {
        goal_runs::GoalRunError::Database(error) => NativeGoalRunCancelError::Database(error),
        _ => NativeGoalRunCancelError::NotFound,
    })?;
    if !requested {
        return Err(NativeGoalRunCancelError::NotFound);
    }

    let details = json!({ "agentId": agent_id });
    activity::write_activity_idempotent(
        tx,
        ActivityWrite {
            org: organization_id,
            audit: &ActivityActor {
                actor_type: if actor_kind == "agent" {
                    "agent"
                } else {
                    "user"
                },
                actor_id: actor_id.to_owned(),
                run_id: None,
            },
            action: "heartbeat.cancelled",
            entity_type: "heartbeat_run",
            entity_id: run_id,
            details: Some(&details),
            options: ActivityOptions::default(),
        },
        &format!("native-goal-run-cancel:{run_id}"),
    )
    .await?;
    Ok(())
}

fn run_id_prefix(reference: &str) -> Option<String> {
    let normalized = reference.trim().to_ascii_lowercase();
    let prefix = if let Some(typed) = normalized.strip_prefix("run_") {
        typed
    } else {
        normalized.as_str()
    };
    (8..=32)
        .contains(&prefix.len())
        .then_some(prefix)
        .filter(|prefix| prefix.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_reference_prefix_accepts_only_public_run_id_forms() {
        for reference in [
            "run_abcdef01",
            "abcdef01",
            "RUN_ABCDEF0123456789",
            "abcdef0123456789abcdef0123456789",
        ] {
            assert!(run_id_prefix(reference).is_some(), "{reference}");
        }
        for reference in [
            "run_abcdef0",
            "run_abcdef0123456789abcdef01234567890",
            "gol_abcdef01",
            "not-a-run",
        ] {
            assert_eq!(run_id_prefix(reference), None, "{reference}");
        }
    }
}
