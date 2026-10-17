//! Private managed MCP provisioning used by the gated Rust Agent create path.
//!
//! The public managed MCP routes remain Node-owned. This module only gives the
//! Rust identity transaction a narrowly scoped, opt-in foundation for creating
//! the same organization-level default bindings as the Node Agent create path.

use super::{AgentCoreError, common::Tx};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use serde_json::json;
use sqlx::Row;

const MANAGED_MCP_CREATE_ENV: &str = "RUDDER_AGENT_CREATE_RUST_MANAGED_MCP_ENABLED";

pub(super) fn feature_enabled() -> bool {
    std::env::var(MANAGED_MCP_CREATE_ENV)
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OrganizationConnection {
    id: String,
    provider: String,
    access_mode: String,
}

fn default_access(provider: &str, organization_access: &str) -> &'static str {
    match provider {
        "custom" => "full",
        "notion" => "provider_granted",
        _ if organization_access == "read_only" => "read_only",
        _ => "read_write",
    }
}

/// Create missing organization-level managed MCP bindings for an Agent.
///
/// This helper deliberately does not update existing rows. In particular, an
/// explicit `none` binding is a durable opt-out and must survive a later Agent
/// create reconciliation. Activity is emitted only after an insert succeeds,
/// so retries are idempotent and do not duplicate audit rows.
pub(super) async fn ensure_default_bindings_for_agent(
    tx: &mut Tx<'_>,
    org_id: &str,
    agent_id: &str,
) -> Result<u64, AgentCoreError> {
    let eligible = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
           SELECT 1
           FROM agents
           WHERE org_id=$1::uuid
             AND id=$2::uuid
             AND status <> 'terminated'
             AND NOT COALESCE(metadata->'hidden' = 'true'::jsonb, false)
             AND COALESCE(metadata->>'systemManaged', '') <> 'rudder_copilot'
         )",
    )
    .bind(org_id)
    .bind(agent_id)
    .fetch_one(&mut **tx)
    .await?;
    if !eligible {
        return Ok(0);
    }
    let connections = sqlx::query(
        "SELECT id::text AS id, provider, access_mode
         FROM mcp_connections
         WHERE org_id=$1::uuid
           AND scope='organization'
           AND status='active'
           AND enabled=true
           AND canonical_state='canonical'
           AND transport <> 'legacy_manual'
         ORDER BY id",
    )
    .bind(org_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| OrganizationConnection {
        id: row.get("id"),
        provider: row.get("provider"),
        access_mode: row.get("access_mode"),
    })
    .collect::<Vec<_>>();

    let mut created = 0_u64;
    for connection in connections {
        let tool_ids = sqlx::query_scalar::<_, String>(
            "SELECT id::text
             FROM custom_integration_tools
             WHERE org_id=$1::uuid
               AND connection_id=$2::uuid
               AND status='active'
               AND enabled=true
               AND removed_at IS NULL
             ORDER BY id",
        )
        .bind(org_id)
        .bind(&connection.id)
        .fetch_all(&mut **tx)
        .await?;
        let enabled_tool_ids = serde_json::to_string(&tool_ids)
            .map_err(|_| AgentCoreError::Http(500, "Internal server error".into(), None))?;
        let access_mode = default_access(&connection.provider, &connection.access_mode);
        let binding_id = sqlx::query_scalar::<_, String>(
            "INSERT INTO agent_custom_integration_bindings
               (org_id, agent_id, connection_id, status, access_mode, enabled_tool_ids)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', $4, $5::jsonb)
             ON CONFLICT DO NOTHING
             RETURNING id::text",
        )
        .bind(org_id)
        .bind(agent_id)
        .bind(&connection.id)
        .bind(access_mode)
        .bind(&enabled_tool_ids)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(binding_id) = binding_id else {
            continue;
        };
        let details = json!({
            "connectionId": connection.id,
            "status": "active",
            "accessMode": access_mode,
            "policyRevision": 1,
            "enabledToolCount": tool_ids.len(),
            "source": "agent_creation",
        });
        write_activity_options(
            tx,
            ActivityWrite {
                org: org_id,
                audit: &ActivityActor {
                    actor_type: "system",
                    actor_id: "system".to_owned(),
                    run_id: None,
                },
                action: "mcp_agent_binding.created",
                entity_type: "mcp_agent_binding",
                entity_id: &binding_id,
                details: Some(&details),
                options: ActivityOptions {
                    agent_id: Some(agent_id),
                    ..ActivityOptions::default()
                },
            },
        )
        .await?;
        created += 1;
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::ensure_default_bindings_for_agent;
    use sqlx::{PgPool, Row};
    use support::{CEO, Database, ORG};

    mod support {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/mod.rs"));
    }

    async fn run_for(pool: &PgPool, agent_id: &str) -> u64 {
        let mut tx = pool.begin().await.expect("begin transaction");
        let created = ensure_default_bindings_for_agent(&mut tx, ORG, agent_id)
            .await
            .expect("managed MCP provisioning");
        tx.commit().await.expect("commit transaction");
        created
    }

    async fn run(pool: &PgPool) -> u64 {
        run_for(pool, CEO).await
    }

    async fn seed_connection(
        database: &Database,
        id: &str,
        provider: &str,
        access_mode: &str,
        transport: &str,
        canonical_state: &str,
        status: &str,
        enabled: bool,
    ) {
        sqlx::query(
            "INSERT INTO mcp_connections
               (id, org_id, name, display_name, provider, transport, access_mode,
                status, canonical_state, safe_config, enabled)
             VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5, $6, $7, $8, '{}'::jsonb, $9)",
        )
        .bind(id)
        .bind(ORG)
        .bind(format!("mcp-{id}"))
        .bind(provider)
        .bind(transport)
        .bind(access_mode)
        .bind(status)
        .bind(canonical_state)
        .bind(enabled)
        .execute(&database.pool)
        .await
        .expect("seed MCP connection");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn provisions_provider_defaults_and_is_idempotent() {
        let database = Database::start().await;
        let linear = "60000000-0000-4000-8000-000000000001";
        let notion = "60000000-0000-4000-8000-000000000002";
        let ignored = "60000000-0000-4000-8000-000000000003";
        let custom = "60000000-0000-4000-8000-000000000004";
        let tool = "61000000-0000-4000-8000-000000000001";
        let disabled_tool = "61000000-0000-4000-8000-000000000002";
        let removed_tool = "61000000-0000-4000-8000-000000000003";
        seed_connection(
            &database,
            linear,
            "linear",
            "read_write",
            "streamable_http",
            "canonical",
            "active",
            true,
        )
        .await;
        seed_connection(
            &database,
            notion,
            "notion",
            "provider_default",
            "streamable_http",
            "canonical",
            "active",
            true,
        )
        .await;
        seed_connection(
            &database,
            ignored,
            "custom",
            "provider_default",
            "legacy_manual",
            "canonical",
            "disabled",
            false,
        )
        .await;
        seed_connection(
            &database,
            custom,
            "custom",
            "provider_default",
            "streamable_http",
            "canonical",
            "active",
            true,
        )
        .await;
        sqlx::query(
            "INSERT INTO custom_integration_tools
               (id, org_id, connection_id, external_tool_name, rudder_tool_name,
                input_schema, status, enabled)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'issues', 'linear.issues', '{}', 'active', true)",
        )
        .bind(tool)
        .bind(ORG)
        .bind(linear)
        .execute(&database.pool)
        .await
        .expect("seed MCP tool");
        sqlx::query(
            "INSERT INTO custom_integration_tools
               (id, org_id, connection_id, external_tool_name, rudder_tool_name,
                input_schema, status, enabled, removed_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'disabled', 'linear.disabled', '{}', 'disabled', true, NULL),
                    ($4::uuid, $2::uuid, $3::uuid, 'removed', 'linear.removed', '{}', 'active', true, now())",
        )
        .bind(disabled_tool)
        .bind(ORG)
        .bind(linear)
        .bind(removed_tool)
        .execute(&database.pool)
        .await
        .expect("seed disabled and removed MCP tools");

        let first = run(&database.pool).await;
        let second = run(&database.pool).await;
        assert_eq!(first, 3);
        assert_eq!(second, 0);
        let rows = sqlx::query(
            "SELECT connection_id::text, access_mode, enabled_tool_ids::text
             FROM agent_custom_integration_bindings
             WHERE org_id=$1::uuid AND agent_id=$2::uuid
             ORDER BY connection_id",
        )
        .bind(ORG)
        .bind(CEO)
        .fetch_all(&database.pool)
        .await
        .expect("read MCP bindings");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].get::<String, _>("access_mode"), "read_write");
        assert_eq!(rows[1].get::<String, _>("access_mode"), "provider_granted");
        assert_eq!(rows[2].get::<String, _>("access_mode"), "full");
        assert_eq!(
            rows[0].get::<String, _>("enabled_tool_ids"),
            format!("[\"{tool}\"]")
        );
        assert_eq!(rows[2].get::<String, _>("enabled_tool_ids"), "[]");
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM activity_log
             WHERE org_id=$1::uuid AND action='mcp_agent_binding.created'",
            )
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .expect("count binding activity"),
            3
        );
        let activities: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT entity_type, actor_type, actor_id, details->>'source'
             FROM activity_log
             WHERE org_id=$1::uuid AND action='mcp_agent_binding.created'
             ORDER BY entity_id",
        )
        .bind(ORG)
        .fetch_all(&database.pool)
        .await
        .expect("read binding activity");
        assert!(
            activities
                .iter()
                .all(|(entity_type, actor_type, actor_id, source)| {
                    entity_type == "mcp_agent_binding"
                        && actor_type == "system"
                        && actor_id == "system"
                        && source.as_deref() == Some("agent_creation")
                })
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM organization_mutation_outbox
                 WHERE org_id=$1::uuid AND event_type='activity.logged'",
            )
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .expect("count binding outbox events"),
            3
        );

        sqlx::query(
            "INSERT INTO agents (id, org_id, name, role, status, metadata)
             VALUES ('60000000-0000-4000-8000-000000000010', $1::uuid, 'Hidden', 'engineer', 'idle', '{\"hidden\":true}'::jsonb)",
        )
        .bind(ORG)
        .execute(&database.pool)
        .await
        .expect("seed hidden agent");
        assert_eq!(
            run_for(&database.pool, "60000000-0000-4000-8000-000000000010").await,
            0
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn preserves_explicit_no_access_on_reconciliation() {
        let database = Database::start().await;
        let connection = "62000000-0000-4000-8000-000000000001";
        seed_connection(
            &database,
            connection,
            "linear",
            "read_write",
            "streamable_http",
            "canonical",
            "active",
            true,
        )
        .await;
        sqlx::query(
            "INSERT INTO agent_custom_integration_bindings
               (org_id, agent_id, connection_id, status, access_mode, enabled_tool_ids)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'disabled', 'none', '[]'::jsonb)",
        )
        .bind(ORG)
        .bind(CEO)
        .bind(connection)
        .execute(&database.pool)
        .await
        .expect("seed explicit no-access binding");

        let created = run(&database.pool).await;
        assert_eq!(created, 0);
        let (status, access_mode): (String, String) = sqlx::query_as(
            "SELECT status, access_mode FROM agent_custom_integration_bindings
             WHERE org_id=$1::uuid AND agent_id=$2::uuid AND connection_id=$3::uuid",
        )
        .bind(ORG)
        .bind(CEO)
        .bind(connection)
        .fetch_one(&database.pool)
        .await
        .expect("read explicit no-access binding");
        assert_eq!((status, access_mode), ("disabled".into(), "none".into()));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM activity_log
             WHERE org_id=$1::uuid AND action='mcp_agent_binding.created'",
            )
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .expect("count no-access activity"),
            0
        );
    }
}
