//! Canonical Agent-create skill selection.
//!
//! This module resolves organization selections from the org-scoped database
//! catalog and global/adapter selections from their configured local skill
//! roots while the Agent create transaction is open. It persists only
//! canonical selection keys (`org:<key>`, `global:<slug>`, or
//! `adapter:<runtime>:<slug>`); bundled Rudder skills are validated and
//! omitted because they are always enabled by the runtime. Markdown, file
//! inventories, and other skill payloads never cross this boundary.

use super::{AgentCoreError, AgentCreateRequest, common::*};
use serde_json::Value;
use sqlx::Row;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

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

#[derive(Clone, Debug, Eq, PartialEq)]
struct FilesystemSkill {
    selection_key: String,
    slug: String,
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
    runtime_config: &Value,
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
    let filesystem_catalog =
        discover_filesystem_skills_with_secrets(tx, org_id, runtime_config).await?;

    let mut resolved = BTreeSet::new();
    let mut unknown = BTreeSet::new();
    let mut ambiguous = BTreeSet::new();
    let mut selections_by_slug = BTreeMap::<String, BTreeSet<String>>::new();
    for reference in requested {
        match resolve_create_reference(
            &catalog,
            &filesystem_catalog,
            org_id,
            &organization_url_key,
            &request.agent_runtime_type,
            &reference,
        ) {
            CreateResolution::Bundled => {}
            CreateResolution::Selection {
                selection_key,
                slug,
            } => {
                selections_by_slug
                    .entry(slug)
                    .or_default()
                    .insert(selection_key.clone());
                resolved.insert(selection_key);
            }
            CreateResolution::Unknown => {
                unknown.insert(reference);
            }
            CreateResolution::Ambiguous => {
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

    let conflicts = selections_by_slug
        .into_iter()
        .filter_map(|(slug, selection_keys)| {
            (selection_keys.len() > 1).then(|| {
                format!(
                    "{slug}: {}",
                    selection_keys.into_iter().collect::<Vec<_>>().join(", ")
                )
            })
        })
        .collect::<Vec<_>>();
    if !conflicts.is_empty() {
        return Err(AgentCoreError::Http(
            422,
            format!(
                "Invalid skill selection (conflicting skill names: {}).",
                conflicts.join("; ")
            ),
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
enum CreateResolution {
    Bundled,
    Selection { selection_key: String, slug: String },
    Unknown,
    Ambiguous,
}

fn resolve_create_reference(
    catalog: &[CatalogSkill],
    filesystem_catalog: &[FilesystemSkill],
    org_id: &str,
    organization_url_key: &str,
    agent_runtime_type: &str,
    reference: &str,
) -> CreateResolution {
    let reference = js_trim(reference);
    if is_retired_creation_skill_reference(reference) {
        return CreateResolution::Unknown;
    }

    if reference.starts_with("global:") {
        return exact_filesystem_selection(filesystem_catalog, reference);
    }
    if reference.starts_with("adapter:") {
        return exact_filesystem_selection(filesystem_catalog, reference);
    }
    if reference.starts_with("agent:") {
        // A new Agent has no AGENT_HOME catalog yet, matching the Node create
        // resolver's empty agent-home entries for id:null.
        return CreateResolution::Unknown;
    }

    match resolve_reference(catalog, org_id, organization_url_key, reference) {
        Resolution::Bundled => return CreateResolution::Bundled,
        Resolution::Organization(key) => {
            let slug = catalog
                .iter()
                .find(|skill| skill.key == key)
                .map(|skill| normalize_skill_segment(&skill.slug))
                .unwrap_or_else(|| normalize_skill_segment(key.rsplit('/').next().unwrap_or(&key)));
            return CreateResolution::Selection {
                selection_key: format!("org:{key}"),
                slug,
            };
        }
        Resolution::Ambiguous => return CreateResolution::Ambiguous,
        Resolution::Unknown => {}
    }

    // Explicit organization references never turn into filesystem references
    // just because an external skill happens to use a similar name.
    let lowered = reference.to_ascii_lowercase();
    if lowered.starts_with("org:")
        || lowered.starts_with("org/")
        || lowered.starts_with("organization/")
        || explicit_bundled(reference)
    {
        return CreateResolution::Unknown;
    }

    let slug = normalize_skill_segment(reference);
    if slug.is_empty() {
        return CreateResolution::Unknown;
    }

    // Node first resolves an untyped name to the current adapter's selection
    // key. Only when that key is absent does it search all external catalogs,
    // where multiple source matches are an ambiguity.
    let current_adapter_key = format!("adapter:{agent_runtime_type}:{slug}");
    if let Some(skill) = filesystem_catalog
        .iter()
        .find(|skill| skill.selection_key == current_adapter_key)
    {
        return CreateResolution::Selection {
            selection_key: skill.selection_key.clone(),
            slug: skill.slug.clone(),
        };
    }

    let matches = filesystem_catalog
        .iter()
        .filter(|skill| skill.slug == slug)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [skill] => CreateResolution::Selection {
            selection_key: skill.selection_key.clone(),
            slug: skill.slug.clone(),
        },
        [] => CreateResolution::Unknown,
        _ => CreateResolution::Ambiguous,
    }
}

fn exact_filesystem_selection(
    filesystem_catalog: &[FilesystemSkill],
    selection_key: &str,
) -> CreateResolution {
    filesystem_catalog
        .iter()
        .find(|skill| skill.selection_key == selection_key)
        .map(|skill| CreateResolution::Selection {
            selection_key: skill.selection_key.clone(),
            slug: skill.slug.clone(),
        })
        .unwrap_or(CreateResolution::Unknown)
}

fn is_retired_creation_skill_reference(reference: &str) -> bool {
    let normalized = reference.to_ascii_lowercase();
    let value = normalized.strip_prefix("bundled:").unwrap_or(&normalized);
    let segments = value
        .split('/')
        .map(normalize_skill_segment)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let slug = match segments.as_slice() {
        [slug] => slug.as_str(),
        [prefix, slug] if prefix == "rudder" => slug.as_str(),
        [first, second, slug] if first == "rudder" && second == "rudder" => slug.as_str(),
        _ => return false,
    };
    matches!(slug, "rudder-create-agent" | "rudder-create-plugin")
}

async fn discover_filesystem_skills_with_secrets(
    tx: &mut Tx<'_>,
    org_id: &str,
    runtime_config: &Value,
) -> Result<Vec<FilesystemSkill>> {
    let mut resolved_config = runtime_config.clone();
    let mut resolved_env = resolved_config
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in ["HOME", "CODEX_HOME"] {
        let Some(binding) = resolved_env.get(key) else {
            continue;
        };
        if binding.get("type").and_then(Value::as_str) != Some("secret_ref") {
            continue;
        }
        if let Some(path) = resolve_configured_path(tx, org_id, binding).await? {
            resolved_env.insert(
                key.to_owned(),
                serde_json::json!({"type":"plain","value":path.to_string_lossy()}),
            );
        }
    }
    if resolved_config.is_object() {
        resolved_config
            .as_object_mut()
            .expect("object checked")
            .insert("env".to_owned(), Value::Object(resolved_env));
    }
    Ok(discover_filesystem_skills(&resolved_config))
}

fn discover_filesystem_skills(runtime_config: &Value) -> Vec<FilesystemSkill> {
    let home = configured_home(runtime_config);
    let codex_home =
        configured_plain_path(runtime_config, "CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    let roots = [
        ("global", home.join(".agents").join("skills")),
        ("adapter:claude_local", home.join(".claude").join("skills")),
        (
            "adapter:opencode_local",
            home.join(".claude").join("skills"),
        ),
        ("adapter:codex_local", codex_home.join("skills")),
        ("adapter:cursor", home.join(".cursor").join("skills")),
        (
            "adapter:pi_local",
            home.join(".pi").join("agent").join("skills"),
        ),
    ];
    let mut skills = BTreeMap::<String, String>::new();
    for (selection_prefix, root) in roots {
        discover_skill_root(&root, selection_prefix, &mut skills);
    }
    skills
        .into_iter()
        .map(|(selection_key, slug)| FilesystemSkill {
            selection_key,
            slug,
        })
        .collect()
}

fn configured_home(runtime_config: &Value) -> PathBuf {
    configured_plain_path(runtime_config, "HOME").unwrap_or_else(default_home)
}

fn configured_plain_path(runtime_config: &Value, key: &str) -> Option<PathBuf> {
    let env = runtime_config.get("env")?.as_object()?;
    let binding = env.get(key)?;
    let value = binding.as_str().or_else(|| {
        (binding.get("type").and_then(Value::as_str) == Some("plain"))
            .then(|| binding.get("value").and_then(Value::as_str))
            .flatten()
    })?;
    let value = js_trim(value);
    (!value.is_empty()).then(|| resolve_from_process_directory(value))
}

async fn resolve_configured_path(
    tx: &mut Tx<'_>,
    org_id: &str,
    binding: &Value,
) -> Result<Option<PathBuf>> {
    let value = match binding {
        Value::String(value) => Some(value.clone()),
        Value::Object(object) if object.get("type").and_then(Value::as_str) == Some("plain") => {
            object
                .get("value")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        Value::Object(object)
            if object.get("type").and_then(Value::as_str) == Some("secret_ref") =>
        {
            crate::secrets::resolve_local_runtime_secret_reference(
                tx,
                org_id,
                &Value::Object(object.clone()),
            )
            .await
            .map_err(|error| match error {
                crate::secrets::SecretsError::Http(status, message) => http(status, message),
                crate::secrets::SecretsError::Database(error) => AgentCoreError::Database(error),
            })?
            .ok_or_else(|| http(503, "Secret provider unavailable"))?
            .into()
        }
        _ => None,
    };
    Ok(value
        .as_deref()
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(resolve_from_process_directory))
}

fn resolve_from_process_directory(value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn default_home() -> PathBuf {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    home.map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn discover_skill_root(root: &Path, selection_prefix: &str, skills: &mut BTreeMap<String, String>) {
    for candidate_root in [root.to_path_buf(), root.join("skills")] {
        if !fs::metadata(&candidate_root).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&candidate_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Node's Dirent.isDirectory() excludes symlink directories. Keep
            // the same boundary while allowing SKILL.md itself to be a file
            // symlink, as its stat-based check does.
            if !file_type.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let slug = normalize_skill_segment(&name);
            if slug.is_empty()
                || !fs::metadata(entry.path().join("SKILL.md"))
                    .is_ok_and(|metadata| metadata.is_file())
            {
                continue;
            }
            let selection_key = if selection_prefix == "global" {
                format!("global:{slug}")
            } else {
                format!("{selection_prefix}:{slug}")
            };
            skills.entry(selection_key).or_insert(slug);
        }
    }
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

fn catalog_bundled_match<'a>(
    catalog: &'a [CatalogSkill],
    canonical_key: &str,
) -> Option<&'a CatalogSkill> {
    let canonical_slug = canonical_key.rsplit('/').next().unwrap_or_default();
    catalog.iter().find(|skill| {
        bundled_key(&skill.key).as_deref() == Some(canonical_key)
            || normalize_key(&skill.key) == canonical_key
            || (skill.is_bundled() && normalize_skill_segment(&skill.slug) == canonical_slug)
    })
}

fn resolve_reference(
    catalog: &[CatalogSkill],
    org_id: &str,
    organization_url_key: &str,
    reference: &str,
) -> Resolution {
    if let Some(key) = bundled_key(reference) {
        return if catalog_bundled_match(catalog, &key).is_some() {
            Resolution::Bundled
        } else {
            Resolution::Unknown
        };
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
    fn bundled_reference_requires_a_catalog_entry() {
        assert_eq!(
            resolve_reference(&[], "org-1", "acme", "rudder/browser"),
            Resolution::Unknown
        );
        assert_eq!(
            resolve_reference(&[], "org-1", "acme", "bundled:rudder/browser"),
            Resolution::Unknown
        );
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

    fn add_skill(root: &Path, relative: &str, contents: &str) {
        let skill_file = root.join(relative).join("SKILL.md");
        fs::create_dir_all(skill_file.parent().unwrap()).unwrap();
        fs::write(skill_file, contents).unwrap();
    }

    #[test]
    fn filesystem_catalog_matches_global_and_adapter_skill_roots() {
        let home = tempfile::tempdir().unwrap();
        add_skill(home.path(), ".agents/skills/release notes", "global");
        add_skill(home.path(), ".agents/skills/skills/one-level", "nested");
        add_skill(home.path(), ".claude/skills/reviewer", "claude");
        add_skill(home.path(), ".codex/skills/codex-review", "codex");
        add_skill(home.path(), ".cursor/skills/cursor-review", "cursor");
        add_skill(home.path(), ".pi/agent/skills/pi-review", "pi");
        fs::create_dir_all(home.path().join(".agents/skills/no-markdown")).unwrap();

        let config = serde_json::json!({
            "env": {
                "HOME": {"type":"plain", "value":home.path()},
                "CODEX_HOME": {"type":"plain", "value":home.path().join(".codex")},
            }
        });
        let catalog = discover_filesystem_skills(&config);
        let keys = catalog
            .iter()
            .map(|skill| skill.selection_key.as_str())
            .collect::<BTreeSet<_>>();
        assert!(keys.contains("global:release-notes"));
        assert!(keys.contains("global:one-level"));
        assert!(keys.contains("adapter:claude_local:reviewer"));
        assert!(keys.contains("adapter:opencode_local:reviewer"));
        assert!(keys.contains("adapter:codex_local:codex-review"));
        assert!(keys.contains("adapter:cursor:cursor-review"));
        assert!(keys.contains("adapter:pi_local:pi-review"));
        assert!(!keys.iter().any(|key| key.ends_with("no-markdown")));
    }

    #[test]
    fn create_selection_uses_exact_typed_refs_and_node_bare_name_precedence() {
        let home = tempfile::tempdir().unwrap();
        add_skill(home.path(), ".agents/skills/reviewer", "global");
        add_skill(home.path(), ".claude/skills/reviewer", "adapter");
        add_skill(home.path(), ".agents/skills/unique", "global");
        let config = serde_json::json!({
            "env":{"HOME":{"type":"plain","value":home.path()}}
        });
        let filesystem = discover_filesystem_skills(&config);
        let org_catalog = vec![skill(
            "organization/org-1/reviewer",
            "reviewer",
            "local_path",
        )];

        assert_eq!(
            resolve_create_reference(
                &org_catalog,
                &filesystem,
                "org-1",
                "acme",
                "claude_local",
                "global:reviewer"
            ),
            CreateResolution::Selection {
                selection_key: "global:reviewer".into(),
                slug: "reviewer".into()
            }
        );
        assert_eq!(
            resolve_create_reference(
                &org_catalog,
                &filesystem,
                "org-1",
                "acme",
                "claude_local",
                "adapter:claude_local:reviewer"
            ),
            CreateResolution::Selection {
                selection_key: "adapter:claude_local:reviewer".into(),
                slug: "reviewer".into()
            }
        );
        assert_eq!(
            resolve_create_reference(
                &org_catalog,
                &filesystem,
                "org-1",
                "acme",
                "claude_local",
                "reviewer"
            ),
            CreateResolution::Selection {
                selection_key: "org:organization/org-1/reviewer".into(),
                slug: "reviewer".into()
            }
        );
        assert_eq!(
            resolve_create_reference(&[], &filesystem, "org-1", "acme", "process", "unique"),
            CreateResolution::Selection {
                selection_key: "global:unique".into(),
                slug: "unique".into()
            }
        );
        assert_eq!(
            resolve_create_reference(&[], &filesystem, "org-1", "acme", "process", "reviewer"),
            CreateResolution::Ambiguous
        );
        assert_eq!(
            resolve_create_reference(
                &[],
                &filesystem,
                "org-1",
                "acme",
                "process",
                "agent:reviewer"
            ),
            CreateResolution::Unknown
        );
        assert_eq!(
            resolve_create_reference(
                &[],
                &filesystem,
                "org-1",
                "acme",
                "process",
                "global:missing"
            ),
            CreateResolution::Unknown
        );
    }
}
