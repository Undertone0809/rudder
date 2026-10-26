//! Messenger placement cleanup for deleted Issues.
//!
//! Use the same owner and custom-group advisory locks as Messenger Saved Views
//! mutations so a deleted Issue cannot remain in a custom group.

use sqlx::{Postgres, Transaction};

/// Remove an Issue from custom groups in its organization and delete groups
/// that become empty. This runs in the Issue deletion transaction.
pub(crate) async fn remove_issue_group_entries(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    issue_id: &str,
) -> Result<u64, sqlx::Error> {
    let thread_key = format!("issue:{issue_id}");
    let normalized_org_id = org_id.to_ascii_lowercase();

    let active_users = sqlx::query_scalar::<_, String>(
        "SELECT principal_id FROM organization_memberships \
         WHERE org_id=$1::uuid AND principal_type='user' AND status='active'",
    )
    .bind(org_id)
    .fetch_all(&mut **tx)
    .await?;
    let existing_users = sqlx::query_scalar::<_, String>(
        "SELECT user_id FROM messenger_custom_group_entries \
         WHERE org_id=$1::uuid AND thread_key=$2",
    )
    .bind(org_id)
    .bind(&thread_key)
    .fetch_all(&mut **tx)
    .await?;

    let mut owners = active_users;
    owners.extend(existing_users);
    owners.sort();
    owners.dedup();
    for user_id in owners {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!(
                "messenger-saved-views:{normalized_org_id}:{user_id}"
            ))
            .execute(&mut **tx)
            .await?;
    }

    // Re-read once owner placement is serialized, as the Node cleanup does.
    let memberships = sqlx::query_as::<_, (String, String)>(
        "SELECT user_id, group_id::text FROM messenger_custom_group_entries \
         WHERE org_id=$1::uuid AND thread_key=$2",
    )
    .bind(org_id)
    .bind(&thread_key)
    .fetch_all(&mut **tx)
    .await?;

    let mut groups = memberships;
    groups.sort();
    groups.dedup();
    for (user_id, group_id) in &groups {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!(
                "messenger-custom-group:{normalized_org_id}:{user_id}:{}",
                group_id.to_ascii_lowercase()
            ))
            .execute(&mut **tx)
            .await?;
    }

    let deleted = sqlx::query(
        "DELETE FROM messenger_custom_group_entries \
         WHERE org_id=$1::uuid AND thread_key=$2",
    )
    .bind(org_id)
    .bind(&thread_key)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    for (user_id, group_id) in groups {
        sqlx::query(
            "DELETE FROM messenger_custom_groups AS group_row \
             WHERE group_row.org_id=$1::uuid AND group_row.user_id=$2 AND group_row.id=$3::uuid \
               AND NOT EXISTS ( \
                   SELECT 1 FROM messenger_custom_group_entries AS entry \
                   WHERE entry.org_id=group_row.org_id \
                     AND entry.user_id=group_row.user_id \
                     AND entry.group_id=group_row.id \
               )",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(group_id)
        .execute(&mut **tx)
        .await?;
    }

    Ok(deleted)
}
