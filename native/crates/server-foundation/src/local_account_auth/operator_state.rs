use sqlx::{Postgres, Row, Transaction};

const LEGACY_USER_ID: &str = "local-board";

pub(super) struct CopyResult {
    pub org_ids: Vec<String>,
}

/// Copy the long-lived, user-scoped Board state into the claimed account.
/// Deterministic ids and upserts preserve retry behavior after a successful
/// claim whose HTTP response was lost.
pub(super) async fn copy_legacy_operator_state(
    transaction: &mut Transaction<'_, Postgres>,
    installation_id: &str,
    target_user_id: &str,
) -> Result<CopyResult, sqlx::Error> {
    let rows = sqlx::query(
        r#"
        SELECT DISTINCT org_id::text AS org_id
        FROM organization_memberships
        WHERE principal_type = 'user' AND status = 'active'
          AND principal_id = ANY($1::text[])
        ORDER BY org_id::text
        "#,
    )
    .bind(vec![LEGACY_USER_ID.to_owned(), target_user_id.to_owned()])
    .fetch_all(&mut **transaction)
    .await?;
    let mut org_ids = Vec::with_capacity(rows.len());
    for row in rows {
        org_ids.push(row.try_get::<String, _>("org_id")?);
    }
    if org_ids.is_empty() {
        return Ok(CopyResult { org_ids });
    }

    // Match the TypeScript Saved View owner-placement lock order. Acquiring
    // both owners in sorted order avoids inversions with a concurrent move.
    let mut owner_ids = vec![LEGACY_USER_ID.to_owned(), target_user_id.to_owned()];
    owner_ids.sort();
    for org_id in &org_ids {
        for user_id in &owner_ids {
            let key = format!(
                "messenger-saved-views:{}:{}",
                org_id.to_lowercase(),
                user_id
            );
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(key)
                .execute(&mut **transaction)
                .await?;
        }
    }

    sqlx::query(
        r#"
        INSERT INTO messenger_custom_groups
        SELECT (jsonb_populate_record(NULL::messenger_custom_groups,
          jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))
          ), true), '{user_id}', to_jsonb($2::text), true))).*
        FROM messenger_custom_groups AS source
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
          AND NOT EXISTS (
            SELECT 1 FROM activity_log AS removed
            WHERE removed.org_id = source.org_id
              AND removed.actor_type = 'user' AND removed.actor_id = $2
              AND removed.action = 'messenger.custom_group_removed'
              AND removed.entity_type = 'messenger_custom_group'
              AND removed.entity_id =
                (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
                 substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
                 substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
                 substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
                 substr(md5(source.id::text || ':' || $2), 21, 12))
          )
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        CREATE TEMP TABLE local_account_saved_view_copy_map (
          org_id uuid NOT NULL,
          source_id uuid NOT NULL,
          target_id uuid NOT NULL,
          PRIMARY KEY (org_id, source_id)
        ) ON COMMIT DROP
        "#,
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO local_account_saved_view_copy_map (org_id, source_id, target_id)
        SELECT source.org_id, source.id,
          COALESCE(existing.id,
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))::uuid)
        FROM messenger_saved_views AS source
        LEFT JOIN LATERAL (
          SELECT target.id
          FROM messenger_saved_views AS target
          WHERE target.org_id = source.org_id AND target.user_id = $2
            AND (
              (source.client_mutation_id IS NOT NULL
                AND target.client_mutation_id = source.client_mutation_id)
              OR target.instance_id = source.instance_id
              OR target.resource_key = source.resource_key
            )
          ORDER BY CASE
            WHEN source.client_mutation_id IS NOT NULL
              AND target.client_mutation_id = source.client_mutation_id THEN 0
            WHEN target.instance_id = source.instance_id THEN 1
            ELSE 2
          END, target.id
          LIMIT 1
        ) AS existing ON TRUE
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO messenger_saved_views
        SELECT (jsonb_populate_record(NULL::messenger_saved_views,
          jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(map.target_id), true),
            '{user_id}', to_jsonb($2::text), true))).*
        FROM messenger_saved_views AS source
        JOIN local_account_saved_view_copy_map AS map
          ON map.org_id = source.org_id AND map.source_id = source.id
        WHERE source.user_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM messenger_saved_views AS existing
            WHERE existing.id = map.target_id
          )
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO messenger_custom_group_entries
        SELECT (jsonb_populate_record(NULL::messenger_custom_group_entries,
          jsonb_set(jsonb_set(jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))
          ), true), '{user_id}', to_jsonb($2::text), true), '{group_id}', to_jsonb(
            (substr(md5(source.group_id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 21, 12))
          ), true), '{thread_key}', to_jsonb(CASE
            WHEN source.thread_key LIKE 'saved-view:%' AND saved_map.target_id IS NOT NULL
              THEN 'saved-view:' || saved_map.target_id::text
            ELSE source.thread_key
          END), true))).*
        FROM messenger_custom_group_entries AS source
        JOIN messenger_custom_groups AS target_group
          ON target_group.org_id = source.org_id AND target_group.user_id = $2
          AND target_group.id =
            (substr(md5(source.group_id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.group_id::text || ':' || $2), 21, 12))::uuid
        LEFT JOIN local_account_saved_view_copy_map AS saved_map
          ON saved_map.org_id = source.org_id
          AND saved_map.source_id::text = substring(source.thread_key FROM 12)
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
          AND NOT EXISTS (
            SELECT 1 FROM activity_log AS removed
            WHERE removed.org_id = source.org_id
              AND removed.actor_type = 'user' AND removed.actor_id = $2
              AND removed.action = 'messenger.custom_group_removed'
              AND removed.entity_type = 'messenger_custom_group'
              AND removed.entity_id =
                (substr(md5(source.group_id::text || ':' || $2), 1, 8) || '-' ||
                 substr(md5(source.group_id::text || ':' || $2), 9, 4) || '-' ||
                 substr(md5(source.group_id::text || ':' || $2), 13, 4) || '-' ||
                 substr(md5(source.group_id::text || ':' || $2), 17, 4) || '-' ||
                 substr(md5(source.group_id::text || ':' || $2), 21, 12))
          )
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO messenger_saved_view_mutations
        SELECT (jsonb_populate_record(NULL::messenger_saved_view_mutations,
          jsonb_set(jsonb_set(jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))
          ), true), '{user_id}', to_jsonb($2::text), true), '{saved_view_id}', to_jsonb(saved_map.target_id), true),
          '{group_id}', COALESCE(to_jsonb(placement.group_id), 'null'::jsonb), true))).*
        FROM messenger_saved_view_mutations AS source
        JOIN local_account_saved_view_copy_map AS saved_map
          ON saved_map.org_id = source.org_id AND saved_map.source_id = source.saved_view_id
        LEFT JOIN messenger_custom_group_entries AS placement
          ON placement.org_id = source.org_id AND placement.user_id = $2
          AND placement.thread_key = 'saved-view:' || saved_map.target_id::text
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO messenger_thread_user_states
        SELECT (jsonb_populate_record(NULL::messenger_thread_user_states,
          jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))
          ), true), '{user_id}', to_jsonb($2::text), true))).*
        FROM messenger_thread_user_states AS source
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
        ON CONFLICT (org_id, thread_key, user_id) DO UPDATE SET
          last_read_at = GREATEST(messenger_thread_user_states.last_read_at, EXCLUDED.last_read_at),
          pinned_at = CASE WHEN EXCLUDED.updated_at > messenger_thread_user_states.updated_at
            THEN EXCLUDED.pinned_at ELSE messenger_thread_user_states.pinned_at END,
          updated_at = GREATEST(messenger_thread_user_states.updated_at, EXCLUDED.updated_at)
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO chat_conversation_user_states
        SELECT (jsonb_populate_record(NULL::chat_conversation_user_states,
          jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))
          ), true), '{user_id}', to_jsonb($2::text), true))).*
        FROM chat_conversation_user_states AS source
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
        ON CONFLICT (org_id, conversation_id, user_id) DO UPDATE SET
          last_read_at = GREATEST(chat_conversation_user_states.last_read_at, EXCLUDED.last_read_at),
          pinned_at = CASE WHEN EXCLUDED.updated_at > chat_conversation_user_states.updated_at
            THEN EXCLUDED.pinned_at ELSE chat_conversation_user_states.pinned_at END,
          updated_at = GREATEST(chat_conversation_user_states.updated_at, EXCLUDED.updated_at)
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO issue_read_states
        SELECT (jsonb_populate_record(NULL::issue_read_states,
          jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))
          ), true), '{user_id}', to_jsonb($2::text), true))).*
        FROM issue_read_states AS source
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
        ON CONFLICT (org_id, issue_id, user_id) DO UPDATE SET
          last_read_at = GREATEST(issue_read_states.last_read_at, EXCLUDED.last_read_at),
          updated_at = GREATEST(issue_read_states.updated_at, EXCLUDED.updated_at)
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO issue_follows
        SELECT (jsonb_populate_record(NULL::issue_follows,
          jsonb_set(jsonb_set(to_jsonb(source), '{id}', to_jsonb(
            (substr(md5(source.id::text || ':' || $2), 1, 8) || '-' ||
             substr(md5(source.id::text || ':' || $2), 9, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 13, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 17, 4) || '-' ||
             substr(md5(source.id::text || ':' || $2), 21, 12))
          ), true), '{user_id}', to_jsonb($2::text), true))).*
        FROM issue_follows AS source
        WHERE source.user_id = $1 AND source.org_id::text = ANY($3::text[])
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO operator_profiles
          (user_id, nickname, more_about_you, preferences, created_at, updated_at)
        SELECT $2, nickname, more_about_you, preferences, created_at, updated_at
        FROM operator_profiles
        WHERE user_id = $1
        ON CONFLICT (user_id) DO UPDATE SET
          nickname = COALESCE(operator_profiles.nickname, EXCLUDED.nickname),
          more_about_you = COALESCE(operator_profiles.more_about_you, EXCLUDED.more_about_you),
          preferences = EXCLUDED.preferences || operator_profiles.preferences,
          updated_at = GREATEST(operator_profiles.updated_at, EXCLUDED.updated_at)
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO activity_log
          (org_id, actor_type, actor_id, action, entity_type, entity_id, details)
        SELECT org.id, 'user', $2, 'installation.legacy_operator_state_copied',
          'installation', $3,
          jsonb_build_object('priorPrincipalId', $1, 'compatibilityMode', 'copy_preserving_legacy')
        FROM unnest($4::text[]) AS scoped(org_id_text)
        JOIN organizations AS org ON org.id::text = scoped.org_id_text
        WHERE NOT EXISTS (
          SELECT 1 FROM activity_log AS receipt
          WHERE receipt.org_id = org.id AND receipt.actor_type = 'user'
            AND receipt.actor_id = $2
            AND receipt.action = 'installation.legacy_operator_state_copied'
            AND receipt.entity_type = 'installation' AND receipt.entity_id = $3
        )
        "#,
    )
    .bind(LEGACY_USER_ID)
    .bind(target_user_id)
    .bind(installation_id)
    .bind(&org_ids)
    .execute(&mut **transaction)
    .await?;
    Ok(CopyResult { org_ids })
}
