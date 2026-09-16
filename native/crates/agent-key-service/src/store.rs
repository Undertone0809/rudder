use crate::{AgentIdentity, BoardGrant, IssuedKey, KeyError, KeyMetadata, validate_uuid};
use rand::{RngCore, rngs::OsRng};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};

type Tx<'a> = Transaction<'a, Postgres>;
const COLUMNS: &str = "id::text,name,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,to_char(revoked_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS revoked_at";

#[derive(Clone)]
pub struct AgentKeyStore {
    pool: PgPool,
}
impl AgentKeyStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create(
        &self,
        grant: &BoardGrant,
        agent: &str,
        name: &str,
    ) -> Result<IssuedKey, KeyError> {
        validate_uuid(agent)?;
        if name.is_empty() || name.contains('\0') {
            return Err(KeyError::InvalidInput);
        }
        let mut tx = begin(&self.pool).await?;
        let result = create_in(&mut tx, grant, agent, name).await;
        finish(tx, result).await
    }

    pub async fn list(
        &self,
        grant: &BoardGrant,
        agent: &str,
    ) -> Result<Vec<KeyMetadata>, KeyError> {
        validate_uuid(agent)?;
        let mut tx = begin(&self.pool).await?;
        let result = async {
            lock_agent(&mut tx, grant, agent).await?;
            let statement = format!("SELECT {COLUMNS} FROM agent_api_keys WHERE org_id=$1::uuid AND agent_id=$2::uuid ORDER BY created_at,id");
            sqlx::query(&statement)
                .bind(&grant.org_id).bind(agent)
                .fetch_all(&mut *tx).await?
                .into_iter().map(metadata).collect()
        }.await;
        finish(tx, result).await
    }

    pub async fn revoke(&self, grant: &BoardGrant, agent: &str, key: &str) -> Result<(), KeyError> {
        validate_uuid(agent)?;
        validate_uuid(key)?;
        let mut tx = begin(&self.pool).await?;
        let result = async {
            lock_agent(&mut tx, grant, agent).await?;
            let changed = sqlx::query("UPDATE agent_api_keys SET revoked_at=now() WHERE org_id=$1::uuid AND agent_id=$2::uuid AND id=$3::uuid")
                .bind(&grant.org_id).bind(agent).bind(key).execute(&mut *tx).await?;
            if changed.rows_affected() != 1 {
                return Err(KeyError::KeyNotFound);
            }
            audit(&mut tx, grant, agent, "agent.key_revoked", json!({"keyId":key})).await
        }.await;
        finish(tx, result).await
    }

    /// Resolve only same-organization key/Agent pairs and update usage atomically.
    /// Plaintext is never bound into a database query or an audit record.
    pub async fn authenticate(&self, token: &str) -> Result<Option<AgentIdentity>, KeyError> {
        if token.is_empty() || token.len() > 16_384 || token.contains('\0') {
            return Ok(None);
        }
        let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
        let mut tx = begin(&self.pool).await?;
        let result = authenticate_in(&mut tx, &hash).await;
        finish(tx, result).await
    }
}

async fn create_in(
    tx: &mut Tx<'_>,
    grant: &BoardGrant,
    agent: &str,
    name: &str,
) -> Result<IssuedKey, KeyError> {
    let status = lock_agent(tx, grant, agent).await?;
    match status.as_str() {
        "pending_approval" => return Err(KeyError::PendingApproval),
        "terminated" => return Err(KeyError::Terminated),
        _ => {}
    }
    let mut entropy = [0_u8; 24];
    OsRng
        .try_fill_bytes(&mut entropy)
        .map_err(|_| KeyError::Entropy)?;
    let token = format!(
        "pcp_{}",
        entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let statement = format!(
        "INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,$3,$4) RETURNING {COLUMNS}"
    );
    let record = sqlx::query(&statement)
        .bind(&grant.org_id)
        .bind(agent)
        .bind(name)
        .bind(hash)
        .fetch_one(&mut **tx)
        .await?;
    let key = metadata(record)?;
    audit(
        tx,
        grant,
        agent,
        "agent.key_created",
        json!({"keyId":key.id,"name":key.name}),
    )
    .await?;
    Ok(IssuedKey {
        id: key.id,
        name: key.name,
        token,
        created_at: key.created_at,
    })
}

async fn lock_agent(tx: &mut Tx<'_>, grant: &BoardGrant, agent: &str) -> Result<String, KeyError> {
    // All business writers take organization, Agent, then key locks in this order.
    let exists = sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(&grant.org_id)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_none() {
        return Err(KeyError::AgentNotFound);
    }
    sqlx::query_scalar("SELECT status FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&grant.org_id)
        .bind(agent)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(KeyError::AgentNotFound)
}

async fn authenticate_in(tx: &mut Tx<'_>, hash: &str) -> Result<Option<AgentIdentity>, KeyError> {
    let candidates = sqlx::query("SELECT id::text,org_id::text,agent_id::text FROM agent_api_keys WHERE key_hash=$1 AND revoked_at IS NULL LIMIT 2")
        .bind(hash).fetch_all(&mut **tx).await?;
    // A corrupt duplicate credential must not select an arbitrary identity.
    if candidates.len() != 1 {
        return Ok(None);
    }
    let key = &candidates[0];
    let org: String = key.try_get("org_id")?;
    let agent: String = key.try_get("agent_id")?;
    let id: String = key.try_get("id")?;
    let row = sqlx::query(
        "SELECT role,status FROM agents WHERE id=$1::uuid AND org_id=$2::uuid FOR SHARE",
    )
    .bind(&agent)
    .bind(&org)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let status: String = row.try_get("status")?;
    if matches!(status.as_str(), "terminated" | "pending_approval") {
        return Ok(None);
    }
    // This lock follows the Agent lock and serializes usage against revocation.
    let updated = sqlx::query("UPDATE agent_api_keys SET last_used_at=now() WHERE id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid AND key_hash=$4 AND revoked_at IS NULL")
        .bind(&id).bind(&org).bind(&agent).bind(hash).execute(&mut **tx).await?;
    if updated.rows_affected() != 1 {
        return Ok(None);
    }
    Ok(Some(AgentIdentity {
        org_id: org,
        agent_id: agent,
        role: row.try_get("role")?,
    }))
}

async fn audit(
    tx: &mut Tx<'_>,
    grant: &BoardGrant,
    agent: &str,
    action: &str,
    details: serde_json::Value,
) -> Result<(), KeyError> {
    sqlx::query("INSERT INTO activity_log(org_id,actor_type,actor_id,action,entity_type,entity_id,details) VALUES($1::uuid,'user',$2,$3,'agent',$4,$5::jsonb)")
        .bind(&grant.org_id).bind(&grant.principal_id).bind(action).bind(agent)
        .bind(details.to_string()).execute(&mut **tx).await?;
    Ok(())
}

fn metadata(row: PgRow) -> Result<KeyMetadata, KeyError> {
    Ok(KeyMetadata {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        created_at: row.try_get("created_at")?,
        revoked_at: row.try_get("revoked_at")?,
    })
}
async fn begin(pool: &PgPool) -> Result<Tx<'static>, KeyError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','15s',true),set_config('idle_in_transaction_session_timeout','30s',true)")
        .execute(&mut *tx).await?;
    Ok(tx)
}
async fn finish<T>(tx: Tx<'_>, result: Result<T, KeyError>) -> Result<T, KeyError> {
    match result {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}
