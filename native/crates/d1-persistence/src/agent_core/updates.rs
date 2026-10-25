//! Organization-scoped Agent profile/configuration PATCH behavior.
use super::{common::*, reads, redaction};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

const CONFIG_REVISION_FIELDS: &[&str] = &[
    "name",
    "role",
    "title",
    "capabilities",
    "agentRuntimeType",
    "agentRuntimeConfig",
    "runtimeConfig",
    "budgetMonthlyCents",
    "metadata",
];
const INSTRUCTIONS_PATH_KEYS: &[&str] = &["instructionsFilePath", "agentsMdPath"];
const INSTRUCTIONS_BUNDLE_KEYS: &[&str] = &[
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
];

pub(super) async fn execute(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    row: &Value,
    input: &Value,
) -> Result<Value> {
    let id = text(row, "id");
    require_update(tx, ctx, id).await?;

    let mut patch = input
        .as_object()
        .cloned()
        .ok_or_else(|| http(400, "Validation error"))?;
    let replace_runtime_config = patch
        .remove("replaceAgentRuntimeConfig")
        .is_some_and(|value| value == true);
    // Skill selection has a separate public endpoint. The shared PATCH schema
    // historically inherited this create-only field; it is intentionally not
    // treated as an Agent table column here.
    patch.remove("desiredSkills");

    let existing_config = row["agentRuntimeConfig"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let touches_adapter_config =
        patch.contains_key("agentRuntimeType") || patch.contains_key("agentRuntimeConfig");
    if touches_adapter_config {
        let requested_runtime_type = patch
            .get("agentRuntimeType")
            .and_then(Value::as_str)
            .unwrap_or_else(|| text(row, "agentRuntimeType"))
            .to_owned();
        let changing_runtime_type = patch
            .get("agentRuntimeType")
            .and_then(Value::as_str)
            .is_some_and(|runtime_type| runtime_type != text(row, "agentRuntimeType"));
        let requested_config = patch
            .get("agentRuntimeConfig")
            .and_then(Value::as_object)
            .cloned();

        if let Some(requested) = &requested_config {
            if requested
                .keys()
                .any(|key| INSTRUCTIONS_PATH_KEYS.contains(&key.as_str()))
            {
                require_manage_instructions_path(tx, ctx, row).await?;
            }
            if replace_runtime_config
                && INSTRUCTIONS_BUNDLE_KEYS
                    .iter()
                    .any(|key| existing_config.contains_key(*key) && !requested.contains_key(*key))
            {
                require_manage_instructions_path(tx, ctx, row).await?;
            }
        }

        let mut effective_config = requested_config
            .clone()
            .unwrap_or_else(|| existing_config.clone());
        if requested_config.is_some() && !changing_runtime_type && !replace_runtime_config {
            effective_config = existing_config.clone();
            effective_config.extend(requested_config.expect("checked above"));
        }
        if changing_runtime_type
            && !effective_config
                .keys()
                .any(|key| INSTRUCTIONS_BUNDLE_KEYS.contains(&key.as_str()))
        {
            for key in INSTRUCTIONS_BUNDLE_KEYS {
                if let Some(value) = existing_config.get(*key) {
                    effective_config.insert((*key).to_owned(), value.clone());
                }
            }
        }

        let mut effective_config = Value::Object(effective_config);
        super::validation::apply_create_defaults(
            &requested_runtime_type,
            &mut effective_config,
            true,
        )?;
        effective_config =
            super::validation::normalize_update_runtime_config(tx, ctx.org, &effective_config)
                .await?;
        validate_adapter_model_config(&requested_runtime_type, &effective_config)?;
        sync_bundle_config_from_file_path(ctx, row, &mut effective_config)?;
        patch.insert("agentRuntimeConfig".into(), effective_config);
    }

    if let Some(icon) = patch.get("icon") {
        if let Some(icon) = icon.as_str() {
            super::writes::assert_avatar_asset_belongs_to_org(tx, ctx.org, icon).await?;
        }
    }

    if let Some(status) = patch.get("status").and_then(Value::as_str) {
        if row["status"] == "terminated" && status != "terminated" {
            return Err(http(409, "Terminated agents cannot be resumed"));
        }
        if row["status"] == "pending_approval"
            && status != "pending_approval"
            && status != "terminated"
        {
            return Err(http(
                409,
                "Pending approval agents cannot be activated directly",
            ));
        }
    }

    if let Some(name) = patch.get("name").and_then(Value::as_str) {
        if slug(text(row, "name")) != slug(name) {
            let existing = sqlx::query_as::<_, (String, String)>(
                "SELECT name,status FROM agents WHERE org_id=$1::uuid AND id<>$2::uuid",
            )
            .bind(ctx.org)
            .bind(id)
            .fetch_all(&mut **tx)
            .await?;
            let candidate_slug = slug(name);
            let collision = existing.iter().any(|(existing_name, status)| {
                status != "terminated" && slug(existing_name) == candidate_slug
            });
            if collision {
                if !candidate_slug.is_empty() {
                    return Err(http(
                        409,
                        format!(
                            "Agent shortname '{candidate_slug}' is already in use in this organization"
                        ),
                    ));
                }
            }
        }
    }

    let before = config_snapshot(row);
    let mut database_patch = patch.clone();
    database_patch.insert("updatedAt".into(), json!(now()));
    let updated = update(tx, ctx.org, id, &Value::Object(database_patch)).await?;
    let after = config_snapshot(&updated);
    let changed_keys = CONFIG_REVISION_FIELDS
        .iter()
        .filter(|key| before[*key] != after[*key])
        .copied()
        .collect::<Vec<_>>();
    if !changed_keys.is_empty() {
        insert(
            tx,
            "agent_config_revisions",
            &json!({
                "orgId":ctx.org,
                "agentId":id,
                "createdByAgentId":ctx.agent(),
                "createdByUserId":ctx.user(),
                "source":"patch",
                "changedKeys":changed_keys,
                "beforeConfig":before,
                "afterConfig":after
            }),
        )
        .await?;
    }
    activity(
        tx,
        ctx,
        "agent.updated",
        id,
        Some(&update_activity_details(&patch)),
    )
    .await?;
    reads::public_row(tx, updated, false, false).await
}

async fn require_manage_instructions_path(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    target: &Value,
) -> Result<()> {
    if ctx.user().is_some() || ctx.agent() == Some(text(target, "id")) {
        return Ok(());
    }
    let actor_id = ctx
        .agent()
        .ok_or_else(|| http(403, "Agent authentication required"))?;
    let actor = stored(tx, actor_id)
        .await?
        .ok_or_else(|| http(403, "Agent key cannot access another organization"))?;
    if text(&actor, "orgId") != ctx.org {
        return Err(http(403, "Agent key cannot access another organization"));
    }
    let denied = "Only the target agent, CEO, or agent creators can update instructions path";
    if !can_create(&actor) {
        return Err(http(403, denied));
    }
    if text(&actor, "role") == "ceo"
        || has_grant(tx, ctx, "agents:create").await?
        || can_create(&actor)
    {
        return Ok(());
    }
    Err(http(403, denied))
}

fn validate_adapter_model_config(runtime_type: &str, config: &Value) -> Result<()> {
    let Some(required_prefix) = (match runtime_type {
        "opencode_local" => Some("OpenCode"),
        "pi_local" => Some("Pi"),
        _ => None,
    }) else {
        return Ok(());
    };
    let model = config["model"].as_str().map(js_trim).unwrap_or_default();
    let mut parts = model.split('/');
    let provider = parts.next().unwrap_or_default().trim();
    let model_id = parts.next().unwrap_or_default().trim();
    if provider.is_empty() || model_id.is_empty() {
        let message = format!(
            "{required_prefix} requires `agentRuntimeConfig.model` in provider/model format."
        );
        return Err(http(
            422,
            format!("Invalid {runtime_type} agentRuntimeConfig: {message}"),
        ));
    }
    Ok(())
}

fn sync_bundle_config_from_file_path(
    ctx: &Context<'_>,
    row: &Value,
    config: &mut Value,
) -> Result<()> {
    let Some(config) = config.as_object_mut() else {
        return Err(http(422, "agentRuntimeConfig must be an object"));
    };
    let Some(file_path) = config
        .get("instructionsFilePath")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|value| !value.is_empty())
    else {
        config.remove("instructionsBundleMode");
        config.remove("instructionsRootPath");
        config.remove("instructionsEntryFile");
        return Ok(());
    };
    let resolved = resolve_legacy_instructions_path(file_path, config)?;
    let resolved_path = PathBuf::from(&resolved);
    let parent = resolved_path
        .parent()
        .ok_or_else(|| http(422, "Invalid instructions path"))?;
    let entry = resolved_path
        .file_name()
        .ok_or_else(|| http(422, "Invalid instructions path"))?
        .to_string_lossy()
        .into_owned();
    let workspace = if js_trim(text(row, "workspaceKey")).is_empty() {
        reads::workspace_key(row)
    } else {
        js_trim(text(row, "workspaceKey")).to_owned()
    };
    let managed_root = super::instructions::agents_root(ctx)?
        .join(workspace)
        .join("instructions");
    let managed_prefix = format!(
        "{}{}",
        managed_root.to_string_lossy(),
        std::path::MAIN_SEPARATOR
    );
    let managed_entry = managed_root.join(&entry);
    let managed = resolved.starts_with(&managed_prefix)
        || resolved == managed_entry.to_string_lossy().as_ref();
    config.insert(
        "instructionsBundleMode".into(),
        json!(if managed { "managed" } else { "external" }),
    );
    config.insert(
        "instructionsRootPath".into(),
        json!(parent.to_string_lossy().into_owned()),
    );
    config.insert("instructionsEntryFile".into(), json!(entry));
    config.insert("instructionsFilePath".into(), json!(resolved));
    Ok(())
}

fn resolve_legacy_instructions_path(
    candidate: &str,
    config: &Map<String, Value>,
) -> Result<String> {
    let candidate = js_trim(candidate);
    if Path::new(candidate).is_absolute() {
        return Ok(candidate.to_owned());
    }
    let cwd = config
        .get("cwd")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|cwd| !cwd.is_empty() && Path::new(cwd).is_absolute())
        .ok_or_else(|| {
            http(
                422,
                "Legacy relative instructionsFilePath requires agentRuntimeConfig.cwd to be set to an absolute path",
            )
        })?;
    super::instructions::resolve_instructions_file_path(candidate, &json!({"cwd":cwd}))
}

fn config_snapshot(row: &Value) -> Value {
    let mut snapshot = json!({});
    for key in CONFIG_REVISION_FIELDS {
        snapshot[*key] = match *key {
            "agentRuntimeConfig" | "runtimeConfig" => {
                if row[*key].is_object() {
                    redaction::sanitize(&row[*key])
                } else {
                    json!({})
                }
            }
            "metadata" => {
                if row[*key].is_object() {
                    redaction::sanitize(&row[*key])
                } else if row[*key].is_null() {
                    Value::Null
                } else {
                    Value::Null
                }
            }
            _ => row[*key].clone(),
        };
    }
    snapshot
}

fn update_activity_details(patch: &Map<String, Value>) -> Value {
    let mut top_level = patch.keys().cloned().collect::<Vec<_>>();
    top_level.sort();
    let mut details = json!({"changedTopLevelKeys":top_level});
    if let Some(config) = patch.get("agentRuntimeConfig").and_then(Value::as_object) {
        let mut keys = config.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        details["changedAdapterConfigKeys"] = json!(keys);
    }
    if let Some(config) = patch.get("runtimeConfig").and_then(Value::as_object) {
        let mut keys = config.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        details["changedRuntimeConfigKeys"] = json!(keys);
    }
    details
}
