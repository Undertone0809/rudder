//! Canonical Agent-create skill selection.
//!
//! This module intentionally resolves references from the organization skill
//! catalog while the Agent create transaction is open. It persists only
//! canonical selection keys (`org:<organization_skills.key>`); bundled Rudder
//! skills are validated and omitted because they are always enabled by the
//! runtime. Markdown, file inventories, and other skill payloads never cross
//! this boundary.

use super::{AgentCoreError, AgentCreateRequest, common::*};
use serde_json::Value;
use sqlx::Row;
use std::collections::BTreeSet;

const BUNDLED_SKILL_SLUGS: &[&str] = &[
    "app-builder",
    "para-memory-files",
    "rudder-docs",
    "skill-creator",
    "visualize",
    "browser",
];

#[derive(Clone, Debug)]
struct CatalogSkill {
    id: String,
    key: String,
    slug: String,
    source_type: String,
    source_ref: Option<String>,
    metadata: Value,
}

impl CatalogSkill {
    fn is_bundled(&self) -> bool {
        bundled_key(&self.key).is_some()
            || matches!(
                self.source_type.as_str(),
                "rudder_bundled" | "paperclip_bundled"
            )
            || self
                .metadata
                .get("sourceKind")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "rudder_bundled" | "paperclip_bundled"))
            || self
                .source_ref
                .as_deref()
                .is_some_and(|value| value.starts_with("bundled:"))
    }
}

/// Resolve and persist the desired skill set for a freshly-created Agent.
///
/// Resolution is deliberately SQL scoped by `org_id`; an id/key/slug from a
/// different organization is indistinguishable from an unknown reference and
/// returns 422. The insert also checks the Agent's organization in SQL because
/// `agent_enabled_skills` does not have a composite foreign key.
pub(super) async fn assign_desired_skills(
    tx: &mut Tx<'_>,
    org_id: &str,
    agent_id: &str,
    request: &AgentCreateRequest,
) -> Result<Vec<String>> {
    let requested = normalize_requested_refs(&request.desired_skills);
    if requested.is_empty() {
        return Ok(Vec::new());
    }

    let organization_url_key =
        sqlx::query_scalar::<_, String>("SELECT url_key FROM organizations WHERE id=$1::uuid")
            .bind(org_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| http(422, "Unknown organization"))?;

    let rows = sqlx::query(
        "SELECT id::text AS id,key,slug,source_type,source_ref,COALESCE(metadata,'{}'::jsonb)::text AS metadata
         FROM organization_skills
         WHERE org_id=$1::uuid
         ORDER BY key,id",
    )
    .bind(org_id)
    .fetch_all(&mut **tx)
    .await?;
    let catalog = rows
        .into_iter()
        .map(|row| {
            let metadata = row
                .try_get::<String, _>("metadata")
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            CatalogSkill {
                id: row.try_get("id").unwrap_or_default(),
                key: row.try_get("key").unwrap_or_default(),
                slug: row.try_get("slug").unwrap_or_default(),
                source_type: row.try_get("source_type").unwrap_or_default(),
                source_ref: row.try_get("source_ref").ok(),
                metadata,
            }
        })
        .collect::<Vec<_>>();

    let mut resolved = BTreeSet::new();
    let mut unknown = BTreeSet::new();
    let mut ambiguous = BTreeSet::new();
    for reference in requested {
        match resolve_reference(&catalog, org_id, &organization_url_key, &reference) {
            Resolution::Bundled => {}
            Resolution::Organization(key) => {
                resolved.insert(format!("org:{key}"));
            }
            Resolution::Unknown => {
                unknown.insert(reference);
            }
            Resolution::Ambiguous => {
                ambiguous.insert(reference);
            }
        }
    }

    if !unknown.is_empty() || !ambiguous.is_empty() {
        let mut problems = Vec::new();
        if !ambiguous.is_empty() {
            problems.push(format!(
                "ambiguous references: {}",
                ambiguous.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
        if !unknown.is_empty() {
            problems.push(format!(
                "unknown references: {}",
                unknown.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
        return Err(AgentCoreError::Http(
            422,
            format!("Invalid skill selection ({}).", problems.join("; ")),
            None,
        ));
    }

    let keys = resolved.into_iter().collect::<Vec<_>>();
    if keys.is_empty() {
        return Ok(keys);
    }

    // The organization and Agent scope are enforced by the SELECT itself;
    // callers cannot smuggle a cross-org Agent id into this table.
    sqlx::query(
        "INSERT INTO agent_enabled_skills (org_id,agent_id,skill_key)
         SELECT $1::uuid,a.id,v.skill_key
         FROM agents a
         CROSS JOIN unnest($3::text[]) AS v(skill_key)
         WHERE a.id=$2::uuid AND a.org_id=$1::uuid
         ON CONFLICT (agent_id,skill_key) DO NOTHING",
    )
    .bind(org_id)
    .bind(agent_id)
    .bind(&keys)
    .execute(&mut **tx)
    .await?;

    let persisted = sqlx::query_scalar::<_, String>(
        "SELECT skill_key FROM agent_enabled_skills
         WHERE org_id=$1::uuid AND agent_id=$2::uuid
         ORDER BY skill_key",
    )
    .bind(org_id)
    .bind(agent_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(persisted)
}

#[derive(Debug, Eq, PartialEq)]
enum Resolution {
    Bundled,
    Organization(String),
    Unknown,
    Ambiguous,
}

fn normalize_requested_refs(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| js_trim(value).to_owned())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn normalize_skill_segment(value: &str) -> String {
    slug(value)
}

fn normalize_key(value: &str) -> String {
    value
        .split('/')
        .map(normalize_skill_segment)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn bundled_key(value: &str) -> Option<String> {
    let mut candidate = js_trim(value).to_ascii_lowercase();
    if let Some(rest) = candidate.strip_prefix("bundled:") {
        candidate = rest.trim().to_owned();
    }
    let normalized = normalize_key(&candidate);
    if normalized == "rudder" || normalized == "rudder/rudder" {
        return Some("rudder/rudder-docs".to_owned());
    }
    let slug = if let Some(rest) = normalized.strip_prefix("rudder/rudder/") {
        rest
    } else if let Some(rest) = normalized.strip_prefix("rudder/") {
        rest
    } else if normalized == "rudder-docs" {
        "rudder-docs"
    } else {
        return None;
    };
    BUNDLED_SKILL_SLUGS
        .contains(&slug)
        .then(|| format!("rudder/{slug}"))
}

fn explicit_bundled(value: &str) -> bool {
    let trimmed = js_trim(value).to_ascii_lowercase();
    trimmed.starts_with("bundled:") || trimmed == "rudder" || trimmed.starts_with("rudder/")
}

fn resolve_reference(
    catalog: &[CatalogSkill],
    org_id: &str,
    organization_url_key: &str,
    reference: &str,
) -> Resolution {
    if let Some(key) = bundled_key(reference) {
        let _ = key;
        return Resolution::Bundled;
    }
    if explicit_bundled(reference) {
        // A bundled prefix is never allowed to resolve to an organization
        // skill with the same name: unknown bundled refs remain 422.
        return Resolution::Unknown;
    }

    let trimmed = js_trim(reference);
    let lowered = trimmed.to_ascii_lowercase();
    let org_reference = lowered
        .strip_prefix("org:")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let candidate = org_reference.unwrap_or(trimmed);
    let normalized_candidate = normalize_key(candidate);

    if let Some(skill) = catalog.iter().find(|skill| skill.id == trimmed) {
        return if skill.is_bundled() {
            Resolution::Bundled
        } else {
            Resolution::Organization(skill.key.clone())
        };
    }

    if let Some(skill) = catalog.iter().find(|skill| {
        normalize_key(&skill.key) == normalized_candidate
            || (org_reference.is_some() && skill.key == candidate)
    }) {
        return if skill.is_bundled() {
            Resolution::Bundled
        } else {
            Resolution::Organization(skill.key.clone())
        };
    }

    // Public references use org/<organization-url-key>/<slug> or
    // organization/<organization-id>/<slug>. An org URL key from another
    // organization is rejected before the slug lookup.
    let segments = normalized_candidate.split('/').collect::<Vec<_>>();
    let slug_candidate = match segments.as_slice() {
        ["org", org_key, slug] if *org_key == normalize_key(organization_url_key) => Some(*slug),
        ["organization", org_key, slug] if *org_key == normalize_key(org_id) => Some(*slug),
        ["organization", org_key, slug] if *org_key == normalize_key(organization_url_key) => {
            Some(*slug)
        }
        [slug] => Some(*slug),
        _ => None,
    };
    let Some(slug_candidate) = slug_candidate else {
        return Resolution::Unknown;
    };
    let matches = catalog
        .iter()
        .filter(|skill| normalize_skill_segment(&skill.slug) == slug_candidate)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [skill] => {
            if skill.is_bundled() {
                Resolution::Bundled
            } else {
                Resolution::Organization(skill.key.clone())
            }
        }
        [] => Resolution::Unknown,
        _ => Resolution::Ambiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(key: &str, slug: &str, source_type: &str) -> CatalogSkill {
        CatalogSkill {
            id: format!("id-{slug}"),
            key: key.into(),
            slug: slug.into(),
            source_type: source_type.into(),
            source_ref: None,
            metadata: serde_json::json!({}),
        }
    }

    #[test]
    fn bundled_aliases_are_always_enabled() {
        let catalog = vec![skill("rudder/browser", "browser", "catalog")];
        for reference in ["rudder/browser", "bundled:rudder/browser", "browser"] {
            assert_eq!(
                resolve_reference(&catalog, "org-1", "acme", reference),
                Resolution::Bundled,
                "{reference}"
            );
        }
    }

    #[test]
    fn organization_refs_are_canonicalized_and_ambiguous_refs_rejected() {
        let catalog = vec![
            skill("organization/org-1/alpha", "alpha", "local_path"),
            skill("organization/org-1/beta", "beta", "local_path"),
            skill("organization/org-1/beta-copy", "beta", "local_path"),
        ];
        assert_eq!(
            resolve_reference(&catalog, "org-1", "acme", "org:organization/org-1/alpha"),
            Resolution::Organization("organization/org-1/alpha".into())
        );
        assert_eq!(
            resolve_reference(&catalog, "org-1", "acme", "org/acme/alpha"),
            Resolution::Organization("organization/org-1/alpha".into())
        );
        assert_eq!(
            resolve_reference(&catalog, "org-1", "acme", "beta"),
            Resolution::Ambiguous
        );
    }

    #[test]
    fn cross_org_public_refs_do_not_match_local_slugs() {
        let catalog = vec![skill("organization/org-1/alpha", "alpha", "local_path")];
        assert_eq!(
            resolve_reference(&catalog, "org-1", "acme", "org/other/alpha"),
            Resolution::Unknown
        );
    }
}
