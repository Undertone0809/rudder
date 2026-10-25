//! Resolve public Goal references on the same snapshot as authorization/read.
use sqlx::{Postgres, Row, Transaction};

pub struct ResolvedGoalReference {
    pub goal_id: String,
    pub organization_id: String,
    pub owner_agent_id: Option<String>,
}

pub enum GoalReferenceResolution {
    Missing,
    Ambiguous,
    Resolved(ResolvedGoalReference),
}

fn short_prefix(reference: &str) -> Option<String> {
    let reference = reference.trim();
    let (kind, prefix) = reference.split_once('_')?;
    (kind.eq_ignore_ascii_case("gol")
        && (8..=32).contains(&prefix.len())
        && prefix.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then(|| prefix.to_ascii_lowercase())
}

/// Board callers resolve UUIDs only; typed refs are scoped to an Agent's org.
pub async fn resolve_goal_reference_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    reference: &str,
    agent_organization_id: Option<&str>,
) -> Result<GoalReferenceResolution, sqlx::Error> {
    let rows = if reference.len() == 36 && uuid::Uuid::parse_str(reference).is_ok() {
        sqlx::query(
            "SELECT id::text,org_id::text,owner_agent_id::text FROM goals WHERE id=$1::uuid",
        )
        .bind(reference)
        .fetch_all(&mut **tx)
        .await?
    } else if let (Some(org), Some(prefix)) = (agent_organization_id, short_prefix(reference)) {
        sqlx::query("SELECT id::text,org_id::text,owner_agent_id::text FROM goals WHERE org_id=$1::uuid AND replace(id::text,'-','') LIKE $2 || '%' ORDER BY id LIMIT 2")
            .bind(org)
            .bind(prefix)
            .fetch_all(&mut **tx)
            .await?
    } else {
        return Ok(GoalReferenceResolution::Missing);
    };
    Ok(match rows.as_slice() {
        [] => GoalReferenceResolution::Missing,
        [row] => GoalReferenceResolution::Resolved(ResolvedGoalReference {
            goal_id: row.try_get("id")?,
            organization_id: row.try_get("org_id")?,
            owner_agent_id: row.try_get("owner_agent_id")?,
        }),
        _ => GoalReferenceResolution::Ambiguous,
    })
}

#[cfg(test)]
mod tests {
    use super::short_prefix;

    #[test]
    fn typed_goal_refs_match_the_existing_shared_contract() {
        assert_eq!(short_prefix(" GOL_ABCDEF12 "), Some("abcdef12".into()));
        assert!(short_prefix("agt_abcdef12").is_none());
        assert!(short_prefix("gol_abcdef1").is_none());
        assert!(short_prefix("gol_abcdef1_").is_none());
        assert!(short_prefix(&format!("gol_{}", "a".repeat(33))).is_none());
    }
}
