use crate::{CommittedMutation, Outcome, ResultState, StoreError, transaction};
use rudder_organization_mutation_core::{
    OrganizationSettingsCommand, OrganizationSettingsIntentSourceKind,
    OrganizationSettingsMutationSnapshot, OrganizationSettingsPatch,
};
use serde_json::{Map, Value, json};
use sqlx::Row;

struct IntentRow {
    phase: String,
}

struct ProposalMessageRow {
    org_id: String,
    conversation_id: String,
    approval_id: Option<String>,
}

pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: OrganizationSettingsCommand,
    metadata: &transaction::Metadata,
) -> Result<CommittedMutation, StoreError> {
    let command = command.normalized().map_err(StoreError::Settings)?;
    let intent = lock_and_verify_intent(tx, metadata, &command).await?;

    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        return Ok(receipt);
    }
    if intent.as_ref().is_some_and(|row| {
        matches!(
            row.phase.as_str(),
            "rust_committed"
                | "effects_pending"
                | "downstream_pending"
                | "effects_claimed"
                | "completed"
        )
    }) {
        return Err(StoreError::InvalidReceipt);
    }

    let scope = transaction::lock_organization_scope(tx, metadata).await?;
    metadata.check_fresh(scope.version, scope.fence_epoch)?;

    let current = sqlx::query(
        "SELECT name, description, status, budget_monthly_cents,
                spent_monthly_cents, default_chat_issue_creation_mode,
                require_board_approval_for_new_agents, issue_prefix, brand_color
         FROM organizations
         WHERE id=$1::uuid",
    )
    .bind(&metadata.org)
    .fetch_one(&mut **tx)
    .await?;
    let current_logo: Option<String> = sqlx::query_scalar(
        "SELECT asset_id::text
         FROM organization_logos
         WHERE org_id=$1::uuid
         FOR UPDATE",
    )
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?;

    let current_name: String = current.try_get("name")?;
    let current_description: Option<String> = current.try_get("description")?;
    let current_status: String = current.try_get("status")?;
    let current_budget: i32 = current.try_get("budget_monthly_cents")?;
    let current_spent: i32 = current.try_get("spent_monthly_cents")?;
    let current_mode: String = current.try_get("default_chat_issue_creation_mode")?;
    let current_require_approval: bool =
        current.try_get("require_board_approval_for_new_agents")?;
    let current_prefix: String = current.try_get("issue_prefix")?;
    let current_brand_color: Option<String> = current.try_get("brand_color")?;

    let requested_prefix = command.patch.issue_prefix.clone();
    let mut issue_identifier_rewrites = 0_u64;
    if requested_prefix
        .as_deref()
        .is_some_and(|prefix| prefix != current_prefix)
    {
        let prefix = requested_prefix
            .as_deref()
            .ok_or(StoreError::InvalidInput)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'))")
            .execute(&mut **tx)
            .await?;
        let route_key_taken = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
               SELECT 1 FROM organizations
               WHERE id <> $2::uuid
                 AND (lower(url_key) = lower($1) OR lower(issue_prefix) = lower($1))
             ) OR EXISTS(
               SELECT 1 FROM organization_issue_prefix_aliases
               WHERE org_id <> $2::uuid AND lower(prefix) = lower($1)
             )",
        )
        .bind(prefix)
        .bind(&metadata.org)
        .fetch_one(&mut **tx)
        .await?;
        if route_key_taken {
            return Err(StoreError::InvalidInput);
        }
        let alias_owner: Option<String> = sqlx::query_scalar(
            "SELECT org_id::text
             FROM organization_issue_prefix_aliases
             WHERE lower(prefix) = lower($1)
             FOR UPDATE",
        )
        .bind(prefix)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(alias_owner) = alias_owner {
            if alias_owner != metadata.org {
                return Err(StoreError::InvalidInput);
            }
            sqlx::query(
                "DELETE FROM organization_issue_prefix_aliases
                 WHERE org_id=$1::uuid AND lower(prefix)=lower($2)",
            )
            .bind(&metadata.org)
            .bind(prefix)
            .execute(&mut **tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO organization_issue_prefix_aliases (org_id, prefix)
             VALUES ($1::uuid, $2)
             ON CONFLICT (prefix) DO NOTHING",
        )
        .bind(&metadata.org)
        .bind(&current_prefix)
        .execute(&mut **tx)
        .await?;
        let rewritten = sqlx::query(
            "UPDATE issues
             SET identifier=$1 || '-' || issue_number::text
             WHERE org_id=$2::uuid AND issue_number IS NOT NULL",
        )
        .bind(prefix)
        .bind(&metadata.org)
        .execute(&mut **tx)
        .await?;
        issue_identifier_rewrites = rewritten.rows_affected();
    }

    let next_logo = command
        .patch
        .logo_asset_id
        .as_ref()
        .map(|value| value.clone());
    if let Some(Some(asset_id)) = &next_logo {
        let asset_org: Option<String> = sqlx::query_scalar(
            "SELECT org_id::text
             FROM assets
             WHERE id=$1::uuid
             FOR UPDATE",
        )
        .bind(asset_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(asset_org) = asset_org else {
            return Err(StoreError::NotFound);
        };
        if asset_org != metadata.org {
            return Err(StoreError::InvalidInput);
        }
    }
    if command.patch.logo_asset_id.is_some() {
        match &next_logo {
            Some(Some(asset_id)) => {
                sqlx::query(
                    "INSERT INTO organization_logos (org_id, asset_id)
                     VALUES ($1::uuid, $2::uuid)
                     ON CONFLICT (org_id) DO UPDATE
                     SET asset_id=$2::uuid, updated_at=now()",
                )
                .bind(&metadata.org)
                .bind(asset_id)
                .execute(&mut **tx)
                .await?;
            }
            Some(None) => {
                sqlx::query("DELETE FROM organization_logos WHERE org_id=$1::uuid")
                    .bind(&metadata.org)
                    .execute(&mut **tx)
                    .await?;
            }
            None => return Err(StoreError::InvalidInput),
        }
        if current_logo.as_deref() != next_logo.as_ref().and_then(Option::as_deref) {
            if let Some(old_asset_id) = current_logo.as_deref() {
                sqlx::query("DELETE FROM assets WHERE id=$1::uuid AND org_id=$2::uuid")
                    .bind(old_asset_id)
                    .bind(&metadata.org)
                    .execute(&mut **tx)
                    .await?;
            }
        }
    }

    let description = command.patch.description.as_ref().and_then(Clone::clone);
    let brand_color = command.patch.brand_color.as_ref().and_then(Clone::clone);
    sqlx::query(
        "UPDATE organizations
         SET name=CASE WHEN $2 THEN $3 ELSE name END,
             description=CASE WHEN $4 THEN $5::text ELSE description END,
             status=CASE WHEN $6 THEN $7 ELSE status END,
             budget_monthly_cents=CASE WHEN $8 THEN $9::integer ELSE budget_monthly_cents END,
             spent_monthly_cents=CASE WHEN $10 THEN $11::integer ELSE spent_monthly_cents END,
             default_chat_issue_creation_mode=CASE WHEN $12 THEN $13 ELSE default_chat_issue_creation_mode END,
             require_board_approval_for_new_agents=CASE WHEN $14 THEN $15::boolean ELSE require_board_approval_for_new_agents END,
             issue_prefix=CASE WHEN $16 THEN $17 ELSE issue_prefix END,
             brand_color=CASE WHEN $18 THEN $19::text ELSE brand_color END,
             updated_at=now()
         WHERE id=$1::uuid",
    )
    .bind(&metadata.org)
    .bind(command.patch.name.is_some())
    .bind(command.patch.name.as_deref())
    .bind(command.patch.description.is_some())
    .bind(description.as_deref())
    .bind(command.patch.status.is_some())
    .bind(command.patch.status.as_deref())
    .bind(command.patch.budget_monthly_cents.is_some())
    .bind(command.patch.budget_monthly_cents.map(|value| value as i32))
    .bind(command.patch.spent_monthly_cents.is_some())
    .bind(command.patch.spent_monthly_cents.map(|value| value as i32))
    .bind(command.patch.default_chat_issue_creation_mode.is_some())
    .bind(command.patch.default_chat_issue_creation_mode.as_deref())
    .bind(command.patch.require_board_approval_for_new_agents.is_some())
    .bind(command.patch.require_board_approval_for_new_agents)
    .bind(command.patch.issue_prefix.is_some())
    .bind(command.patch.issue_prefix.as_deref())
    .bind(command.patch.brand_color.is_some())
    .bind(brand_color.as_deref())
    .execute(&mut **tx)
    .await?;

    let next_name = command.patch.name.clone().unwrap_or(current_name);
    let next_description = if command.patch.description.is_some() {
        description
    } else {
        current_description
    };
    let next_status = command.patch.status.clone().unwrap_or(current_status);
    let next_budget = command
        .patch
        .budget_monthly_cents
        .unwrap_or(current_budget as u64);
    let next_spent = command
        .patch
        .spent_monthly_cents
        .unwrap_or(current_spent as u64);
    let next_mode = command
        .patch
        .default_chat_issue_creation_mode
        .clone()
        .unwrap_or(current_mode);
    let next_require_approval = command
        .patch
        .require_board_approval_for_new_agents
        .unwrap_or(current_require_approval);
    let next_prefix = requested_prefix.unwrap_or(current_prefix);
    let next_brand_color = if command.patch.brand_color.is_some() {
        brand_color
    } else {
        current_brand_color
    };
    let aliases = sqlx::query_scalar::<_, String>(
        "SELECT prefix
         FROM organization_issue_prefix_aliases
         WHERE org_id=$1::uuid
         ORDER BY prefix",
    )
    .bind(&metadata.org)
    .fetch_all(&mut **tx)
    .await?;
    let next_version = scope
        .version
        .checked_add(1)
        .ok_or(StoreError::VersionRange)?;
    let state = OrganizationSettingsMutationSnapshot {
        organization_id: metadata.org.clone(),
        version: next_version,
        fence_epoch: scope.fence_epoch,
        name: next_name,
        description: next_description,
        status: next_status,
        budget_monthly_cents: next_budget,
        spent_monthly_cents: next_spent,
        default_chat_issue_creation_mode: next_mode,
        require_board_approval_for_new_agents: next_require_approval,
        issue_prefix: next_prefix,
        issue_prefix_aliases: aliases,
        brand_color: next_brand_color,
        logo_asset_id: match next_logo {
            Some(value) => value,
            None => current_logo,
        },
        issue_identifier_rewrites,
    };
    let details = settings_details(&command.patch, &state);
    let state_integrity = transaction::settings_state_integrity(&state)?;
    transaction::persist_settings(
        tx,
        metadata,
        &scope,
        transaction::Effect {
            version: state.version,
            fence_epoch: state.fence_epoch,
            outcome: Outcome::Applied,
            result: ResultState::OrganizationSettings {
                state,
                state_integrity,
            },
            entity_id: metadata.org.clone(),
            details,
        },
    )
    .await
}

async fn lock_and_verify_intent(
    tx: &mut transaction::Tx<'_>,
    metadata: &transaction::Metadata,
    command: &OrganizationSettingsCommand,
) -> Result<Option<IntentRow>, StoreError> {
    let Some(intent) = metadata.settings_intent.as_ref() else {
        return Ok(None);
    };

    // Source rows are useful boundary checks while they exist, but they are
    // intentionally not the recovery authority. Chat cleanup may remove them
    // after the immutable intent is claimed. Keep the existing source-before-
    // intent lock order so a concurrent source mutation cannot be observed
    // halfway through its row update.
    let approval_org = match intent.approval_id.as_deref() {
        Some(approval_id) => sqlx::query(
            "SELECT org_id::text
             FROM approvals
             WHERE id=$1::uuid
             FOR UPDATE",
        )
        .bind(approval_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(|row| row.try_get::<String, _>("org_id"))
        .transpose()?,
        None => None,
    };
    let proposal_message = match intent.proposal_message_id.as_deref() {
        Some(message_id) => sqlx::query(
            "SELECT org_id::text, conversation_id::text, approval_id::text
             FROM chat_messages
             WHERE id=$1::uuid
             FOR UPDATE",
        )
        .bind(message_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(|row| {
            Ok::<ProposalMessageRow, sqlx::Error>(ProposalMessageRow {
                org_id: row.try_get("org_id")?,
                conversation_id: row.try_get("conversation_id")?,
                approval_id: row.try_get("approval_id")?,
            })
        })
        .transpose()?,
        None => None,
    };

    let row = sqlx::query(
        "SELECT org_id::text, source_kind, source_id::text, approval_id::text,
                conversation_id::text, proposal_message_id::text, generation,
                actor_user_id, actor_principal, patch::text, patch_fingerprint,
                intent_fingerprint, rust_idempotency_key, phase, claim_token::text
         FROM organization_mutation_intents
         WHERE id=$1::uuid
         FOR UPDATE",
    )
    .bind(&intent.intent_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    let row_org: String = row.try_get("org_id")?;
    let row_source_kind: String = row.try_get("source_kind")?;
    let row_source_id: String = row.try_get("source_id")?;
    let row_approval_id: Option<String> = row.try_get("approval_id")?;
    let row_conversation_id: String = row.try_get("conversation_id")?;
    let row_message_id: Option<String> = row.try_get("proposal_message_id")?;
    let row_generation = transaction::unsigned(row.try_get("generation")?)?;
    let row_actor_user_id: Option<String> = row.try_get("actor_user_id")?;
    let row_actor_principal: String = row.try_get("actor_principal")?;
    let row_patch_text: String = row.try_get("patch")?;
    let row_patch_fingerprint: String = row.try_get("patch_fingerprint")?;
    let row_intent_fingerprint: String = row.try_get("intent_fingerprint")?;
    let row_key: String = row.try_get("rust_idempotency_key")?;
    let phase: String = row.try_get("phase")?;
    let claim_token: Option<String> = row.try_get("claim_token")?;
    let source_kind = source_kind_name(intent.source_kind);
    let patch: OrganizationSettingsPatch =
        serde_json::from_str(&row_patch_text).map_err(|_| StoreError::InvalidIntent)?;
    let normalized_patch = patch.normalized().map_err(StoreError::Settings)?;
    if command.patch != normalized_patch {
        return Err(StoreError::InvalidIntent);
    }
    let mut row_command = command.clone();
    row_command.patch = normalized_patch.clone();
    let computed_patch_fingerprint = row_command
        .patch_fingerprint()
        .map_err(StoreError::Settings)?;
    if row_org != metadata.org
        || row_source_kind != source_kind
        || row_source_id != intent.source_id
        || row_approval_id != intent.approval_id
        || row_conversation_id
            != intent
                .conversation_id
                .as_deref()
                .ok_or(StoreError::InvalidIntent)?
        || row_message_id != intent.proposal_message_id
        || row_generation != intent.generation
        || row_actor_user_id != intent.actor_user_id
        || row_actor_principal != intent.actor_principal
        || row_patch_fingerprint != intent.patch_fingerprint
        || row_intent_fingerprint != intent.intent_fingerprint
        || row_patch_fingerprint != computed_patch_fingerprint
        || row_key != metadata.key
    {
        return Err(StoreError::InvalidIntent);
    }
    let canonical_patch: Value =
        serde_json::from_str(&row_patch_text).map_err(|_| StoreError::InvalidIntent)?;
    let normalized_patch_value =
        serde_json::to_value(normalized_patch).map_err(|_| StoreError::InvalidIntent)?;
    if canonical_patch != normalized_patch_value {
        return Err(StoreError::InvalidIntent);
    }

    let conversation_org = match intent.conversation_id.as_deref() {
        Some(conversation_id) => {
            // The intent row is locked first so a pending intent cannot be
            // accepted while a coordinator concurrently rejects or revises it.
            // A missing conversation is then tolerated only after that intent
            // has crossed the claim boundary.
            sqlx::query_scalar::<_, String>(
                "SELECT org_id::text
                 FROM chat_conversations
                 WHERE id=$1::uuid
                 FOR UPDATE",
            )
            .bind(conversation_id)
            .fetch_optional(&mut **tx)
            .await?
        }
        None => None,
    };
    let source_missing = intent.approval_id.is_some() && approval_org.is_none()
        || intent.proposal_message_id.is_some() && proposal_message.is_none()
        || intent.conversation_id.is_some() && conversation_org.is_none();
    let source_cleanup_is_allowed = matches!(
        phase.as_str(),
        "claimed"
            | "rust_committed"
            | "effects_pending"
            | "downstream_pending"
            | "effects_claimed"
            | "completed"
    );
    if source_missing && !source_cleanup_is_allowed {
        return Err(StoreError::InvalidIntent);
    }
    if approval_org
        .as_deref()
        .is_some_and(|org| org != metadata.org)
        || conversation_org
            .as_deref()
            .is_some_and(|org| org != metadata.org)
    {
        return Err(StoreError::InvalidIntent);
    }
    if let Some(message) = proposal_message {
        if message.org_id != metadata.org
            || message.conversation_id
                != intent
                    .conversation_id
                    .as_deref()
                    .ok_or(StoreError::InvalidIntent)?
        {
            return Err(StoreError::InvalidIntent);
        }
        // The message foreign key may already be cleared while the approval
        // row remains. The immutable intent was authenticated before claim,
        // so preserve the Node coordinator's nullable-link compatibility.
        if let Some(message_approval_id) = message.approval_id {
            if Some(message_approval_id) != intent.approval_id {
                return Err(StoreError::InvalidIntent);
            }
        }
    }

    match (
        phase.as_str(),
        intent.claim_token.as_deref(),
        claim_token.as_deref(),
    ) {
        ("pending", None, None)
        | (
            "rust_committed" | "effects_pending" | "downstream_pending" | "effects_claimed"
            | "completed",
            None,
            None,
        ) => {}
        ("claimed", Some(expected), Some(actual)) if expected == actual => {}
        _ => return Err(StoreError::StaleClaim),
    }
    Ok(Some(IntentRow { phase }))
}

fn source_kind_name(kind: OrganizationSettingsIntentSourceKind) -> &'static str {
    match kind {
        OrganizationSettingsIntentSourceKind::ChatLightweight => "chat_lightweight",
        OrganizationSettingsIntentSourceKind::ChatApproval => "chat_approval",
    }
}

fn settings_details(
    patch: &OrganizationSettingsPatch,
    state: &OrganizationSettingsMutationSnapshot,
) -> Value {
    let mut details = match serde_json::to_value(patch) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    details.insert("auditSurface".to_owned(), json!(patch.audit_surface()));
    details.insert(
        "issuePrefixAliases".to_owned(),
        json!(state.issue_prefix_aliases),
    );
    details.insert(
        "issueIdentifierRewrites".to_owned(),
        json!(state.issue_identifier_rewrites),
    );
    Value::Object(details)
}
