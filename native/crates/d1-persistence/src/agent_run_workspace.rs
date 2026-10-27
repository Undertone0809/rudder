//! Existing execution-workspace/runtime-service persistence for claimed Runs.
//! Host effects live in Foundation; every write is organization scoped and
//! checks the already-issued Run owner instead of minting another capability.
use crate::{
    StoreError,
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    agent_execution::AgentRunClaim,
};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction};
use std::{future::Future, pin::Pin};

#[derive(Debug, thiserror::Error)]
pub enum AgentRunWorkspaceError {
    #[error("Agent Run no longer owns workspace preparation")]
    Ownership,
    #[error("Agent workspace database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("Agent workspace activity could not be persisted")]
    Activity(#[from] StoreError),
    #[error("Workspace ready comment could not be persisted")]
    Comment(#[from] crate::issue_comments::IssueCommentError),
}
type Result<T> = std::result::Result<T, AgentRunWorkspaceError>;

async fn owned(tx: &mut Transaction<'_, Postgres>, claim: &AgentRunClaim) -> Result<()> {
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM heartbeat_runs r JOIN heartbeat_run_attempts a
       ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$5
       WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.agent_id=$3::uuid
         AND r.execution_authority='native_rust' AND r.status='running'
         AND r.execution_owner_token=$5 AND r.execution_lease_expires_at>statement_timestamp()
         AND a.status='started')",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.agent_id)
    .bind(&claim.attempt_id)
    .bind(&claim.owner_token)
    .fetch_one(&mut **tx)
    .await?;
    if !valid {
        return Err(AgentRunWorkspaceError::Ownership);
    }
    crate::agent_execution::mark_native_write(tx).await?;
    Ok(())
}

pub async fn begin_operation(
    pool: &PgPool,
    claim: &AgentRunClaim,
    phase: &str,
    command: Option<&str>,
    cwd: &str,
    metadata: &Value,
) -> Result<String> {
    let mut tx = pool.begin().await?;
    owned(&mut tx, claim).await?;
    let id=sqlx::query_scalar::<_,String>("INSERT INTO workspace_operations(org_id,heartbeat_run_id,phase,command,cwd,status,metadata)
        VALUES($1::uuid,$2::uuid,$3,$4,$5,'running',$6) RETURNING id::text")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(phase).bind(command).bind(cwd).bind(metadata)
        .fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(id)
}
pub async fn finish_operation(
    pool: &PgPool,
    claim: &AgentRunClaim,
    id: &str,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
    log_bytes: i64,
    log_sha: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    owned(&mut tx, claim).await?;
    sqlx::query("UPDATE workspace_operations SET status=CASE WHEN $4=0 THEN 'succeeded' ELSE 'failed' END,
        exit_code=$4,stdout_excerpt=$5,stderr_excerpt=$6,log_bytes=$7,log_sha256=$8,log_compressed=false,finished_at=statement_timestamp(),updated_at=statement_timestamp()
        WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid AND id=$3::uuid")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(id).bind(exit_code).bind(stdout).bind(stderr).bind(log_bytes).bind(log_sha)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn attach_operation_log(
    pool: &PgPool,
    claim: &AgentRunClaim,
    id: &str,
    reference: &str,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    owned(&mut tx, claim).await?;
    sqlx::query("UPDATE workspace_operations SET log_store='local_file',log_ref=$4,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid AND id=$3::uuid")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(id).bind(reference).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Persist only an observed, realized workspace. `value` contains paths and
/// non-secret policy metadata, never resolved runtime configuration or env.
pub async fn persist_workspace(
    pool: &PgPool,
    claim: &AgentRunClaim,
    value: &Value,
) -> Result<Option<String>> {
    let Some(project) = value["projectId"].as_str() else {
        return Ok(None);
    };
    let mut tx = pool.begin().await?;
    // Match the existing Issue -> Run locking order used by claim/checkout.
    let issue = if let Some(issue) = claim.issue_id.as_deref() {
        sqlx::query(
            "SELECT execution_workspace_id::text AS existing_id,execution_workspace_preference,
        execution_workspace_settings,project_workspace_id::text AS project_workspace_id FROM issues
        WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(&claim.organization_id)
        .bind(issue)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        None
    };
    sqlx::query("SELECT id FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&claim.organization_id)
        .bind(&claim.run_id)
        .execute(&mut *tx)
        .await?;
    owned(&mut tx, claim).await?;
    if claim.issue_id.is_some() && issue.is_none() {
        return Err(AgentRunWorkspaceError::Ownership);
    }
    let targets_valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects p WHERE p.org_id=$1::uuid AND p.id=$2::uuid) AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM project_workspaces w WHERE w.org_id=$1::uuid AND w.project_id=$2::uuid AND w.id=$3::uuid))")
        .bind(&claim.organization_id).bind(project).bind(value["workspaceId"].as_str()).fetch_one(&mut *tx).await?;
    if !targets_valid {
        return Err(AgentRunWorkspaceError::Ownership);
    }
    let existing_id = issue
        .as_ref()
        .map(|row| row.try_get::<Option<String>, _>("existing_id"))
        .transpose()?
        .flatten();
    let reuse = issue
        .as_ref()
        .map(|row| row.try_get::<Option<String>, _>("execution_workspace_preference"))
        .transpose()?
        .flatten()
        .as_deref()
        == Some("reuse_existing");
    let existing = if let Some(id) = existing_id.as_deref() {
        sqlx::query("SELECT id::text,status,metadata FROM execution_workspaces WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&claim.organization_id).bind(id).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    let existing_reusable = reuse
        && existing.as_ref().is_some_and(|row| {
            row.try_get::<String, _>("status")
                .is_ok_and(|s| s != "archived")
        });
    let id = if existing_reusable {
        existing_id.clone().unwrap()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let strategy = value["strategy"].as_str().unwrap_or("project_primary");
    let provider = if strategy == "git_worktree" {
        "git_worktree"
    } else {
        "local_fs"
    };
    let mode = match value["mode"].as_str().unwrap_or("shared_workspace") {
        "isolated_workspace" => "isolated_workspace",
        "operator_branch" => "operator_branch",
        "agent_default" => "adapter_managed",
        _ => "shared_workspace",
    };
    let mut metadata = existing
        .as_ref()
        .filter(|_| existing_reusable)
        .map(|row| row.try_get::<Option<Value>, _>("metadata"))
        .transpose()?
        .flatten()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}));
    metadata["source"] = value["source"].clone();
    metadata["createdByRuntime"] = value["created"].clone();
    let name = value["branchName"]
        .as_str()
        .or_else(|| value["issueIdentifier"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "workspace-{}",
                claim.agent_id.chars().take(8).collect::<String>()
            )
        });
    sqlx::query("INSERT INTO execution_workspaces(id,org_id,project_id,project_workspace_id,source_issue_id,
        mode,strategy_type,name,status,cwd,repo_url,base_ref,branch_name,provider_type,provider_ref,metadata)
        SELECT $1::uuid,$2::uuid,p.id,$4::uuid,$5::uuid,$6,$7,$8,'active',$9,$10,$11,$12,$13,$14,$15
        FROM projects p WHERE p.org_id=$2::uuid AND p.id=$3::uuid
        ON CONFLICT(id) DO UPDATE SET cwd=EXCLUDED.cwd,repo_url=EXCLUDED.repo_url,base_ref=EXCLUDED.base_ref,
          branch_name=EXCLUDED.branch_name,provider_type=EXCLUDED.provider_type,provider_ref=EXCLUDED.provider_ref,
          status='active',last_used_at=statement_timestamp(),metadata=EXCLUDED.metadata,updated_at=statement_timestamp()
        WHERE execution_workspaces.org_id=EXCLUDED.org_id")
        .bind(&id).bind(&claim.organization_id).bind(project).bind(value["workspaceId"].as_str()).bind(claim.issue_id.as_deref())
        .bind(mode).bind(strategy).bind(name).bind(value["cwd"].as_str()).bind(value["repoUrl"].as_str()).bind(value["repoRef"].as_str())
        .bind(value["branchName"].as_str()).bind(provider).bind(value["worktreePath"].as_str()).bind(&metadata).execute(&mut *tx).await?;
    if let Some(old) = existing_id.as_deref().filter(|old| *old != id) {
        sqlx::query("UPDATE execution_workspaces SET status='idle',cleanup_reason=NULL,updated_at=statement_timestamp()
            WHERE org_id=$1::uuid AND id=$2::uuid AND status='active'").bind(&claim.organization_id).bind(old).execute(&mut *tx).await?;
    }
    if let Some(issue) = claim.issue_id.as_deref() {
        let mut settings = value["issueSettings"].clone();
        if !settings.is_object() {
            settings = json!({});
        }
        let isolated = matches!(mode, "isolated_workspace" | "operator_branch");
        let update_preference = reuse || isolated;
        if update_preference {
            settings["mode"] = json!(if mode == "adapter_managed" {
                "agent_default"
            } else {
                mode
            });
        }
        sqlx::query("UPDATE issues SET execution_workspace_id=$3::uuid,
            project_workspace_id=COALESCE($4::uuid,project_workspace_id),
            execution_workspace_preference=CASE WHEN $5 THEN 'reuse_existing' ELSE execution_workspace_preference END,
            execution_workspace_settings=CASE WHEN $5 THEN $6 ELSE execution_workspace_settings END,updated_at=statement_timestamp()
            WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(&claim.organization_id).bind(issue).bind(&id).bind(value["workspaceId"].as_str()).bind(update_preference).bind(settings).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE workspace_operations SET execution_workspace_id=$3::uuid WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&id).execute(&mut *tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET context_snapshot=COALESCE(context_snapshot,'{}'::jsonb)||jsonb_build_object('executionWorkspaceId',$3::text),updated_at=statement_timestamp()
        WHERE org_id=$1::uuid AND id=$2::uuid").bind(&claim.organization_id).bind(&claim.run_id).bind(&id).execute(&mut *tx).await?;
    let audit = ActivityActor {
        actor_type: "agent",
        actor_id: claim.agent_id.clone(),
        run_id: Some(claim.run_id.clone()),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: &claim.organization_id,
            audit: &audit,
            action: "execution_workspace.prepared",
            entity_type: "execution_workspace",
            entity_id: &id,
            details: Some(
                &json!({"runId":claim.run_id,"strategy":strategy,"created":value["created"]}),
            ),
            options: ActivityOptions {
                agent_id: Some(&claim.agent_id),
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Some(id))
}

pub async fn persist_service(pool: &PgPool, claim: &AgentRunClaim, service: &Value) -> Result<()> {
    let mut tx = pool.begin().await?;
    owned(&mut tx, claim).await?;
    sqlx::query("INSERT INTO workspace_runtime_services(id,org_id,project_id,project_workspace_id,execution_workspace_id,issue_id,
        scope_type,scope_id,service_name,status,lifecycle,reuse_key,command,cwd,port,url,provider,provider_ref,owner_agent_id,
        started_by_run_id,stop_policy,health_status,stopped_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::uuid,$20::uuid,$21,$22,
          CASE WHEN $10 IN('stopped','failed') THEN statement_timestamp() ELSE NULL END)
        ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,last_used_at=statement_timestamp(),stopped_at=EXCLUDED.stopped_at,
          health_status=EXCLUDED.health_status,updated_at=statement_timestamp()
        WHERE workspace_runtime_services.org_id=EXCLUDED.org_id")
        .bind(service["id"].as_str()).bind(&claim.organization_id).bind(service["projectId"].as_str()).bind(service["projectWorkspaceId"].as_str())
        .bind(service["executionWorkspaceId"].as_str()).bind(claim.issue_id.as_deref()).bind(service["scopeType"].as_str()).bind(service["scopeId"].as_str())
        .bind(service["serviceName"].as_str().unwrap_or("service")).bind(service["status"].as_str().unwrap_or("running"))
        .bind(service["lifecycle"].as_str().unwrap_or("shared")).bind(service["reuseKey"].as_str()).bind(service["command"].as_str()).bind(service["cwd"].as_str())
        .bind(service["port"].as_i64().and_then(|value|i32::try_from(value).ok())).bind(service["url"].as_str())
        .bind(service["provider"].as_str().unwrap_or("local_process")).bind(service["providerRef"].as_str()).bind(&claim.agent_id)
        .bind(service["startedByRunId"].as_str().unwrap_or(&claim.run_id)).bind(&service["stopPolicy"]).bind(service["healthStatus"].as_str().unwrap_or("unknown"))
        .execute(&mut *tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET context_snapshot=jsonb_set(COALESCE(context_snapshot,'{}'::jsonb),'{rudderRuntimeServices}',COALESCE(context_snapshot->'rudderRuntimeServices','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',$3::text)),true),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(context_snapshot->'rudderRuntimeServices','[]'::jsonb)) item WHERE item->>'id'=$3::text)")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(service["id"].as_str()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Child-owner observation, also used for idle-timeout release after the
/// starting Run has completed. Match the original local process reference;
/// this is not a generic service-status mutation endpoint.
pub async fn observe_service_process_exit(
    pool: &PgPool,
    org: &str,
    id: &str,
    process_ref: &str,
    failed: bool,
) -> Result<()> {
    sqlx::query("UPDATE workspace_runtime_services SET status=CASE WHEN $4 THEN 'failed' ELSE 'stopped' END,
        health_status=CASE WHEN $4 THEN 'unhealthy' ELSE 'unknown' END,stopped_at=statement_timestamp(),
        last_used_at=statement_timestamp(),updated_at=statement_timestamp()
        WHERE org_id=$1::uuid AND id=$2::uuid AND provider='local_process' AND provider_ref=$3
          AND status IN('starting','running')")
        .bind(org).bind(id).bind(process_ref).bind(failed).execute(pool).await?;
    Ok(())
}

pub async fn persisted_run_services(pool: &PgPool, org: &str, run: &str) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('id',s.id,'orgId',s.org_id,'providerRef',s.provider_ref,
        'status',s.status,'lifecycle',s.lifecycle,'stopPolicy',s.stop_policy,'startedByRunId',s.started_by_run_id)
        FROM workspace_runtime_services s WHERE s.org_id=$1::uuid AND (s.started_by_run_id=$2::uuid OR EXISTS(SELECT 1 FROM heartbeat_runs r, jsonb_array_elements(COALESCE(r.context_snapshot->'rudderRuntimeServices','[]'::jsonb)) item WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND item->>'id'=s.id::text))
          AND s.provider='local_process' AND s.status IN('starting','running') ORDER BY s.created_at,s.id")
        .bind(org).bind(run).fetch_all(pool).await?)
}

pub async fn record_ready_comment(
    pool: &PgPool,
    claim: &AgentRunClaim,
    body: &str,
) -> Result<Option<Value>> {
    let Some(issue) = claim.issue_id.as_deref() else {
        return Ok(None);
    };
    let authorizer = RunAuthorizer {
        org: claim.organization_id.clone(),
        agent: claim.agent_id.clone(),
        run: claim.run_id.clone(),
        owner: claim.owner_token.clone(),
    };
    let value = crate::issue_comments::apply_issue_comment_write_with_native_auth(
        pool,
        &claim.organization_id,
        issue,
        None,
        crate::issue_comments::IssueCommentWrite::Create,
        crate::issue_comments::IssueCommentActor {
            kind: "agent",
            id: &claim.agent_id,
            agent_id: Some(&claim.agent_id),
            run_id: Some(&claim.run_id),
        },
        &json!({"body":body}),
        &authorizer,
    )
    .await?;
    Ok(Some(value))
}
struct RunAuthorizer {
    org: String,
    agent: String,
    run: String,
    owner: String,
}
impl NativeAgentAuthorizer for RunAuthorizer {
    fn revalidate<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        org: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = std::result::Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>,
    > {
        Box::pin(async move {
            if org != self.org {
                return Ok(NativeAgentAccess::Forbidden);
            }
            let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs r JOIN agents a ON a.org_id=r.org_id AND a.id=r.agent_id
                WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.agent_id=$3::uuid AND r.execution_owner_token=$4
                  AND r.execution_authority='native_rust' AND r.status='running' AND r.execution_lease_expires_at>statement_timestamp()
                  AND a.status NOT IN('terminated','suspended','pending_approval'))")
                .bind(org).bind(&self.run).bind(&self.agent).bind(&self.owner).fetch_one(connection).await?;
            Ok(if valid {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Unauthorized
            })
        })
    }
}
