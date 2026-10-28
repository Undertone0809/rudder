//! Organization-scoped, read-only inputs for an already owned Agent Run.
//! Execution ownership and all Run mutations stay in `agent_execution`.

use crate::{StoreError, transaction};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::BTreeSet;

/// Reconcile the existing managed instruction bundle for an owned local Run.
/// Pending Agent-create payloads are consumed through their existing durable
/// outbox; custom files and explicit external bundles remain untouched.
pub async fn materialize_agent_run_instructions(
    pool: &PgPool,
    claim: &crate::agent_execution::AgentRunClaim,
    host: &crate::agent_core::OrganizationWorkspaceHost,
    operator_home: &std::path::Path,
    cwd: &std::path::Path,
) -> Result<Value, StoreError> {
    if !matches!(
        claim.runtime_type.as_str(),
        "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local"
    ) {
        return Ok(claim.agent_context["agentRuntimeConfig"].clone());
    }
    let mut tx = pool.begin().await?;
    assert_run_owner(&mut tx, claim).await?;
    let pending=sqlx::query_as::<_,(String,String,String,bool)>("SELECT agent_id::text,entry_file,files::text,clear_legacy_prompt_template
        FROM agent_instruction_bundles WHERE org_id=$1::uuid AND agent_id=$2::uuid AND state IN('pending','repair') ORDER BY created_at LIMIT 1")
        .bind(&claim.organization_id).bind(&claim.agent_id).fetch_optional(&mut *tx).await?;
    let input_host = crate::agent_core::instructions::Host {
        instance_root: host.instance_root.clone(),
        workspace_home: host.workspace_home.clone(),
        previous_documents_root: host.previous_documents_root.clone(),
        friendly_workspace_home: host.friendly_workspace_home,
        hostname: host.hostname.clone(),
    };
    let org = claim.organization_id.clone();
    let row = claim.agent_context.clone();
    let home = operator_home.to_path_buf();
    let cwd = cwd.to_path_buf();
    let materialize_pending = pending.clone();
    tx.commit().await?;
    let config = tokio::task::spawn_blocking(move || {
        crate::agent_core::instructions::materialize_for_claimed_run(
            &input_host,
            &org,
            &row,
            &home,
            &cwd,
            materialize_pending
                .as_ref()
                .map(|(_, entry, files, clear)| (entry.as_str(), files.as_str(), *clear)),
        )
    })
    .await
    .map_err(|_| StoreError::InvalidInput)?
    .map_err(|_| StoreError::InvalidInput)?;
    let mut tx = pool.begin().await?;
    assert_run_owner(&mut tx, claim).await?;
    if let Some((id, entry, files, clear)) = pending {
        let changed=sqlx::query("UPDATE agent_instruction_bundles SET state='materialized',materialized_at=statement_timestamp(),last_error=NULL,updated_at=statement_timestamp()
            WHERE org_id=$1::uuid AND agent_id=$2::uuid AND agent_id=$3::uuid AND entry_file=$4 AND files=$5::jsonb AND clear_legacy_prompt_template=$6")
            .bind(&claim.organization_id).bind(&claim.agent_id).bind(id).bind(entry).bind(files).bind(clear).execute(&mut *tx).await?.rows_affected()==1;
        if changed {
            // Merge only derived managed instruction facts into the current
            // persisted config; never copy this invocation's resolved env.
            sqlx::query("UPDATE agents SET agent_runtime_config=((COALESCE(agent_runtime_config,'{}'::jsonb)||jsonb_build_object('instructionsBundleMode','managed','instructionsRootPath',$3::text,'instructionsEntryFile',$4::text,'instructionsFilePath',$5::text))-CASE WHEN $6 THEN ARRAY['promptTemplate','bootstrapPromptTemplate']::text[] ELSE ARRAY[]::text[] END),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
                .bind(&claim.organization_id).bind(&claim.agent_id).bind(config["instructionsRootPath"].as_str()).bind(config["instructionsEntryFile"].as_str()).bind(config["instructionsFilePath"].as_str()).bind(clear).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(config)
}

async fn assert_run_owner(
    tx: &mut Transaction<'_, Postgres>,
    claim: &crate::agent_execution::AgentRunClaim,
) -> Result<(), StoreError> {
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs r JOIN heartbeat_run_attempts a
        ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$5
        WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.agent_id=$3::uuid AND r.status='running'
          AND r.execution_authority='native_rust' AND r.execution_owner_token=$5 AND a.status='started'
          AND r.execution_lease_expires_at>statement_timestamp())")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.agent_id).bind(&claim.attempt_id).bind(&claim.owner_token)
        .fetch_one(&mut **tx).await?;
    if valid {
        crate::agent_execution::mark_native_write(tx).await?;
        Ok(())
    } else {
        Err(StoreError::Unauthorized)
    }
}

/// Contains unresolved configuration and filesystem source references. It is
/// intentionally neither Debug nor serializable.
pub struct AgentRunResources {
    pub issue: Option<Value>,
    pub goal: Option<Value>,
    pub project: Option<Value>,
    pub project_workspaces: Vec<Value>,
    pub project_resources: Vec<Value>,
    pub skills: Vec<Value>,
    pub enabled_skill_keys: BTreeSet<String>,
    pub managed_mcp_bindings: Vec<Value>,
    pub browser_settings: Value,
    pub general_settings: Value,
}

pub async fn load_agent_run_resources(
    pool: &PgPool,
    organization_id: &str,
    agent_id: &str,
    context: &Value,
) -> Result<AgentRunResources, StoreError> {
    transaction::uuid(organization_id)?;
    transaction::uuid(agent_id)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(organization_id)
    .bind(agent_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(StoreError::NotFound);
    }
    let issue = match id(context, "issueId") {
        Some(issue_id) => {
            json_row(
                &mut tx,
                "SELECT jsonb_build_object('id',i.id,'identifier',i.identifier,'title',i.title,
              'projectId',i.project_id,'projectWorkspaceId',i.project_workspace_id,
              'executionWorkspaceId',i.execution_workspace_id,
              'executionWorkspacePreference',i.execution_workspace_preference,
              'executionWorkspaceSettings',i.execution_workspace_settings,
              'assigneeAgentId',i.assignee_agent_id,
              'assigneeAgentRuntimeOverrides',i.assignee_agent_runtime_overrides) AS value
             FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
                organization_id,
                &issue_id,
            )
            .await?
        }
        None => None,
    };
    let goal=match id(context,"goalId") {
        Some(goal_id)=>json_row(&mut tx,"SELECT jsonb_build_object('id',g.id,'ownerAgentId',g.owner_agent_id,'ownerAgentRuntimeOverrides',g.owner_agent_runtime_overrides) AS value FROM goals g WHERE g.org_id=$1::uuid AND g.id=$2::uuid",organization_id,&goal_id).await?,
        None=>None,
    };
    let project_id = issue
        .as_ref()
        .and_then(|value| id(value, "projectId"))
        .or_else(|| id(context, "projectId"));
    let mut project = match project_id.as_deref() {
        Some(project_id) => {
            json_row(
                &mut tx,
                "SELECT jsonb_build_object('id',p.id,'name',p.name,
              'executionWorkspacePolicy',p.execution_workspace_policy) AS value
             FROM projects p WHERE p.org_id=$1::uuid AND p.id=$2::uuid",
                organization_id,
                project_id,
            )
            .await?
        }
        None => None,
    };
    if let Some(project) = project.as_mut() {
        project["urlKey"] = json!(
            crate::project_creations::normalize_key(project["name"].as_str().unwrap_or_default())
                .unwrap_or_else(|| project["id"].as_str().unwrap_or_default().to_owned())
        );
    }
    let project_workspaces = match project_id.as_deref() {
        Some(project_id) => json_rows(&mut tx,
            "SELECT jsonb_build_object('id',w.id,'cwd',w.cwd,'repoUrl',w.repo_url,
              'repoRef',w.repo_ref,'setupCommand',w.setup_command,'cleanupCommand',w.cleanup_command,
              'metadata',w.metadata) AS value FROM project_workspaces w
             WHERE w.org_id=$1::uuid AND w.project_id=$2::uuid ORDER BY w.is_primary DESC,w.created_at,w.id",
            organization_id, project_id).await?,
        None => Vec::new(),
    };
    let project_resources = match project_id.as_deref() {
        Some(project_id) => json_rows(&mut tx,
            "SELECT jsonb_build_object('id',a.id,'role',a.role,'note',a.note,
              'sortOrder',a.sort_order,'isPrimary',a.is_primary,
              'resource',jsonb_build_object('id',r.id,'name',r.name,'kind',r.kind,
                'sourceType',r.source_type,'locator',r.locator,'description',r.description)) AS value
             FROM project_resource_attachments a JOIN organization_resources r
               ON r.id=a.resource_id AND r.org_id=a.org_id
             WHERE a.org_id=$1::uuid AND a.project_id=$2::uuid
             ORDER BY a.is_primary DESC,a.sort_order,r.name,a.id",
            organization_id, project_id).await?,
        None => Vec::new(),
    };
    let skills = sqlx::query_scalar::<_, Value>(
        "SELECT jsonb_build_object('id',s.id,'key',s.key,'slug',s.slug,'name',s.name,
          'description',s.description,'markdown',s.markdown,'sourceType',s.source_type,
          'sourceLocator',s.source_locator,'sourceRef',s.source_ref,
          'fileInventory',s.file_inventory,'metadata',s.metadata) FROM organization_skills s
         WHERE s.org_id=$1::uuid ORDER BY s.key,s.id",
    )
    .bind(organization_id)
    .fetch_all(&mut *tx)
    .await?;
    let enabled_skill_keys = sqlx::query_scalar::<_, String>(
        "SELECT skill_key FROM agent_enabled_skills WHERE org_id=$1::uuid AND agent_id=$2::uuid ORDER BY skill_key",
    ).bind(organization_id).bind(agent_id).fetch_all(&mut *tx).await?.into_iter().collect();
    // These are policy snapshots only. A provider connection must be resolved
    // by native managed-MCP authority before any URL or credentials are used.
    let managed_mcp_bindings = json_rows(
        &mut tx,
        "SELECT jsonb_build_object('bindingId',b.id,'connectionId',c.id,
          'name',c.name,'provider',c.provider,'transport',c.transport,
          'accessMode',b.access_mode,'connectionAccessMode',c.access_mode,
          'enabledToolIds',b.enabled_tool_ids,'required',c.required,
          'startupTimeoutMs',c.startup_timeout_ms,'toolTimeoutMs',c.tool_timeout_ms) AS value
         FROM agent_custom_integration_bindings b JOIN mcp_connections c
           ON c.id=b.connection_id AND c.org_id=b.org_id
         WHERE b.org_id=$1::uuid AND b.agent_id=$2::uuid AND b.status='active'
           AND b.access_mode<>'none' AND c.status='active' AND c.enabled=true
           AND c.transport<>'legacy_manual'
           AND (c.scope='organization' OR (c.scope='agent' AND c.owner_agent_id=b.agent_id))
           AND (c.provider='custom' OR c.canonical_state='canonical') ORDER BY c.name,c.id",
        organization_id,
        agent_id,
    )
    .await?;
    let settings =
        sqlx::query("SELECT browser,general FROM instance_settings WHERE singleton_key='default'")
            .fetch_optional(&mut *tx)
            .await?;
    let browser_settings = settings
        .as_ref()
        .map(|row| row.try_get("browser"))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let general_settings = settings
        .as_ref()
        .map(|row| row.try_get("general"))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    tx.commit().await?;
    Ok(AgentRunResources {
        issue,
        goal,
        project,
        project_workspaces,
        project_resources,
        skills,
        enabled_skill_keys,
        managed_mcp_bindings,
        browser_settings,
        general_settings,
    })
}

pub struct ResolvedAgentRunConfig {
    pub config: Value,
    pub secret_keys: BTreeSet<String>,
}

/// Resolve only existing user-managed, organization-scoped env bindings.
/// Plaintext exists in this non-serializable result only for one invocation.
pub async fn resolve_agent_run_config(
    pool: &PgPool,
    organization_id: &str,
    config: &Value,
) -> Result<ResolvedAgentRunConfig, StoreError> {
    transaction::uuid(organization_id)?;
    let mut tx = pool.begin().await?;
    let mut config = config.clone();
    let mut secret_keys = BTreeSet::new();
    resolve_nested_config(&mut tx, organization_id, &mut config, &mut secret_keys).await?;
    tx.commit().await?;
    Ok(ResolvedAgentRunConfig {
        config,
        secret_keys,
    })
}

pub(crate) fn resolve_nested_config<'a>(
    tx: &'a mut Transaction<'_, Postgres>,
    org: &'a str,
    value: &'a mut Value,
    secret_keys: &'a mut BTreeSet<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), StoreError>> + Send + 'a>> {
    Box::pin(async move {
        if let Some(env) = value.get_mut("env") {
            let mut resolved = serde_json::Map::new();
            for (key, binding) in env.as_object().into_iter().flatten() {
                let valid = !key.is_empty()
                    && key.bytes().enumerate().all(|(index, byte)| {
                        byte == b'_'
                            || byte.is_ascii_alphabetic()
                            || (index > 0 && byte.is_ascii_digit())
                    });
                if !valid {
                    return Err(StoreError::InvalidInput);
                }
                let plain = match binding {
                    Value::String(value) => Some(value.clone()),
                    Value::Object(_) if binding["type"] == "plain" => {
                        binding["value"].as_str().map(str::to_owned)
                    }
                    Value::Object(_) if binding["type"] == "secret_ref" => {
                        let secret = crate::secrets::resolve_local_runtime_secret_reference(
                            tx, org, binding,
                        )
                        .await
                        .map_err(|_| StoreError::InvalidInput)?;
                        secret_keys.insert(key.clone());
                        secret
                    }
                    _ => None,
                }
                .ok_or_else(|| StoreError::InvalidInput)?;
                resolved.insert(key.clone(), Value::String(plain));
            }
            *env = Value::Object(resolved);
        }
        for key in ["fallbackConfigs", "modelFallbacks"] {
            if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
                for item in items {
                    if let Some(config) = item.get_mut("config") {
                        resolve_nested_config(tx, org, config, secret_keys).await?;
                    }
                }
            }
        }
        Ok(())
    })
}

fn id(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .map(str::to_owned)
}
async fn json_row(
    tx: &mut Transaction<'_, Postgres>,
    sql: &str,
    org: &str,
    id: &str,
) -> Result<Option<Value>, StoreError> {
    Ok(sqlx::query_scalar(sql)
        .bind(org)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?)
}
async fn json_rows(
    tx: &mut Transaction<'_, Postgres>,
    sql: &str,
    org: &str,
    id: &str,
) -> Result<Vec<Value>, StoreError> {
    Ok(sqlx::query_scalar(sql)
        .bind(org)
        .bind(id)
        .fetch_all(&mut **tx)
        .await?)
}

/// Refresh the same bundled catalog and migrate legacy stored selections before
/// an owned run reads its skills. File payloads come only from installation
/// facts; resolved provider credentials never enter this transaction.
pub async fn reconcile_agent_run_skills(
    pool: &PgPool,
    claim: &crate::agent_execution::AgentRunClaim,
    bundled: &[Value],
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    assert_run_owner(&mut tx, claim).await?;
    let mut config: Value = sqlx::query_scalar(
        "SELECT agent_runtime_config FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(&claim.organization_id)
    .bind(&claim.agent_id)
    .fetch_one(&mut *tx)
    .await?;
    for skill in bundled {
        let Some(key) = skill["key"].as_str().filter(|s| s.starts_with("rudder/")) else {
            continue;
        };
        sqlx::query("INSERT INTO organization_skills(org_id,key,slug,name,description,markdown,source_type,source_locator,source_ref,file_inventory,metadata)
            VALUES($1::uuid,$2,$3,$4,$5,$6,'local_path',$7,NULL,$8,$9)
            ON CONFLICT(org_id,key) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,description=EXCLUDED.description,
                markdown=EXCLUDED.markdown,source_type=EXCLUDED.source_type,source_locator=EXCLUDED.source_locator,
                source_ref=NULL,file_inventory=EXCLUDED.file_inventory,metadata=EXCLUDED.metadata,updated_at=statement_timestamp()")
            .bind(&claim.organization_id).bind(key).bind(skill["slug"].as_str()).bind(skill["name"].as_str())
            .bind(skill["description"].as_str()).bind(skill["markdown"].as_str().unwrap_or_default()).bind(skill["sourceLocator"].as_str())
            .bind(&skill["fileInventory"]).bind(&skill["metadata"]).execute(&mut *tx).await?;
    }
    let skills:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'key',key,'slug',slug,'metadata',metadata) FROM organization_skills WHERE org_id=$1::uuid ORDER BY key,id")
        .bind(&claim.organization_id).fetch_all(&mut *tx).await?;
    let current:Vec<String>=sqlx::query_scalar("SELECT skill_key FROM agent_enabled_skills WHERE org_id=$1::uuid AND agent_id=$2::uuid ORDER BY skill_key")
        .bind(&claim.organization_id).bind(&claim.agent_id).fetch_all(&mut *tx).await?;
    let legacy = config
        .get("rudderSkillSync")
        .filter(|v| !v.is_null())
        .or_else(|| config.get("paperclipSkillSync"));
    let explicit = legacy.is_some_and(|v| {
        v.as_object()
            .is_some_and(|o| o.contains_key("desiredSkills"))
    });
    let legacy_refs = legacy
        .and_then(|v| v["desiredSkills"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let refs = if current.is_empty() {
        &legacy_refs
    } else {
        &current
    };
    let keys = refs
        .iter()
        .filter_map(|value| normalize_runtime_skill_ref(value, &skills, &claim.runtime_type))
        .filter(|key| !key.starts_with("bundled:"))
        .collect::<BTreeSet<_>>();
    if keys.iter().cloned().collect::<Vec<_>>() != current {
        sqlx::query("DELETE FROM agent_enabled_skills WHERE org_id=$1::uuid AND agent_id=$2::uuid")
            .bind(&claim.organization_id)
            .bind(&claim.agent_id)
            .execute(&mut *tx)
            .await?;
        for key in keys {
            sqlx::query("INSERT INTO agent_enabled_skills(org_id,agent_id,skill_key) SELECT $1::uuid,id,$3 FROM agents WHERE org_id=$1::uuid AND id=$2::uuid ON CONFLICT(agent_id,skill_key) DO NOTHING")
                .bind(&claim.organization_id).bind(&claim.agent_id).bind(key).execute(&mut *tx).await?;
        }
    }
    if current.is_empty() && (explicit || !legacy_refs.is_empty()) {
        if !config.is_object() {
            config = json!({});
        }
        if !config["rudderSkillSync"].is_object() {
            config["rudderSkillSync"] = json!({});
        }
        config["rudderSkillSync"]["desiredSkills"] = json!([]);
        sqlx::query("UPDATE agents SET agent_runtime_config=$3,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(&claim.organization_id).bind(&claim.agent_id).bind(config).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
fn skill_slug(value: &str) -> String {
    let mut result = String::new();
    let mut delimiter = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if delimiter && !result.is_empty() {
                result.push('-');
            }
            result.push(character);
            delimiter = false;
        } else {
            delimiter = true;
        }
    }
    result
}
fn normalize_runtime_skill_ref(value: &str, skills: &[Value], runtime: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let retired = lower
        .trim_start_matches("bundled:")
        .trim_start_matches("rudder/rudder/")
        .trim_start_matches("rudder/");
    if matches!(retired, "rudder-create-agent" | "rudder-create-plugin") {
        return None;
    }
    for prefix in ["org:", "bundled:"] {
        if let Some(key) = value
            .strip_prefix(prefix)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(format!("{prefix}{key}"));
        }
    }
    for prefix in ["agent:", "global:"] {
        if let Some(raw) = value.strip_prefix(prefix) {
            let slug = skill_slug(raw);
            return (!slug.is_empty()).then(|| format!("{prefix}{slug}"));
        }
    }
    if let Some(raw) = value.strip_prefix("adapter:") {
        let (adapter, slug) = raw.split_once(':')?;
        let slug = skill_slug(slug);
        return (!adapter.trim().is_empty() && !slug.is_empty())
            .then(|| format!("adapter:{}:{slug}", adapter.trim()));
    }
    let exact = skills
        .iter()
        .find(|s| s["id"] == value || s["key"] == value);
    let slug = skill_slug(value.rsplit('/').next().unwrap_or(value));
    let matches = skills
        .iter()
        .filter(|s| s["slug"].as_str() == Some(&slug))
        .collect::<Vec<_>>();
    let found = exact.or_else(|| {
        if matches.len() == 1 {
            matches.first().copied()
        } else {
            None
        }
    });
    if let Some(skill) = found {
        let key = skill["key"].as_str()?;
        return Some(format!(
            "{}:{key}",
            if key.starts_with("rudder/") {
                "bundled"
            } else {
                "org"
            }
        ));
    }
    if matches!(lower.as_str(), "rudder" | "rudder/rudder") {
        return Some("bundled:rudder/rudder-docs".into());
    }
    let bundled = lower
        .strip_prefix("rudder/rudder/")
        .or_else(|| lower.strip_prefix("rudder/"))
        .unwrap_or(&lower);
    if [
        "app-builder",
        "para-memory-files",
        "rudder-docs",
        "skill-creator",
        "visualize",
        "browser",
    ]
    .contains(&bundled)
    {
        return Some(format!("bundled:rudder/{bundled}"));
    }
    (!slug.is_empty()).then(|| format!("adapter:{runtime}:{slug}"))
}

/// Commit an already prepared package only while both the Run ownership and
/// the persisted source snapshot still match. The caller supplies managed
/// paths beneath its trusted organization skill directory.
pub async fn record_skill_installation(
    pool: &PgPool,
    claim: &crate::agent_execution::AgentRunClaim,
    skill: &Value,
    installed: &std::path::Path,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    assert_run_owner(&mut tx, claim).await?;
    if !installed.join("SKILL.md").is_file() {
        return Err(StoreError::InvalidInput);
    }
    let result=sqlx::query("UPDATE organization_skills SET metadata=COALESCE(metadata,'{}'::jsonb)||'{\"installationVersion\":1}'::jsonb,updated_at=statement_timestamp()
        WHERE org_id=$1::uuid AND id=$2::uuid AND key=$3 AND source_type=$4
          AND source_locator IS NOT DISTINCT FROM $5 AND source_ref IS NOT DISTINCT FROM $6")
        .bind(&claim.organization_id).bind(skill["id"].as_str()).bind(skill["key"].as_str()).bind(skill["sourceType"].as_str())
        .bind(skill["sourceLocator"].as_str()).bind(skill["sourceRef"].as_str()).execute(&mut *tx).await?;
    if result.rows_affected() != 1 {
        return Err(StoreError::InvalidInput);
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod runtime_skill_tests {
    use super::*;
    #[test]
    fn legacy_selection_normalizes_and_bundled_stays_implicit() {
        let catalog = vec![
            json!({"id":"id-1","key":"organization/o/review","slug":"review"}),
            json!({"id":"id-2","key":"rudder/rudder-docs","slug":"rudder-docs"}),
        ];
        assert_eq!(
            normalize_runtime_skill_ref("id-1", &catalog, "codex_local"),
            Some("org:organization/o/review".into())
        );
        assert_eq!(
            normalize_runtime_skill_ref("review", &catalog, "codex_local"),
            Some("org:organization/o/review".into())
        );
        assert_eq!(
            normalize_runtime_skill_ref("my helper", &catalog, "codex_local"),
            Some("adapter:codex_local:my-helper".into())
        );
        assert_eq!(
            normalize_runtime_skill_ref("rudder/rudder", &catalog, "codex_local"),
            Some("bundled:rudder/rudder-docs".into())
        );
        assert_eq!(
            normalize_runtime_skill_ref("rudder-create-agent", &catalog, "codex_local"),
            None
        );
    }
}

/// Persist only provider-neutral, credential-free policy input for native MCP
/// calls. Every request still intersects this snapshot with current authority.
pub async fn persist_prepared_policy(
    pool: &PgPool,
    claim: &crate::agent_execution::AgentRunClaim,
    bindings: &[Value],
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    assert_run_owner(&mut tx, claim).await?;
    sqlx::query("UPDATE heartbeat_runs SET context_snapshot=COALESCE(context_snapshot,'{}'::jsonb)||jsonb_build_object('managedMcpPolicySnapshot',$3::jsonb),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(json!(bindings)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Publish a restored package beneath the existing managed installation root.
/// Lock the catalog source while the prepared sibling directory is renamed,
/// so a changed source cannot leave an old package marked as current.
pub async fn publish_skill_installation(
    pool: &PgPool,
    claim: &crate::agent_execution::AgentRunClaim,
    skill: &Value,
    prepared: &std::path::Path,
    installed: &std::path::Path,
) -> Result<(), StoreError> {
    if prepared.parent() != installed.parent()
        || installed
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|v| v.to_str())
            != Some("__installed__")
        || !prepared.join("SKILL.md").is_file()
    {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = pool.begin().await?;
    assert_run_owner(&mut tx, claim).await?;
    let current:Option<String>=sqlx::query_scalar("SELECT id::text FROM organization_skills WHERE org_id=$1::uuid AND id=$2::uuid AND key=$3 AND source_type=$4
        AND source_locator IS NOT DISTINCT FROM $5 AND source_ref IS NOT DISTINCT FROM $6 FOR UPDATE")
        .bind(&claim.organization_id).bind(skill["id"].as_str()).bind(skill["key"].as_str()).bind(skill["sourceType"].as_str())
        .bind(skill["sourceLocator"].as_str()).bind(skill["sourceRef"].as_str()).fetch_optional(&mut *tx).await?;
    if current.is_none() {
        return Err(StoreError::InvalidInput);
    }
    if installed.join("SKILL.md").is_file() {
        std::fs::remove_dir_all(prepared).map_err(|_| StoreError::InvalidInput)?;
    } else {
        // Only the existing managed target is replaced. Source packages and
        // global provider directories remain untouched.
        let previous = installed.with_file_name(format!(".previous-{}", claim.attempt_id));
        if installed.exists() {
            std::fs::rename(installed, &previous).map_err(|_| StoreError::InvalidInput)?;
        }
        if std::fs::rename(prepared, installed).is_err() {
            if previous.exists() {
                let _ = std::fs::rename(&previous, installed);
            }
            return Err(StoreError::InvalidInput);
        }
        if previous.exists() {
            let _ = std::fs::remove_dir_all(previous);
        }
    }
    sqlx::query("UPDATE organization_skills SET metadata=COALESCE(metadata,'{}'::jsonb)||'{\"installationVersion\":1}'::jsonb,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&claim.organization_id).bind(skill["id"].as_str()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Local context may be removed after terminal native cleanup or honest
/// request-owner-loss settlement. This never asserts a remote job stopped.
pub async fn releasable_context_attempts(
    pool: &PgPool,
    org: &str,
    run: &str,
) -> Result<Vec<String>, StoreError> {
    transaction::uuid(org)?;
    transaction::uuid(run)?;
    Ok(sqlx::query_scalar("SELECT a.id::text FROM heartbeat_run_attempts a JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
        WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
          AND r.execution_owner_token IS NULL AND r.status IN('succeeded','failed','cancelled','timed_out','skipped')
          AND (r.process_exited_at IS NOT NULL OR r.result_json#>>'{ownerRecovery,requestOwner}'='lost')
          AND a.status<>'started' AND a.finished_at IS NOT NULL ORDER BY a.attempt_epoch,a.id")
        .bind(org).bind(run).fetch_all(pool).await?)
}

/// Read-only validation for the driver's actual pre-launch error path. A
/// retained but unspent launch permit is not process cleanup evidence.
pub async fn assert_unlaunched_context_owner(
    pool: &PgPool,
    claim: &crate::agent_execution::AgentRunClaim,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    assert_run_owner(&mut tx, claim).await?;
    let empty:bool=sqlx::query_scalar("SELECT process_pid IS NULL AND process_started_at IS NULL AND process_exited_at IS NULL FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$3")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).fetch_one(&mut *tx).await?;
    if !empty {
        return Err(StoreError::InvalidInput);
    }
    tx.commit().await?;
    Ok(())
}

/// Shared existing current-operator path censor used by workspace/run logs.
pub fn redact_context_log(text: &str, censor_username: bool) -> String {
    if censor_username {
        crate::activity::redact_current_user_text(text)
    } else {
        text.to_owned()
    }
}
