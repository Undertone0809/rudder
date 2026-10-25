//! Pure input and output helpers for the existing organization Skill CLI.
//!
//! The public organization Skill API remains the authority for catalog and
//! package operations. This module keeps the Rust MCP transport's local
//! argument shaping and search projection aligned with `cli/src/commands/client/skill.ts`.

use serde_json::Value;
use std::fmt;

const SEARCH_FIELDS: &[&str] = &[
    "id",
    "key",
    "slug",
    "name",
    "description",
    "sourceType",
    "sourceLocator",
    "sourceRef",
    "sourceLabel",
    "sourceBadge",
    "sourcePath",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SkillCliInputError {
    MissingRequiredArgument(&'static str),
}

impl fmt::Display for SkillCliInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingRequiredArgument(name) => {
                write!(formatter, "Missing required argument: {name}")
            }
        }
    }
}

impl std::error::Error for SkillCliInputError {}

/// Filter organization Skill rows using the same fields and stable row order
/// as `searchOrganizationSkills` in the Node CLI.
pub(crate) fn search_organization_skills(rows: &[Value], query: &str) -> Vec<Value> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }

    rows.iter()
        .filter(|row| {
            SEARCH_FIELDS.iter().any(|field| {
                row.get(*field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.to_lowercase().contains(&query))
            })
        })
        .cloned()
        .collect()
}

/// Match the MCP bridge's `renderCsv` followed by the Skill CLI's `parseCsv`.
/// Empty or all-blank values are omitted from the resulting request body.
pub(crate) fn parse_csv_option(value: Option<&Value>) -> Option<Vec<String>> {
    let rendered = render_optional_string(value?)?;
    let rows = rendered
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    (!rows.is_empty()).then_some(rows)
}

/// Match the MCP bridge's optional `--path` handling and the CLI's default.
pub(crate) fn normalize_skill_file_path(value: Option<&Value>) -> String {
    value
        .and_then(render_optional_string)
        .unwrap_or_else(|| "SKILL.md".to_owned())
}

/// Match the MCP bridge's required source argument handling.
pub(crate) fn skill_import_source(value: Option<&Value>) -> Result<String, SkillCliInputError> {
    value
        .and_then(render_string_or_number)
        .ok_or(SkillCliInputError::MissingRequiredArgument("source"))
}

/// Match the MCP bridge's `markdown ?? body` alias followed by `pushOptional`.
pub(crate) fn agent_skill_markdown_argument(
    markdown: Option<&Value>,
    body: Option<&Value>,
) -> Option<String> {
    markdown
        .filter(|value| !value.is_null())
        .or(body)
        .and_then(render_optional_string)
}

fn render_optional_string(value: &Value) -> Option<String> {
    match value {
        Value::String(_) | Value::Number(_) => render_string_or_number(value),
        Value::Array(values) => {
            let rendered = values
                .iter()
                .filter_map(|value| match value {
                    Value::String(_) | Value::Number(_) => render_optional_string(value),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(",");
            (!rendered.is_empty()).then_some(rendered)
        }
        _ => None,
    }
}

fn render_string_or_number(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_matches_cli_fields_case_insensitively_and_preserves_order() {
        let rows = vec![
            json!({"id":"first","sourceRef":"Feature/Canva"}),
            json!({"id":"second","description":"Build CAMPAIGN artwork"}),
            json!({"id":"third","metadata":{"name":"Canva"}}),
            json!({"id":"fourth","sourcePath":"/skills/canva/SKILL.md"}),
        ];

        assert_eq!(
            search_organization_skills(&rows, " canva "),
            vec![rows[0].clone(), rows[3].clone()]
        );
        assert_eq!(
            search_organization_skills(&rows, "CAMPAIGN"),
            vec![rows[1].clone()]
        );
    }

    #[test]
    fn search_uses_every_cli_source_and_identity_field() {
        for field in SEARCH_FIELDS {
            let rows = [json!({"id":"skill","placeholder":"needle"})];
            let mut row = rows[0].clone();
            row.as_object_mut()
                .unwrap()
                .insert((*field).to_owned(), json!("needle"));
            assert_eq!(
                search_organization_skills(&[row.clone()], "NEEDLE"),
                vec![row],
                "{field}"
            );
        }
    }

    #[test]
    fn search_with_blank_query_returns_no_rows() {
        let rows = vec![json!({"name":"Anything"})];
        assert!(search_organization_skills(&rows, " \t ").is_empty());
    }

    #[test]
    fn csv_option_trims_items_drops_blanks_and_omits_empty_values() {
        assert_eq!(
            parse_csv_option(Some(&json!(" /a, ,/b,, "))),
            Some(vec!["/a".into(), "/b".into()])
        );
        assert_eq!(parse_csv_option(Some(&json!(" , ,, "))), None);
        assert_eq!(parse_csv_option(None), None);
    }

    #[test]
    fn csv_option_matches_legacy_mcp_array_rendering() {
        assert_eq!(
            parse_csv_option(Some(&json!([
                " project-one ",
                7,
                true,
                "",
                "workspace-two"
            ]))),
            Some(vec![
                "project-one".into(),
                "7".into(),
                "workspace-two".into()
            ])
        );
    }

    #[test]
    fn file_path_trims_values_and_defaults_to_skill_markdown() {
        assert_eq!(normalize_skill_file_path(None), "SKILL.md");
        assert_eq!(
            normalize_skill_file_path(Some(&json!("  references/usage.md  "))),
            "references/usage.md"
        );
        assert_eq!(normalize_skill_file_path(Some(&json!("   "))), "SKILL.md");
        assert_eq!(normalize_skill_file_path(Some(&json!(12))), "12");
    }

    #[test]
    fn import_source_is_required_trimmed_and_accepts_legacy_finite_number() {
        assert_eq!(
            skill_import_source(Some(&json!("  ./skills/research  "))).unwrap(),
            "./skills/research"
        );
        assert_eq!(skill_import_source(Some(&json!(0.5))).unwrap(), "0.5");
        assert_eq!(
            skill_import_source(Some(&json!(" \n "))),
            Err(SkillCliInputError::MissingRequiredArgument("source"))
        );
        assert_eq!(
            skill_import_source(None),
            Err(SkillCliInputError::MissingRequiredArgument("source"))
        );
        assert_eq!(
            skill_import_source(Some(&json!(["./skills/research"]))),
            Err(SkillCliInputError::MissingRequiredArgument("source"))
        );
    }

    #[test]
    fn agent_create_markdown_uses_nullish_alias_and_optional_cli_trimming() {
        assert_eq!(
            agent_skill_markdown_argument(Some(&json!("  primary  ")), Some(&json!("fallback"))),
            Some("primary".into())
        );
        assert_eq!(
            agent_skill_markdown_argument(Some(&Value::Null), Some(&json!(" fallback "))),
            Some("fallback".into())
        );
        assert_eq!(
            agent_skill_markdown_argument(Some(&json!("   ")), Some(&json!("fallback"))),
            None
        );
    }
}
