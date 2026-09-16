use crate::{Actor, ActorSource, AuthError, JwtConfig, TrustedActor};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};

type Tx<'a> = Transaction<'a, Postgres>;

#[derive(Clone)]
pub struct BearerAuthenticator {
    pool: PgPool,
    jwt: Option<JwtConfig>,
}
impl BearerAuthenticator {
    pub fn new(pool: PgPool, jwt: Option<JwtConfig>) -> Self {
        Self { pool, jwt }
    }

    /// Bearer-only resolution. Missing session/local-mode integration does not
    /// silently become an administrator. Credential bytes never enter SQL.
    pub async fn authenticate(
        &self,
        token: Option<&str>,
        run: Option<&str>,
    ) -> Result<TrustedActor, AuthError> {
        let Some(token) = token else {
            return Ok(TrustedActor::anonymous(run));
        };
        if token.is_empty() || token.len() > 16_384 || token.contains('\0') {
            return Ok(TrustedActor::anonymous(None));
        }
        let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','15s',true),set_config('idle_in_transaction_session_timeout','30s',true)")
            .execute(&mut *tx).await?;
        let result = self.resolve(&mut tx, token, &hash, run).await;
        match result {
            Ok(actor) => {
                tx.commit().await?;
                Ok(actor)
            }
            Err(error) => {
                let _ = tx.rollback().await;
                Err(error.into())
            }
        }
    }

    async fn resolve(
        &self,
        tx: &mut Tx<'_>,
        token: &str,
        hash: &str,
        run: Option<&str>,
    ) -> Result<TrustedActor, sqlx::Error> {
        if let Some(actor) = board(tx, hash, run).await? {
            return Ok(actor);
        }
        if let Some(actor) = agent_key(tx, hash, run).await? {
            return Ok(actor);
        }
        let Some(claims) = self.jwt.as_ref().and_then(|config| config.verify(token)) else {
            return Ok(TrustedActor::anonymous(None));
        };
        let record =
            sqlx::query("SELECT org_id::text,status FROM agents WHERE id=$1::uuid FOR SHARE")
                .bind(&claims.agent)
                .fetch_optional(&mut **tx)
                .await?;
        let Some(record) = record else {
            return Ok(TrustedActor::anonymous(None));
        };
        let org: String = record.try_get("org_id")?;
        let status: String = record.try_get("status")?;
        if org != claims.org || inactive(&status) {
            return Ok(TrustedActor::anonymous(None));
        }
        Ok(TrustedActor(Actor::Agent {
            agent_id: claims.agent,
            org_id: claims.org,
            key_id: None,
            run_id: Some(claims.run),
            adapter_type: Some(claims.adapter),
            source: ActorSource::AgentJwt,
        }))
    }
}

async fn board(
    tx: &mut Tx<'_>,
    hash: &str,
    run: Option<&str>,
) -> Result<Option<TrustedActor>, sqlx::Error> {
    let key=sqlx::query("SELECT id::text,user_id FROM board_api_keys WHERE key_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())")
        .bind(hash).fetch_optional(&mut **tx).await?;
    let Some(key) = key else {
        return Ok(None);
    };
    let user: String = key.try_get("user_id")?;
    let id: String = key.try_get("id")?;
    // User lock precedes the key lock, matching deletion's cascading order.
    let exists = sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR SHARE")
        .bind(&user)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_none() {
        return Ok(None);
    }
    let changed=sqlx::query("UPDATE board_api_keys SET last_used_at=clock_timestamp() WHERE id=$1::uuid AND user_id=$2 AND key_hash=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())")
        .bind(&id).bind(&user).bind(hash).execute(&mut **tx).await?;
    if changed.rows_affected() != 1 {
        return Ok(Some(TrustedActor::anonymous(None)));
    }
    let orgs:Vec<String>=sqlx::query_scalar("SELECT org_id::text FROM organization_memberships WHERE principal_type='user' AND principal_id=$1 AND status='active' ORDER BY org_id")
        .bind(&user).fetch_all(&mut **tx).await?;
    let admin:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')")
        .bind(&user).fetch_one(&mut **tx).await?;
    Ok(Some(TrustedActor(Actor::Board {
        user_id: user,
        org_ids: orgs,
        is_instance_admin: admin,
        key_id: id,
        run_id: run.map(str::to_owned),
        source: ActorSource::BoardKey,
    })))
}

async fn agent_key(
    tx: &mut Tx<'_>,
    hash: &str,
    run: Option<&str>,
) -> Result<Option<TrustedActor>, sqlx::Error> {
    let candidates=sqlx::query("SELECT id::text,org_id::text,agent_id::text FROM agent_api_keys WHERE key_hash=$1 AND revoked_at IS NULL LIMIT 2")
        .bind(hash).fetch_all(&mut **tx).await?;
    if candidates.is_empty() {
        return Ok(None);
    }
    // Corrupt duplicated or cross-organization keys never choose an identity.
    if candidates.len() != 1 {
        return Ok(Some(TrustedActor::anonymous(None)));
    }
    let key = &candidates[0];
    let id: String = key.try_get("id")?;
    let org: String = key.try_get("org_id")?;
    let agent: String = key.try_get("agent_id")?;
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM agents WHERE id=$1::uuid AND org_id=$2::uuid FOR SHARE",
    )
    .bind(&agent)
    .bind(&org)
    .fetch_optional(&mut **tx)
    .await?;
    if status.as_deref().is_none_or(inactive) {
        return Ok(Some(TrustedActor::anonymous(None)));
    }
    let changed=sqlx::query("UPDATE agent_api_keys SET last_used_at=clock_timestamp() WHERE id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid AND key_hash=$4 AND revoked_at IS NULL")
        .bind(&id).bind(&org).bind(&agent).bind(hash).execute(&mut **tx).await?;
    if changed.rows_affected() != 1 {
        return Ok(Some(TrustedActor::anonymous(None)));
    }
    Ok(Some(TrustedActor(Actor::Agent {
        agent_id: agent,
        org_id: org,
        key_id: Some(id),
        run_id: run.map(str::to_owned),
        adapter_type: None,
        source: ActorSource::AgentKey,
    })))
}

fn inactive(status: &str) -> bool {
    matches!(status, "terminated" | "pending_approval")
}
// End of transaction-connected bearer resolution.
