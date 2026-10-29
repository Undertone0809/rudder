//! Existing catalog/bootstrap and selected package restoration. Sources and
//! selection keys follow organization-skills; no package installer or Node
//! runtime is invoked by this backend path.
use super::{
    AgentRunContextHost, ContextError, ContextLogSink,
    artifacts::{InvocationArtifacts, private_write},
    text,
};
use rudder_d1_persistence::{
    agent_execution::AgentRunClaim,
    agent_run_context::{self, AgentRunResources},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub(super) fn bundled_catalog(host: &AgentRunContextHost) -> Result<Vec<Value>, ContextError> {
    let Some(root) = host.bundled_skills_root.as_deref() else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for slug in [
        "app-builder",
        "para-memory-files",
        "rudder-docs",
        "skill-creator",
        "visualize",
        "browser",
    ] {
        let source = root.join(slug);
        let path = source.join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let markdown = fs::read_to_string(&path)?;
        let name = frontmatter(&markdown, "name").unwrap_or_else(|| slug.into());
        let description = frontmatter(&markdown, "description");
        let mut inventory = Vec::new();
        inventory_tree(&source, &source, &mut inventory, &mut BTreeSet::new())?;
        rows.push(json!({"key":format!("rudder/{slug}"),"slug":slug,"name":name,"description":description,
            "markdown":markdown,"sourceType":"local_path","sourceLocator":source,"sourceRef":null,
            "fileInventory":inventory,"metadata":{"sourceKind":"rudder_bundled","skillKey":format!("rudder/{slug}")}}));
    }
    Ok(rows)
}
fn frontmatter(markdown: &str, key: &str) -> Option<String> {
    let header = markdown.strip_prefix("---\n")?.split("\n---").next()?;
    header
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{key}:")))
        .map(|value| value.trim().trim_matches(['\'', '"']).to_owned())
        .filter(|s| !s.is_empty())
}
fn inventory_tree(
    root: &Path,
    dir: &Path,
    out: &mut Vec<Value>,
    visited: &mut BTreeSet<PathBuf>,
) -> Result<(), ContextError> {
    let canonical = dir.canonicalize()?;
    if !visited.insert(canonical.clone()) {
        return Err(ContextError::Invalid(
            "Skill source contains a directory cycle",
        ));
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            inventory_tree(root, &path, out, visited)?;
        } else if path.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| ContextError::Invalid("Invalid skill file"))?
                .to_string_lossy()
                .replace('\\', "/");
            out.push(json!({"path":relative,"kind":if relative=="SKILL.md" {"skill"} else if relative.ends_with(".md") {"reference"} else {"asset"}}));
        }
    }
    visited.remove(&canonical);
    out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(())
}

pub(super) async fn restore_selected_packages(
    pool: &PgPool,
    claim: &AgentRunClaim,
    resources: &mut AgentRunResources,
    organization_root: &Path,
    artifacts: &InvocationArtifacts,
    cancelled: &Arc<AtomicBool>,
    output: &ContextLogSink,
) -> Result<(), ContextError> {
    let mut skipped = BTreeSet::new();
    for skill in &mut resources.skills {
        let Some(key) = text(skill, "key").map(str::to_owned) else {
            continue;
        };
        if !resources.enabled_skill_keys.contains(&format!("org:{key}")) {
            continue;
        }
        match restore_skill(
            pool,
            claim,
            skill,
            &key,
            organization_root,
            artifacts,
            cancelled,
        )
        .await
        {
            Ok(()) => (),
            Err(error @ (ContextError::Cancelled | ContextError::Database(_))) => {
                return Err(error);
            }
            Err(_) => {
                skipped.insert(key);
                output.log("skills","stderr","[rudder] Selected skill package could not be restored; omitted for this invocation and will be retried next run.\n").await;
            }
        }
    }
    resources
        .skills
        .retain(|skill| !text(skill, "key").is_some_and(|key| skipped.contains(key)));
    resources.enabled_skill_keys.retain(|key| {
        !key.strip_prefix("org:")
            .is_some_and(|key| skipped.contains(key))
    });
    Ok(())
}
async fn restore_skill(
    pool: &PgPool,
    claim: &AgentRunClaim,
    skill: &mut Value,
    key: &str,
    organization_root: &Path,
    artifacts: &InvocationArtifacts,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), ContextError> {
    let Some(slug) = text(skill, "slug")
        .filter(|s| safe_segment(s))
        .map(str::to_owned)
    else {
        return Err(ContextError::Invalid("Invalid selected skill name"));
    };
    let hash = Sha256::digest(key.as_bytes())
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    let installed = organization_root
        .join("skills/__installed__")
        .join(format!("{slug}--{}", &hash[..10]));
    let direct = text(skill, "sourceLocator").map(PathBuf::from).map(|p| {
        if p.file_name().is_some_and(|n| {
            n.to_str()
                .is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md"))
        }) {
            p.parent().unwrap().to_path_buf()
        } else {
            p
        }
    });
    if direct
        .as_ref()
        .is_some_and(|p| p.join("SKILL.md").is_file())
        && skill["metadata"]["installationVersion"] != 1
    {
        return Ok(());
    }
    if installed.join("SKILL.md").is_file() {
        agent_run_context::record_skill_installation(pool, claim, skill, &installed).await?;
        skill["metadata"]["installationVersion"] = json!(1);
        return Ok(());
    }
    let staging = artifacts.root.join("skill-downloads").join(&hash[..10]);
    fs::create_dir_all(&staging)?;
    match text(skill, "sourceType") {
        Some("github" | "skills_sh" | "url") => {
            download_package(skill, &staging, cancelled).await?
        }
        _ if direct
            .as_ref()
            .is_some_and(|p| p.join("SKILL.md").is_file()) =>
        {
            copy_package(direct.as_ref().unwrap(), &staging)?
        }
        _ => {
            let package = skill["fileInventory"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| text(v, "path") != Some("SKILL.md")));
            if package {
                return Err(ContextError::Invalid(
                    "Selected skill source package is unavailable",
                ));
            }
            private_write(
                &staging.join("SKILL.md"),
                text(skill, "markdown").unwrap_or_default().as_bytes(),
            )?;
        }
    }
    if !staging.join("SKILL.md").is_file() {
        return Err(ContextError::Invalid("Selected source has no SKILL.md"));
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(ContextError::Cancelled);
    }
    // Existing managed installation wins if another preparation already
    // completed it. No operator/global skill directory is overwritten.
    fs::create_dir_all(installed.parent().unwrap())?;
    let pending = installed.with_file_name(format!(".{}-{}", slug, claim.attempt_id));
    if pending.exists() {
        fs::remove_dir_all(&pending)?;
    }
    copy_package(&staging, &pending)?;
    agent_run_context::publish_skill_installation(pool, claim, skill, &pending, &installed).await?;
    skill["metadata"]["installationVersion"] = json!(1);
    Ok(())
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', '\0'])
}
fn safe_relative(value: &str) -> Result<&Path, ContextError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|v| !matches!(v, Component::Normal(_)))
        || value.contains('\\')
    {
        return Err(ContextError::Invalid("Invalid skill package path"));
    }
    Ok(path)
}
fn copy_package(source: &Path, target: &Path) -> Result<(), ContextError> {
    let mut inventory = Vec::new();
    inventory_tree(source, source, &mut inventory, &mut BTreeSet::new())?;
    for entry in inventory {
        let path = safe_relative(text(&entry, "path").unwrap())?;
        let target = target.join(path);
        fs::create_dir_all(target.parent().unwrap())?;
        private_write(&target, &fs::read(source.join(path))?)?;
    }
    Ok(())
}
async fn get(
    client: &reqwest::Client,
    url: &str,
    cancelled: &Arc<AtomicBool>,
) -> Result<Vec<u8>, ContextError> {
    let future = async {
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|_| ContextError::Invalid("Skill source request failed"))?
            .error_for_status()
            .map_err(|_| ContextError::Invalid("Skill source request failed"))?;
        response
            .bytes()
            .await
            .map(|v| v.to_vec())
            .map_err(|_| ContextError::Invalid("Skill source body failed"))
    };
    tokio::pin!(future);
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(ContextError::Cancelled);
        }
        match tokio::time::timeout(std::time::Duration::from_millis(100), future.as_mut()).await {
            Ok(value) => return value,
            Err(_) => continue,
        }
    }
}
async fn download_package(
    skill: &Value,
    target: &Path,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), ContextError> {
    let locator = text(skill, "sourceLocator")
        .ok_or(ContextError::Invalid("Skill source locator is missing"))?;
    let client = reqwest::Client::builder()
        .user_agent("Rudder-Native-Skills")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| ContextError::Invalid("Skill HTTP client failed"))?;
    let github = github_source(skill, locator)?;
    let Some((owner, repo, reference, base)) = github else {
        let markdown = get(&client, locator, cancelled).await?;
        private_write(&target.join("SKILL.md"), &markdown)?;
        return Ok(());
    };
    let reference = if reference.is_empty() {
        let value: Value = serde_json::from_slice(
            &get(
                &client,
                &format!("https://api.github.com/repos/{owner}/{repo}"),
                cancelled,
            )
            .await?,
        )
        .map_err(|_| ContextError::Invalid("Skill source repository is invalid"))?;
        text(&value, "default_branch").unwrap_or("main").to_owned()
    } else {
        reference
    };
    let reference = if reference.len() == 40 && reference.bytes().all(|b| b.is_ascii_hexdigit()) {
        reference
    } else {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/commits/{reference}");
        let value: Value = serde_json::from_slice(&get(&client, &url, cancelled).await?)
            .map_err(|_| ContextError::Invalid("Skill source ref is invalid"))?;
        text(&value, "sha")
            .ok_or(ContextError::Invalid("Skill source ref is missing"))?
            .to_owned()
    };
    let value: Value = serde_json::from_slice(
        &get(
            &client,
            &format!(
                "https://api.github.com/repos/{owner}/{repo}/git/trees/{reference}?recursive=1"
            ),
            cancelled,
        )
        .await?,
    )
    .map_err(|_| ContextError::Invalid("Skill source inventory is invalid"))?;
    if value["truncated"] == true {
        return Err(ContextError::Invalid(
            "Skill source inventory is incomplete",
        ));
    }
    let paths = value["tree"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "blob")
        .filter_map(|v| text(v, "path"))
        .collect::<Vec<_>>();
    let slug = text(skill, "slug").unwrap_or_default();
    let root = if paths
        .iter()
        .any(|p| p.eq_ignore_ascii_case(&format!("{base}SKILL.md")))
    {
        base
    } else {
        paths
            .iter()
            .find(|p| {
                p.to_ascii_lowercase().ends_with("/skill.md")
                    && (p.starts_with(&base))
                    && p.rsplit('/').nth(1) == Some(slug)
            })
            .map(|p| p[..p.len() - 8].to_owned())
            .ok_or(ContextError::Invalid(
                "Skill was not found in source repository",
            ))?
    };
    for path in paths.iter().filter(|p| p.starts_with(&root)) {
        let relative = safe_relative(path.strip_prefix(&root).unwrap())?;
        let output = target.join(
            if relative.to_string_lossy().eq_ignore_ascii_case("SKILL.md") {
                Path::new("SKILL.md")
            } else {
                relative
            },
        );
        fs::create_dir_all(output.parent().unwrap())?;
        private_write(
            &output,
            &get(
                &client,
                &format!("https://raw.githubusercontent.com/{owner}/{repo}/{reference}/{path}"),
                cancelled,
            )
            .await?,
        )?;
    }
    Ok(())
}
fn github_source(
    skill: &Value,
    locator: &str,
) -> Result<Option<(String, String, String, String)>, ContextError> {
    if let (Some(owner), Some(repo), Some(reference)) = (
        text(&skill["metadata"], "owner"),
        text(&skill["metadata"], "repo"),
        text(skill, "sourceRef"),
    ) {
        return Ok(Some((
            owner.into(),
            repo.into(),
            reference.into(),
            text(&skill["metadata"], "repoSkillDir")
                .map(|p| format!("{}/", p.trim_matches('/')))
                .unwrap_or_default(),
        )));
    }
    let url = reqwest::Url::parse(locator)
        .map_err(|_| ContextError::Invalid("Invalid skill source URL"))?;
    if !matches!(
        url.host_str(),
        Some("github.com" | "skills.sh" | "www.skills.sh")
    ) {
        return Ok(None);
    }
    let parts = url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(ContextError::Invalid("Invalid GitHub skill source"));
    }
    let reference =
        text(skill, "sourceRef").unwrap_or(if matches!(parts.get(2), Some(&"tree" | &"blob")) {
            parts.get(3).copied().unwrap_or("main")
        } else {
            ""
        });
    let tail = if matches!(parts.get(2), Some(&"tree" | &"blob")) {
        parts[4.min(parts.len())..].join("/")
    } else {
        String::new()
    };
    let tail = if tail.to_ascii_lowercase().ends_with("skill.md") {
        &tail[..tail.len() - 8]
    } else {
        &tail
    };
    let tail = tail.trim_matches('/');
    Ok(Some((
        parts[0].into(),
        parts[1].trim_end_matches(".git").into(),
        reference.into(),
        if tail.is_empty() {
            String::new()
        } else {
            format!("{tail}/")
        },
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_paths_cannot_escape_managed_root() {
        for p in ["../token", "/etc/passwd", "a/../b", "a\\b"] {
            assert!(safe_relative(p).is_err());
        }
        assert!(safe_relative("references/source.md").is_ok());
    }
    #[test]
    fn github_restoration_keeps_persisted_commit_and_package_root() {
        let s = json!({"sourceRef":"1234567890123456789012345678901234567890","metadata":{"owner":"example","repo":"skills","repoSkillDir":"skills/reviewer"}});
        let p = github_source(&s, "https://skills.sh/example/skills/reviewer")
            .unwrap()
            .unwrap();
        assert_eq!(p.2, s["sourceRef"].as_str().unwrap());
        assert_eq!(p.3, "skills/reviewer/");
    }
}
