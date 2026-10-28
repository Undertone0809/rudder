//! Approval-only composition of the existing Agent writers. The locked
//! Approval capability is never deserializable at a public boundary.
use super::*;
use crate::approval_writes::LockedApproval;

pub(crate) async fn normalize_hire_approval_payload(
    tx: &mut Tx<'_>,
    org: &str,
    payload: &mut Value,
) -> Result<()> {
    if let Some(config) = payload.get("agentRuntimeConfig").filter(|v| v.is_object()) {
        payload["agentRuntimeConfig"] =
            validation::normalize_runtime_config(tx, org, config).await?;
    }
    Ok(())
}

pub(crate) async fn apply_approved_agent_change(
    tx: &mut Tx<'_>,
    approval: &LockedApproval,
    actor: &VerifiedActor,
    host: &AgentCoreRequest,
    approved: bool,
) -> Result<Option<Value>> {
    let org = approval.organization_id();
    let payload = &approval.value()["payload"];
    let admin = actor.actor().kind == "user" && sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')"
    ).bind(&actor.actor().id).fetch_one(&mut **tx).await?;
    let ctx = Context {
        org,
        actor,
        request: host,
        admin,
    };
    match approval.value()["type"].as_str() {
        Some("hire_agent") => {
            if let Some(id) = payload["agentId"].as_str() {
                let row = sqlx::query_scalar::<_, String>("SELECT to_jsonb(a)::text FROM agents a WHERE a.id=$1::uuid AND a.org_id=$2::uuid FOR UPDATE")
                    .bind(id).bind(org).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Agent not found"))?;
                let mut row = decode(&row)?;
                if approved {
                    if row["status"] == "pending_approval" {
                        row=decode(&sqlx::query_scalar::<_,String>("UPDATE agents SET status='idle',updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid RETURNING to_jsonb(agents)::text").bind(id).bind(org).fetch_one(&mut **tx).await?)?;
                    }
                } else {
                    row=decode(&sqlx::query_scalar::<_,String>("UPDATE agents SET status='terminated',pause_reason=NULL,paused_at=NULL,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid RETURNING to_jsonb(agents)::text").bind(id).bind(org).fetch_one(&mut **tx).await?)?;
                    sqlx::query("UPDATE agent_api_keys SET revoked_at=now() WHERE org_id=$1::uuid AND agent_id=$2::uuid").bind(org).bind(id).execute(&mut **tx).await?;
                }
                if approved
                    && row["budgetMonthlyCents"]
                        .as_i64()
                        .is_some_and(|budget| budget > 0)
                {
                    super::writes::upsert_budget_policy(
                        tx,
                        &ctx,
                        id,
                        row["budgetMonthlyCents"].as_i64().unwrap_or(0),
                    )
                    .await?;
                }
                return Ok(Some(row));
            }
            if !approved {
                return Ok(None);
            }
            let budget = match &payload["budgetMonthlyCents"] {
                Value::Number(value) => value
                    .as_i64()
                    .filter(|amount| i32::try_from(*amount).is_ok())
                    .ok_or_else(|| http(422, "Invalid Agent budget"))?,
                _ => 0,
            };
            let request = AgentCreateRequest {
                name: Some(hire_string(&payload["name"], "New Agent")),
                role: hire_string(&payload["role"], "general"),
                title: payload["title"].as_str().map(str::to_owned),
                capabilities: payload["capabilities"].as_str().map(str::to_owned),
                agent_runtime_type: hire_string(&payload["agentRuntimeType"], "process"),
                agent_runtime_config: payload
                    .get("agentRuntimeConfig")
                    .filter(|v| v.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                runtime_config: json!({}),
                budget_monthly_cents: budget,
                permissions: AgentCreatePermissions {
                    can_create_agents: true,
                    can_manage_skills: true,
                },
                metadata: payload.get("metadata").filter(|v| v.is_object()).cloned(),
                desired_skills: Vec::new(),
                node_owned: None,
            };
            Ok(Some(
                writes::create_approved_hire(tx, &ctx, approval, request).await?,
            ))
        }
        Some("chat_operation") if approved => {
            let proposal = payload.get("operationProposal").unwrap_or(payload);
            if proposal["targetType"] != "agent" {
                return Ok(None);
            }
            let id = proposal["targetId"]
                .as_str()
                .ok_or_else(|| http(422, "Approved operation target is required"))?;
            let raw=sqlx::query_scalar::<_,String>("SELECT to_jsonb(a)::text FROM agents a WHERE a.id=$1::uuid AND a.org_id=$2::uuid FOR UPDATE").bind(id).bind(org).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Agent not found"))?;
            let row = decode(&raw)?;
            let input = normalize_public_input("update", proposal["patch"].clone())?;
            Ok(Some(updates::execute(tx, &ctx, &row, &input).await?))
        }
        _ => Ok(None),
    }
}

/// Match public Agent creation's durable workspace provisioning/recovery path.
/// The Approval and Agent are already committed, so a provisioning failure
/// remains recoverable through the existing detail-read reconciler.
pub(crate) async fn finish_approved_agent_create(
    pool: &PgPool,
    actor: &VerifiedActor,
    host: &AgentCoreRequest,
    org: &str,
    id: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) {
    if instructions::provision_created_agent_after_commit(
        pool,
        actor,
        host,
        org,
        id,
        Some(authorizer),
    )
    .await
    .is_err()
    {
        tracing::warn!(
            "approved Agent workspace provisioning did not complete; durable recovery remains available"
        );
    }
}

// The pre-existing hire payload is an open Approval record; its three string
// fields use JavaScript String(value ?? default), unlike direct Agent create.
fn hire_string(value: &Value, default: &str) -> String {
    match value {
        Value::Null => default.into(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| hire_string(value, ""))
            .collect::<Vec<_>>()
            .join(","),
    }
}
