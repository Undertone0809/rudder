use super::{AgentRunContextHost, ContextError, text};
use rudder_d1_persistence::agent_run_context::AgentRunResources;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

/// Only this owned, freshly-created run directory is removed on drop. Source
/// bundles, Agent memory, provider sessions and operator profiles are retained.
pub(super) struct InvocationArtifacts {
    pub root: PathBuf,
    cleanup_on_drop: bool,
}
impl InvocationArtifacts {
    pub fn create(
        runtime_root: &Path,
        run_id: &str,
        attempt_id: &str,
    ) -> Result<Self, ContextError> {
        if uuid::Uuid::parse_str(run_id).is_err() || uuid::Uuid::parse_str(attempt_id).is_err() {
            return Err(ContextError::Invalid(
                "Invalid Agent context artifact identity",
            ));
        }
        let parent = runtime_root.join("agent-context").join(run_id);
        fs::create_dir_all(&parent)?;
        let root = parent.join(attempt_id);
        fs::create_dir(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            root,
            cleanup_on_drop: true,
        })
    }
    pub fn mark_provider_launch_possible(&mut self) {
        self.cleanup_on_drop = false;
    }
    pub fn may_have_launched(&self) -> bool {
        !self.cleanup_on_drop
    }
    pub fn cleanup_confirmed(&mut self) {
        self.cleanup_on_drop = true;
    }
    pub fn write(&self, relative: &str, content: &str) -> Result<PathBuf, ContextError> {
        let relative = Path::new(relative);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(ContextError::Invalid(
                "Invalid managed runtime artifact path",
            ));
        }
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        private_write(&path, content.as_bytes())?;
        Ok(path)
    }
}
impl Drop for InvocationArtifacts {
    fn drop(&mut self) {
        if self.cleanup_on_drop {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

pub(super) fn private_write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(content)?;
    file.flush()
}

pub(super) struct MaterializedSkills {
    pub entries: Vec<Value>,
    pub root: PathBuf,
    pub prompt: String,
    pub warnings: Vec<String>,
}
pub(super) fn realize_skills(
    resources: &AgentRunResources,
    config: &Value,
    runtime: &str,
    agent_home: &Path,
    organization_root: &Path,
    host: &AgentRunContextHost,
    artifacts: &InvocationArtifacts,
) -> Result<MaterializedSkills, ContextError> {
    let mut warnings = Vec::new();
    let root = artifacts.root.join("skills");
    fs::create_dir_all(&root)?;
    let configured_home = text(&config["env"], "HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| host.operator_home.clone());
    let mut candidates =
        BTreeMap::<String, (String, PathBuf, Option<String>, Option<String>)>::new();
    for skill in &resources.skills {
        let Some(key) = text(skill, "key") else {
            continue;
        };
        let Some(slug) = text(skill, "slug").filter(|s| valid_segment(s)) else {
            continue;
        };
        let bundled = matches!(
            key,
            "rudder/app-builder"
                | "rudder/para-memory-files"
                | "rudder/rudder-docs"
                | "rudder/skill-creator"
                | "rudder/visualize"
                | "rudder/browser"
        ) || text(skill, "sourceRef").is_some_and(|s| s.starts_with("bundled:"))
            || matches!(
                text(skill, "sourceType"),
                Some("rudder_bundled" | "paperclip_bundled")
            )
            || matches!(
                text(&skill["metadata"], "sourceKind"),
                Some("rudder_bundled" | "paperclip_bundled")
            );
        let selection = if bundled {
            format!("bundled:{key}")
        } else {
            format!("org:{key}")
        };
        if !bundled && !resources.enabled_skill_keys.contains(&selection) {
            continue;
        }
        // Browser eligibility is decided by the caller, not by the presence
        // of a catalog skill with the same slug.
        if slug == "browser" && config["rudderBrowserEnabled"] != true {
            continue;
        }
        if slug == "app-builder"
            && resources.general_settings["experimentalPluginsEnabled"] != true
            && resources.general_settings["experimentalSitesEnabled"] != true
        {
            continue;
        }
        let locator = text(skill, "sourceLocator").map(PathBuf::from);
        let mut source = locator.map(|path| {
            if path.file_name().is_some_and(|v| {
                v.to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
            }) {
                path.parent().unwrap().to_path_buf()
            } else {
                path
            }
        });
        if skill["metadata"]["installationVersion"] == 1 && !bundled {
            let digest = Sha256::digest(key.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            source = Some(
                organization_root
                    .join("skills")
                    .join("__installed__")
                    .join(format!("{slug}--{}", &digest[..10])),
            );
        }
        if bundled
            && !source
                .as_ref()
                .is_some_and(|p| p.join("SKILL.md").is_file())
        {
            source = host.bundled_skills_root.as_ref().map(|p| p.join(slug));
        }
        let target = root.join(slug);
        if let Some(source) = source.filter(|p| p.join("SKILL.md").is_file()) {
            copy_tree(&source, &target, &mut BTreeSet::new())?;
        } else {
            // Persisted markdown is the complete payload for markdown-only
            // skills. Package skills must preserve their referenced files.
            let has_package = skill["fileInventory"].as_array().is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| text(entry, "path") != Some("SKILL.md"))
            });
            if has_package {
                return Err(ContextError::Invalid(
                    "Selected skill package is not installed",
                ));
            }
            let markdown = text(skill, "markdown").ok_or(ContextError::Invalid(
                "Selected skill has no readable SKILL.md",
            ))?;
            fs::create_dir_all(&target)?;
            private_write(&target.join("SKILL.md"), markdown.as_bytes())?;
        }
        candidates.insert(
            selection,
            (
                slug.into(),
                target,
                text(skill, "name").map(str::to_owned),
                text(skill, "description").map(str::to_owned),
            ),
        );
    }
    for selection in &resources.enabled_skill_keys {
        if candidates.contains_key(selection) {
            continue;
        }
        let source = if let Some(slug) = selection.strip_prefix("agent:") {
            Some((slug, agent_home.join("skills").join(slug)))
        } else if let Some(slug) = selection.strip_prefix("global:") {
            Some((slug, configured_home.join(".agents/skills").join(slug)))
        } else if let Some(value) = selection.strip_prefix("adapter:") {
            let (adapter, slug) = value
                .split_once(':')
                .ok_or(ContextError::Invalid("Invalid adapter skill selection"))?;
            let adapter_root = match adapter {
                "codex_local" => text(&config["env"], "CODEX_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| configured_home.join(".codex"))
                    .join("skills"),
                "claude_local" | "opencode_local" => configured_home.join(".claude/skills"),
                "cursor" => configured_home.join(".cursor/skills"),
                "pi_local" => configured_home.join(".pi/agent/skills"),
                _ => continue,
            };
            Some((slug, adapter_root.join(slug)))
        } else {
            None
        };
        let Some((slug, source)) = source else {
            if selection.starts_with("org:") {
                warnings.push("[rudder] Selected organization skill is unavailable in the current catalog; omitted for this invocation.\n".into());
                continue;
            }
            continue;
        };
        if !valid_segment(slug) {
            continue;
        }
        let source = if source.join("SKILL.md").is_file() {
            Some(source)
        } else {
            source
                .parent()
                .and_then(|root| discovered_source(root, slug))
        };
        let Some(source) = source else {
            warnings.push(
                "[rudder] Selected local skill is not installed; omitted for this invocation.\n"
                    .into(),
            );
            continue;
        };
        let target = root.join(slug);
        if target.exists() {
            return Err(ContextError::Invalid(
                "Enabled skill runtime names conflict",
            ));
        }
        copy_tree(&source, &target, &mut BTreeSet::new())?;
        candidates.insert(selection.clone(), (slug.into(), target, None, None));
    }
    let mut entries = Vec::new();
    let mut sections = Vec::new();
    let mut bytes = 0usize;
    for (key, (slug, path, name, description)) in candidates {
        let content = fs::read_to_string(path.join("SKILL.md"))?;
        if runtime == "hermes_gateway" {
            bytes += content.len();
            if content.len() > 128 * 1024 || bytes > 512 * 1024 {
                return Err(ContextError::Invalid(
                    "Selected Hermes skill projection exceeds its runtime limit",
                ));
            }
            sections.push(format!("## Skill: {key}\n\n{}", content.trim()));
        } else {
            sections.push(format!("- {slug}"));
        }
        entries.push(json!({"key":key,"runtimeName":slug,"source":path,"name":name,"description":description}));
    }
    let prompt = if entries.is_empty() {
        String::new()
    } else {
        format!(
            "<rudder_enabled_skills>\nRudder is the source of truth for runtime skill enablement. Only the skills listed here are enabled by Rudder for this run. When asked which Rudder skills are enabled, answer from this section only.\n\n{}\n</rudder_enabled_skills>",
            sections.join("\n\n")
        )
    };
    Ok(MaterializedSkills {
        entries,
        root,
        prompt,
        warnings,
    })
}

fn discovered_source(root: &Path, slug: &str) -> Option<PathBuf> {
    let mut paths = Vec::new();
    for root in [root.to_path_buf(), root.join("skills")] {
        for entry in fs::read_dir(root).ok().into_iter().flatten().flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let normalized = name
                .to_lowercase()
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            if normalized == slug && path.join("SKILL.md").is_file() {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths.into_iter().next()
}
fn valid_segment(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', '\0'])
}
fn copy_tree(
    source: &Path,
    target: &Path,
    ancestors: &mut BTreeSet<PathBuf>,
) -> Result<(), ContextError> {
    let canonical = fs::canonicalize(source)?;
    if !ancestors.insert(canonical.clone()) {
        return Err(ContextError::Invalid(
            "Skill package contains a directory cycle",
        ));
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source = entry.path();
        let target = target.join(entry.file_name());
        if source.is_dir() {
            copy_tree(&source, &target, ancestors)?;
        } else if source.is_file() {
            fs::copy(source, target)?;
        }
    }
    ancestors.remove(&canonical);
    Ok(())
}

/// Provider-specific managed files refer to the native CLI and inherit the
/// per-run credential from its parent environment. Tokens never enter files.
#[allow(clippy::too_many_arguments)] // Keep one resolved invocation and its owned materialization inputs together.
pub(super) fn provision_core_mcp(
    runtime: &str,
    config: &mut Value,
    env: &mut BTreeMap<String, String>,
    host: &AgentRunContextHost,
    artifacts: &InvocationArtifacts,
    skills: &MaterializedSkills,
    instructions: &Path,
    profile_root: &Path,
    bindings: &[Value],
) -> Result<Vec<String>, ContextError> {
    let mut args = Vec::new();
    let mut servers = serde_json::Map::new();
    servers.insert(
        "rudder-tools".into(),
        json!({"command":host.rudder_cli,"args":["mcp-server"]}),
    );
    for (enabled, name, surface) in [
        (
            config["rudderBrowserEnabled"] == true,
            "rudder-browser",
            "browser",
        ),
        (
            config["rudderComputerEnabled"] == true,
            "rudder-computer",
            "computer",
        ),
    ] {
        if enabled {
            servers.insert(
                name.into(),
                json!({"command":host.rudder_cli,"args":["mcp-server","--server",surface]}),
            );
        }
    }
    for binding in bindings {
        let id = text(binding, "bindingId")
            .filter(|v| uuid::Uuid::parse_str(v).is_ok())
            .ok_or(ContextError::Invalid("Invalid managed MCP binding"))?;
        let name = text(binding, "serverName")
            .filter(|v| !v.is_empty())
            .ok_or(ContextError::Invalid("Invalid managed MCP server name"))?;
        if servers.contains_key(name) {
            return Err(ContextError::Invalid(
                "Managed MCP server name conflicts with another server",
            ));
        }
        servers.insert(
            name.into(),
            json!({"command":host.rudder_cli,"args":["mcp-server","--binding-id",id]}),
        );
    }
    // Omit env from files altogether: inherited credentials and identity are
    // already installed by the owned process host before starting the MCP.
    match runtime {
        "claude_local" => {
            let path = artifacts.write(
                "claude-mcp.json",
                &json!({"mcpServers":servers}).to_string(),
            )?;
            let settings = artifacts.write("claude-settings.json", "{\"disableAllHooks\":true}")?;
            config["mcpConfigPath"] = json!(path);
            config["settingsPath"] = json!(settings);
            config["instructionsFilePath"] = json!(instructions);
            args.extend([
                "--setting-sources".into(),
                "user".into(),
                "--strict-mcp-config".into(),
                "--add-dir".into(),
                artifacts.root.to_string_lossy().into_owned(),
            ]);
            let target = artifacts.root.join(".claude/skills");
            fs::create_dir_all(&target)?;
            for skill in &skills.entries {
                if let (Some(name), Some(source)) =
                    (text(skill, "runtimeName"), text(skill, "source"))
                {
                    link_directory(Path::new(source), &target.join(name))?;
                }
            }
            env.insert(
                "CLAUDE_CONFIG_DIR".into(),
                profile_root.join(".claude").to_string_lossy().into_owned(),
            );
        }
        "codex_local" => {
            let cli = serde_json::to_string(&host.rudder_cli.to_string_lossy())
                .map_err(|_| ContextError::Invalid("Invalid native CLI path"))?;
            let inherited = env
                .keys()
                .filter(|key| {
                    key.starts_with("RUDDER_")
                        || key.as_str() == "PATH"
                        || key.as_str() == "AGENT_HOME"
                })
                .cloned()
                .collect::<Vec<_>>();
            for (name, server) in &servers {
                let quoted = serde_json::to_string(name).unwrap();
                for setting in [
                    format!("mcp_servers.{quoted}.command={cli}"),
                    format!("mcp_servers.{quoted}.args={}", server["args"]),
                    format!(
                        "mcp_servers.{quoted}.env_vars={}",
                        serde_json::to_string(&inherited).unwrap()
                    ),
                ] {
                    args.extend(["-c".into(), setting]);
                }
            }
            // Skills are selected explicitly from this run directory; each
            // config entry remains a path, never a secret-bearing payload.
            let mut skill_configs = skills
                .entries
                .iter()
                .filter_map(|skill| text(skill, "source"))
                .map(|path| {
                    format!(
                        "{{path={},enabled=true}}",
                        serde_json::to_string(&Path::new(path).join("SKILL.md").to_string_lossy())
                            .unwrap()
                    )
                })
                .collect::<Vec<_>>();
            for path in super::profiles::codex_disabled_skill_paths(
                config,
                Path::new(text(config, "cwd").unwrap_or("/")),
                host,
            ) {
                skill_configs.push(format!(
                    "{{path={},enabled=false}}",
                    serde_json::to_string(&path.to_string_lossy()).unwrap()
                ));
            }
            if !skill_configs.is_empty() {
                args.extend([
                    "-c".into(),
                    format!("skills.config=[{}]", skill_configs.join(",")),
                ]);
            }
            env.insert(
                "CODEX_HOME".into(),
                profile_root.to_string_lossy().into_owned(),
            );
        }
        "opencode_local" => {
            // Node's managed OpenCode profile excludes both inline and
            // alternate-directory configuration, including configured env.
            for key in ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"] {
                env.remove(key);
                if let Some(configured) = config.get_mut("env").and_then(Value::as_object_mut) {
                    configured.remove(key);
                }
            }
            let mut managed = super::profiles::opencode_base(host);
            let mut opencode_servers = serde_json::Map::new();
            for (name, server) in &servers {
                let mut command = vec![json!(host.rudder_cli)];
                command.extend(server["args"].as_array().unwrap().iter().cloned());
                opencode_servers.insert(
                    name.clone(),
                    json!({"type":"local","command":command,"enabled":true}),
                );
            }
            managed["mcp"] = json!(opencode_servers);
            managed["skills"] = json!({"paths":[skills.root]});
            let path = artifacts.write("opencode.json", &managed.to_string())?;
            env.insert(
                "OPENCODE_CONFIG".into(),
                path.to_string_lossy().into_owned(),
            );
            env.insert("OPENCODE_DISABLE_CLAUDE_CODE".into(), "true".into());
            env.insert("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT".into(), "true".into());
            env.insert("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS".into(), "true".into());
            env.insert(
                "XDG_CONFIG_HOME".into(),
                profile_root.join(".config").to_string_lossy().into_owned(),
            );
            env.insert(
                "XDG_DATA_HOME".into(),
                profile_root
                    .join(".local/share")
                    .to_string_lossy()
                    .into_owned(),
            );
            env.insert(
                "XDG_CACHE_HOME".into(),
                profile_root.join(".cache").to_string_lossy().into_owned(),
            );
        }
        "pi_local" => {
            super::pi_models::prepare(config, env, profile_root)?;
            config["skillsDir"] = json!(skills.root);
            env.insert(
                "PI_CODING_AGENT_DIR".into(),
                profile_root
                    .join(".pi/agent")
                    .to_string_lossy()
                    .into_owned(),
            );
            fs::create_dir_all(profile_root.join(".pi/paperclips"))?;
            env.insert(
                "PI_CODING_AGENT_SESSION_DIR".into(),
                profile_root
                    .join(".pi/paperclips")
                    .to_string_lossy()
                    .into_owned(),
            );
            // Pi's first-party tool bridge is a generated external-provider
            // extension. Native CLI owns every MCP payload and operation.
            let core_tools = rudder_agent_cli_core::native_mcp_tool_descriptors();
            let desktop_tools = desktop_sources(config)
                .into_iter()
                .flat_map(|source| source["tools"].as_array().cloned().unwrap_or_default())
                .collect::<Vec<_>>();
            let mut tool_names = ["read", "bash", "edit", "write", "grep", "find", "ls"]
                .into_iter()
                .map(str::to_owned)
                .chain(
                    core_tools
                        .iter()
                        .filter_map(|t| text(t, "name"))
                        .map(str::to_owned),
                )
                .chain(
                    desktop_tools
                        .iter()
                        .filter_map(|tool| text(tool, "name"))
                        .map(str::to_owned),
                )
                .chain(
                    bindings
                        .iter()
                        .flat_map(|b| b["tools"].as_array().into_iter().flatten())
                        .filter_map(|t| text(t, "name"))
                        .map(str::to_owned),
                )
                .collect::<Vec<_>>();
            let mut seen = BTreeSet::new();
            tool_names.retain(|name| seen.insert(name.clone()));
            args.extend(["--tools".into(), tool_names.join(",")]);
            let extension = artifacts.write(
                "rudder-pi-mcp.mjs",
                &pi_extension(&host.rudder_cli, bindings, config),
            )?;
            args.extend([
                "--extension".into(),
                extension.to_string_lossy().into_owned(),
            ]);
        }
        "cursor" => {
            // Cursor has no MCP flag in its existing Agent adapter contract;
            // its run prompt supplies instructions and selected skill frame.
            env.insert(
                "CURSOR_CONFIG_DIR".into(),
                profile_root.join(".cursor").to_string_lossy().into_owned(),
            );
        }
        _ => (),
    }
    Ok(args)
}
fn link_directory(source: &Path, target: &Path) -> Result<(), ContextError> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target)?;
    }
    #[cfg(not(unix))]
    {
        copy_tree(source, target, &mut BTreeSet::new())?;
    }
    Ok(())
}
fn desktop_sources(config: &Value) -> Vec<Value> {
    use rudder_agent_cli_core::DesktopSurface;
    [("rudderBrowserEnabled","browser",DesktopSurface::Browser),("rudderComputerEnabled","computer",DesktopSurface::Computer)].into_iter()
        .filter(|(key,_,_)|config[*key]==true)
        .map(|(_,name,surface)|json!({"args":["mcp-server","--server",name],"tools":rudder_agent_cli_core::desktop_mcp_tool_descriptors(surface)})).collect()
}
fn pi_extension(cli: &Path, bindings: &[Value], config: &Value) -> String {
    // This tiny provider shim only transports JSON-RPC over native stdio.
    // Tool inventory, validation, auth and all Rudder behavior live in Rust.
    format!(
        r#"import {{ spawn }} from 'node:child_process';
export default async function(pi) {{
 const sources={};
 for(const source of sources) {{
 const child=spawn({},source.args,{{env:process.env,stdio:['pipe','pipe','inherit']}});
 let buffer='',sequence=0; const pending=new Map();
 child.stdout.setEncoding('utf8'); child.stdout.on('data',chunk=>{{buffer+=chunk;for(;;){{const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let m;try{{m=JSON.parse(line)}}catch{{continue}}const request=pending.get(m.id);if(request){{pending.delete(m.id);m.error?request.reject(new Error(m.error.message||'Native MCP failed')):request.resolve(m.result)}}}}}});
 const call=(method,params)=>new Promise((resolve,reject)=>{{const id=++sequence;pending.set(id,{{resolve,reject}});child.stdin.write(JSON.stringify({{jsonrpc:'2.0',id,method,params}})+'\n')}});
 child.on('exit',()=>{{for(const p of pending.values())p.reject(new Error('Native MCP stopped'));pending.clear()}});
 await call('initialize',{{protocolVersion:'2025-03-26',capabilities:{{}},clientInfo:{{name:'rudder-pi',version:'1'}}}});
 child.stdin.write(JSON.stringify({{jsonrpc:'2.0',method:'notifications/initialized'}})+'\n');
 for(const tool of source.tools||[])pi.registerTool({{name:tool.name,label:tool.name,description:tool.description||tool.name,parameters:tool.inputSchema,async execute(_id,args,_signal){{const result=await call('tools/call',{{name:tool.name,arguments:args}});return {{content:result.content||[],details:result}}}}}});
 pi.on('session_shutdown',async()=>{{child.stdin.end();child.kill()}});
 }}
}}
"#,
        serde_json::to_string(
            &std::iter::once(json!({"args":["mcp-server"],"tools":rudder_agent_cli_core::native_mcp_tool_descriptors()}))
                .chain(desktop_sources(config))
                .chain(
                    bindings
                        .iter()
                        .map(|b| json!({"args":["mcp-server","--binding-id",b["bindingId"]],"tools":b["tools"]}))
                )
                .collect::<Vec<_>>()
        )
        .unwrap(),
        serde_json::to_string(&cli.to_string_lossy()).unwrap()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn artifacts_remove_only_the_owned_invocation_directory() {
        let root = tempfile::tempdir().unwrap();
        let persistent = root.path().join("keep");
        fs::write(&persistent, "profile").unwrap();
        let path;
        {
            let owned = InvocationArtifacts::create(
                root.path(),
                "10000000-0000-4000-8000-000000000001",
                "20000000-0000-4000-8000-000000000001",
            )
            .unwrap();
            path = owned.root.clone();
            owned.write("instructions.md", "body").unwrap();
            assert!(path.is_dir());
        }
        assert!(!path.exists());
        assert!(persistent.is_file());
    }
    #[test]
    fn generated_pi_bridge_contains_only_native_transport() {
        let script = pi_extension(Path::new("/installed/rudder-cli"), &[], &json!({}));
        assert!(script.contains("mcp-server"));
        assert!(!script.contains("fetch("));
        assert!(script.contains("source.tools"));
        assert!(!script.contains("@rudderhq/"));
        assert!(!script.contains("server/src"));
        assert!(!script.contains("RUDDER_API_KEY="));
    }
}
