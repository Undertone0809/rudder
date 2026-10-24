use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use subtle::ConstantTimeEq;

pub(super) struct BoardAccess {
    pub user: Option<Value>,
    pub org_ids: Vec<String>,
    pub is_instance_admin: bool,
}

pub(super) struct CreatedChallenge {
    pub id: String,
    pub expires_at: String,
}

pub(super) struct NewChallenge<'a> {
    pub secret_hash: &'a str,
    pub command: &'a str,
    pub client_name: Option<&'a str>,
    pub requested_access: &'a str,
    pub requested_company_id: Option<&'a str>,
    pub pending_key_hash: &'a str,
    pub pending_key_name: &'a str,
}

pub(super) struct Approval {
    pub status: String,
    pub key_id: Option<String>,
    pub approved_by_user_id: Option<String>,
    pub expires_at: String,
    pub requested_access: String,
    pub requested_company_id: Option<String>,
    pub newly_approved: bool,
}

pub(super) enum ApproveError {
    Database,
    InstanceAdminRequired,
}

impl From<sqlx::Error> for ApproveError {
    fn from(_: sqlx::Error) -> Self {
        Self::Database
    }
}

const CHALLENGE_COLUMNS: &str = r#"
    SELECT c.id::text AS id, c.secret_hash, c.command, c.client_name,
      c.requested_access, c.requested_company_id::text AS requested_company_id,
      c.pending_key_hash, c.pending_key_name,
      c.approved_by_user_id, c.board_api_key_id::text AS board_api_key_id,
      to_char(c.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS approved_at,
      to_char(c.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cancelled_at,
      to_char(c.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
      CASE WHEN c.cancelled_at IS NOT NULL THEN 'cancelled'
        WHEN c.expires_at <= clock_timestamp() THEN 'expired'
        WHEN c.approved_at IS NOT NULL AND c.board_api_key_id IS NOT NULL THEN 'approved'
        ELSE 'pending' END AS status
    FROM cli_auth_challenges c
"#;

type ChallengeRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

pub(super) async fn create_challenge(
    transaction: &mut Transaction<'_, Postgres>,
    challenge: NewChallenge<'_>,
) -> Result<CreatedChallenge, sqlx::Error> {
    let (id, expires_at) = sqlx::query_as::<_, (String, String)>(
        r#"
        INSERT INTO cli_auth_challenges
          (secret_hash, command, client_name, requested_access, requested_company_id,
           pending_key_hash, pending_key_name, expires_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5::uuid, $6, $7,
          clock_timestamp() + interval '10 minutes', clock_timestamp(), clock_timestamp())
        RETURNING id::text,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        "#,
    )
    .bind(challenge.secret_hash)
    .bind(challenge.command)
    .bind(challenge.client_name)
    .bind(challenge.requested_access)
    .bind(challenge.requested_company_id)
    .bind(challenge.pending_key_hash)
    .bind(challenge.pending_key_name)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(CreatedChallenge { id, expires_at })
}

pub(super) async fn describe_challenge(
    transaction: &mut Transaction<'_, Postgres>,
    id: &str,
    expected_secret_hash: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let query = r#"SELECT c.id::text AS id, c.secret_hash, c.command, c.client_name,
          c.requested_access, c.requested_company_id::text AS requested_company_id,
          c.pending_key_hash, c.pending_key_name, c.approved_by_user_id,
          c.board_api_key_id::text AS board_api_key_id,
          to_char(c.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS approved_at,
          to_char(c.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cancelled_at,
          to_char(c.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          CASE WHEN c.cancelled_at IS NOT NULL THEN 'cancelled'
            WHEN c.expires_at <= clock_timestamp() THEN 'expired'
            WHEN c.approved_at IS NOT NULL AND c.board_api_key_id IS NOT NULL THEN 'approved'
            ELSE 'pending' END AS status,
          o.name AS organization_name, u.id AS u_id, u.name AS u_name, u.email AS u_email
        FROM cli_auth_challenges c
        LEFT JOIN organizations o ON o.id = c.requested_company_id
        LEFT JOIN "user" u ON u.id = c.approved_by_user_id
        WHERE c.id = $1::uuid"#;
    let Some(row) = sqlx::query(query)
        .bind(id)
        .fetch_optional(&mut **transaction)
        .await?
    else {
        return Ok(None);
    };
    let stored_hash: String = row.try_get("secret_hash")?;
    if !constant_time_equal(stored_hash.as_bytes(), expected_secret_hash.as_bytes()) {
        return Ok(None);
    }
    let approved_user_id: Option<String> = row.try_get("u_id")?;
    let approved_by_user = match approved_user_id {
        Some(user_id) => Some(json!({
            "id": user_id,
            "name": row.try_get::<Option<String>, _>("u_name")?,
            "email": row.try_get::<Option<String>, _>("u_email")?,
        })),
        None => None,
    };
    Ok(Some(json!({
        "id": row.try_get::<String, _>("id")?,
        "status": row.try_get::<String, _>("status")?,
        "command": row.try_get::<String, _>("command")?,
        "clientName": row.try_get::<Option<String>, _>("client_name")?,
        "requestedAccess": row.try_get::<String, _>("requested_access")?,
        "requestedCompanyId": row.try_get::<Option<String>, _>("requested_company_id")?,
        "requestedCompanyName": row.try_get::<Option<String>, _>("organization_name")?,
        "approvedAt": row.try_get::<Option<String>, _>("approved_at")?,
        "cancelledAt": row.try_get::<Option<String>, _>("cancelled_at")?,
        "expiresAt": row.try_get::<String, _>("expires_at")?,
        "approvedByUser": approved_by_user,
    })))
}

pub(super) async fn approve_challenge(
    transaction: &mut Transaction<'_, Postgres>,
    id: &str,
    expected_secret_hash: &str,
    user_id: &str,
    is_instance_admin: bool,
) -> Result<Option<Approval>, ApproveError> {
    let query = format!("{CHALLENGE_COLUMNS} WHERE c.id = $1::uuid FOR UPDATE");
    let Some(row) = sqlx::query_as::<_, ChallengeRow>(&query)
        .bind(id)
        .fetch_optional(&mut **transaction)
        .await?
    else {
        return Ok(None);
    };
    let (
        _id,
        secret_hash,
        _command,
        _client_name,
        requested_access,
        requested_company_id,
        pending_key_hash,
        pending_key_name,
        approved_by_user_id,
        existing_key_id,
        _approved_at,
        _cancelled_at,
        expires_at,
        status,
    ) = row;
    if !constant_time_equal(secret_hash.as_bytes(), expected_secret_hash.as_bytes()) {
        return Ok(None);
    }
    if status == "expired" || status == "cancelled" {
        return Ok(Some(Approval {
            status,
            key_id: existing_key_id,
            approved_by_user_id,
            expires_at,
            requested_access,
            requested_company_id,
            newly_approved: false,
        }));
    }
    if requested_access == "instance_admin_required" && !is_instance_admin {
        return Err(ApproveError::InstanceAdminRequired);
    }
    if status == "approved" {
        // The row lock makes approval a single-owner transition. Replays return
        // the persisted approver and key without relabeling ownership or
        // emitting a second audit/outbox event.
        return Ok(Some(Approval {
            status,
            key_id: existing_key_id,
            approved_by_user_id,
            expires_at,
            requested_access,
            requested_company_id,
            newly_approved: false,
        }));
    }

    let key_id = match existing_key_id {
        Some(key_id) => key_id,
        None => {
            sqlx::query_as::<_, (String,)>(
                r#"
                INSERT INTO board_api_keys (user_id, name, key_hash, expires_at, created_at)
                VALUES ($1, $2, $3, clock_timestamp() + interval '30 days', clock_timestamp())
                RETURNING id::text
                "#,
            )
            .bind(user_id)
            .bind(&pending_key_name)
            .bind(&pending_key_hash)
            .fetch_one(&mut **transaction)
            .await?
            .0
        }
    };
    sqlx::query(
        r#"
        UPDATE cli_auth_challenges
        SET approved_by_user_id = $2, board_api_key_id = $3::uuid,
            approved_at = COALESCE(approved_at, clock_timestamp()),
            updated_at = clock_timestamp()
        WHERE id = $1::uuid
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(&key_id)
    .execute(&mut **transaction)
    .await?;

    Ok(Some(Approval {
        status: "approved".to_owned(),
        key_id: Some(key_id),
        approved_by_user_id: Some(user_id.to_owned()),
        expires_at,
        requested_access,
        requested_company_id,
        newly_approved: true,
    }))
}

pub(super) async fn cancel_challenge(
    transaction: &mut Transaction<'_, Postgres>,
    id: &str,
    expected_secret_hash: &str,
) -> Result<Option<String>, sqlx::Error> {
    let query = format!("{CHALLENGE_COLUMNS} WHERE c.id = $1::uuid FOR UPDATE");
    let Some(row) = sqlx::query_as::<_, ChallengeRow>(&query)
        .bind(id)
        .fetch_optional(&mut **transaction)
        .await?
    else {
        return Ok(None);
    };
    let (_, secret_hash, _, _, _, _, _, _, _, _, _, _, _, status) = row;
    if !constant_time_equal(secret_hash.as_bytes(), expected_secret_hash.as_bytes()) {
        return Ok(None);
    }
    if status != "pending" {
        return Ok(Some(status));
    }
    sqlx::query(
        "UPDATE cli_auth_challenges SET cancelled_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1::uuid",
    )
    .bind(id)
    .execute(&mut **transaction)
    .await?;
    Ok(Some("cancelled".to_owned()))
}

pub(super) async fn board_access(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
) -> Result<BoardAccess, sqlx::Error> {
    let user = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, name, email FROM "user" WHERE id=$1"#,
    )
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await?
    .map(|(id, name, email)| {
        json!({
            "id": id,
            "name": name,
            "email": email,
        })
    });
    let org_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT org_id::text FROM organization_memberships
           WHERE principal_type='user' AND principal_id=$1 AND status='active'"#,
    )
    .bind(user_id)
    .fetch_all(&mut **transaction)
    .await?;
    let role: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')",
    )
    .bind(user_id)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(BoardAccess {
        user,
        org_ids,
        is_instance_admin: role,
    })
}

pub(super) async fn activity_org_ids(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    is_instance_admin: bool,
) -> Result<Vec<String>, sqlx::Error> {
    let mut org_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT org_id::text FROM organization_memberships
           WHERE principal_type='user' AND principal_id=$1 AND status='active'"#,
    )
    .bind(user_id)
    .fetch_all(&mut **transaction)
    .await?;
    // A challenge's requested organization is requester-controlled metadata.
    // It cannot authorize an activity write into an organization the actor
    // does not belong to. Users without an organization keep the legacy
    // key-issuance flow, but have no organization-scoped activity row.
    if org_ids.is_empty() && is_instance_admin {
        org_ids = sqlx::query_scalar::<_, String>("SELECT id::text FROM organizations")
            .fetch_all(&mut **transaction)
            .await?;
    }
    Ok(org_ids)
}

pub(super) async fn record_activity(
    transaction: &mut Transaction<'_, Postgres>,
    org_ids: &[String],
    user_id: &str,
    action: &str,
    details: Value,
) -> Result<(), sqlx::Error> {
    let details_json = details.to_string();
    for org_id in org_ids {
        let activity_id: String = sqlx::query_scalar(
            r#"INSERT INTO activity_log
              (org_id, actor_type, actor_id, action, entity_type, entity_id, details)
              VALUES ($1::uuid, 'user', $2, $3, 'user', $2, $4::jsonb)
              RETURNING id::text"#,
        )
        .bind(org_id)
        .bind(user_id)
        .bind(action)
        .bind(&details_json)
        .fetch_one(&mut **transaction)
        .await?;
        let payload = json!({
            "actorType": "user",
            "actorId": user_id,
            "action": action,
            "entityType": "user",
            "entityId": user_id,
            "agentId": null,
            "runId": null,
            "details": details.clone(),
        })
        .to_string();
        sqlx::query(
            r#"INSERT INTO organization_mutation_outbox
              (org_id, activity_id, event_type, payload)
              VALUES ($1::uuid, $2::uuid, 'activity.logged', $3::jsonb)"#,
        )
        .bind(org_id)
        .bind(activity_id)
        .bind(payload)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

pub(super) async fn revoke_key(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    key_id: &str,
    key_hash: &str,
) -> Result<Option<String>, sqlx::Error> {
    let key = sqlx::query_as::<_, (String,)>(
        r#"SELECT id::text FROM board_api_keys
           WHERE id=$1::uuid AND user_id=$2 AND key_hash=$3
             AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at>clock_timestamp())
           FOR UPDATE"#,
    )
    .bind(key_id)
    .bind(user_id)
    .bind(key_hash)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((key_id,)) = key else {
        return Ok(None);
    };
    sqlx::query(
        "UPDATE board_api_keys SET revoked_at=clock_timestamp(), last_used_at=clock_timestamp() WHERE id=$1::uuid AND revoked_at IS NULL",
    )
    .bind(&key_id)
    .execute(&mut **transaction)
    .await?;
    Ok(Some(key_id))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}
