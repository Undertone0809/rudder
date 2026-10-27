//! Provider-specific enabled-skill frames captured from current Node adapters.
use super::{ContextError, text};
use serde_json::Value;
use std::{fs, path::Path, sync::OnceLock};

pub(super) fn render(runtime: &str, entries: &[Value]) -> Result<String, ContextError> {
    static PREFIXES: OnceLock<Value> = OnceLock::new();
    let prefixes = PREFIXES.get_or_init(|| {
        serde_json::from_str(include_str!("skill-boundaries.json")).expect("captured skill frames")
    });
    let Some(prefix) = prefixes[runtime].as_str() else {
        return Ok(String::new());
    };
    let inline = matches!(runtime, "cursor" | "opencode_local" | "hermes_gateway");
    if entries.is_empty() && inline {
        return Ok(String::new());
    }
    let mut sections = Vec::new();
    let mut bytes = 0;
    for entry in entries {
        if inline {
            let source = text(entry, "source").ok_or(ContextError::Invalid(
                "Selected skill source is unavailable",
            ))?;
            let content = fs::read_to_string(Path::new(source).join("SKILL.md"))?;
            if content.trim().is_empty() {
                if runtime == "hermes_gateway" {
                    return Err(ContextError::Invalid(
                        "Selected Hermes skill has no readable SKILL.md",
                    ));
                }
                continue;
            }
            bytes += content.len();
            if runtime == "hermes_gateway" && (content.len() > 128 * 1024 || bytes > 512 * 1024) {
                return Err(ContextError::Invalid(
                    "Selected Hermes skill projection exceeds its runtime limit",
                ));
            }
            sections.push(format!(
                "## Skill: {}\n\n{}",
                text(entry, "key").unwrap_or_default(),
                content.trim()
            ));
        } else {
            sections.push(format!(
                "- {}",
                text(entry, "runtimeName")
                    .or_else(|| text(entry, "key"))
                    .unwrap_or_default()
            ));
        }
    }
    if sections.is_empty() {
        if inline {
            return Ok(String::new());
        }
        sections.push("- None. No optional Rudder skills are enabled for this run.".into());
    }
    Ok(format!(
        "<enabled_rudder_skills>\n{}\n{}\n</enabled_rudder_skills>",
        prefix,
        sections.join(if inline { "\n\n" } else { "\n" })
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_claude_snapshot_keeps_exact_provider_boundary() {
        let value = render("claude_local", &[]).unwrap();
        assert!(value.contains("Claude Code built-in/provider-native skills"));
        assert!(value.contains("- None. No optional Rudder skills are enabled for this run."));
        assert!(value.starts_with("<enabled_rudder_skills>\n"));
    }
}
