//! Root-level LLM reflection documents served through the public Rust ingress.
//! Authorization and registry data remain owned by the private Node adapter.

use actix_web::{HttpResponse, http::StatusCode};
use serde::{Deserialize, Deserializer};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LlmReflectionSnapshot {
    pub(crate) adapters: Vec<LlmReflectionAdapter>,
    pub(crate) icon_names: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct LlmReflectionAdapter {
    pub(crate) adapter_type: String,
    pub(crate) agent_configuration_doc: Option<String>,
}

impl<'de> Deserialize<'de> for LlmReflectionAdapter {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut fields = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let adapter_type = match fields.remove("type") {
            Some(serde_json::Value::String(adapter_type)) => adapter_type,
            Some(_) => {
                return Err(<D::Error as serde::de::Error>::custom(
                    "adapter type must be a string",
                ));
            }
            None => return Err(<D::Error as serde::de::Error>::missing_field("type")),
        };
        let agent_configuration_doc = match fields.remove("agentConfigurationDoc") {
            Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(document)) => Some(document),
            Some(_) => {
                return Err(<D::Error as serde::de::Error>::custom(
                    "agentConfigurationDoc must be a string or null",
                ));
            }
            None => {
                return Err(<D::Error as serde::de::Error>::missing_field(
                    "agentConfigurationDoc",
                ));
            }
        };
        Ok(Self {
            adapter_type,
            agent_configuration_doc,
        })
    }
}

pub(crate) enum LlmReflectionDocument<'a> {
    Index,
    Icons,
    Adapter(&'a str),
}

pub(crate) fn render(
    document: LlmReflectionDocument<'_>,
    snapshot: LlmReflectionSnapshot,
) -> HttpResponse {
    match document {
        LlmReflectionDocument::Index => {
            let mut lines = vec![
                "# Rudder Agent Configuration Index".to_owned(),
                "".to_owned(),
                "Installed adapters:".to_owned(),
            ];
            lines.extend(snapshot.adapters.iter().map(|adapter| {
                format!(
                    "- {}: /llms/agent-configuration/{}.txt",
                    adapter.adapter_type, adapter.adapter_type
                )
            }));
            lines.extend([
                "".to_owned(),
                "Related API endpoints:".to_owned(),
                "- GET /api/orgs/:orgId/agent-configurations".to_owned(),
                "- GET /api/agents/:id/configuration".to_owned(),
                "- POST /api/orgs/:orgId/agent-hires".to_owned(),
                "".to_owned(),
                "Agent identity references:".to_owned(),
                "- GET /llms/agent-icons.txt (legacy named icons for compatibility/debugging)".to_owned(),
                "".to_owned(),
                "Notes:".to_owned(),
                "- Sensitive values are redacted in configuration read APIs.".to_owned(),
                "- New hires may be created in pending_approval state depending on organization settings.".to_owned(),
                "- Omit `icon` for normal hires and creates; Rudder generates an Oreo avatar.".to_owned(),
                "".to_owned(),
            ]);
            text_response(StatusCode::OK, lines.join("\n"))
        }
        LlmReflectionDocument::Icons => {
            let mut lines = vec![
                "# Rudder Legacy Agent Icon Names".to_owned(),
                "".to_owned(),
                "Do not set `icon` on normal hire/create payloads. Rudder generates an Oreo avatar automatically.".to_owned(),
                "".to_owned(),
                "Only set `icon` when preserving an explicit `oreo:<shape>:<palette>:<uuid>`, DiceBear Notionists, or uploaded `asset:<uuid>` avatar reference supplied by the board/UI.".to_owned(),
                "".to_owned(),
                "The following named icons remain accepted only for legacy compatibility and debugging:".to_owned(),
            ];
            lines.extend(snapshot.icon_names.iter().map(|name| format!("- {name}")));
            lines.extend([
                "".to_owned(),
                "Normal hire example:".to_owned(),
                "{ \"name\": \"SearchOps\", \"role\": \"researcher\" }".to_owned(),
                "".to_owned(),
            ]);
            text_response(StatusCode::OK, lines.join("\n"))
        }
        LlmReflectionDocument::Adapter(adapter_type) => {
            let Some(adapter) = snapshot
                .adapters
                .iter()
                .find(|adapter| adapter.adapter_type == adapter_type)
            else {
                return text_response(
                    StatusCode::NOT_FOUND,
                    format!("Unknown adapter type: {adapter_type}"),
                );
            };
            text_response(
                StatusCode::OK,
                adapter.agent_configuration_doc.clone().unwrap_or_else(|| {
                    format!(
                        "# {adapter_type} agent configuration\n\nNo adapter-specific documentation registered."
                    )
                }),
            )
        }
    }
}

fn text_response(status: StatusCode, body: String) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("text/plain; charset=utf-8")
        .body(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::body::to_bytes;

    fn snapshot(
        adapters: Vec<LlmReflectionAdapter>,
        icon_names: Vec<&str>,
    ) -> LlmReflectionSnapshot {
        LlmReflectionSnapshot {
            adapters,
            icon_names: icon_names.into_iter().map(str::to_owned).collect(),
        }
    }

    #[actix_web::test]
    async fn renders_the_root_level_reflection_documents_and_unknown_adapter_status() {
        let adapter = LlmReflectionAdapter {
            adapter_type: "fixture".to_owned(),
            agent_configuration_doc: Some("# Fixture adapter\n".to_owned()),
        };
        let index = render(
            LlmReflectionDocument::Index,
            snapshot(vec![adapter], vec![]),
        );
        assert_eq!(index.status(), StatusCode::OK);
        let index_body = to_bytes(index.into_body()).await.unwrap();
        assert_eq!(index_body.as_ref(), b"# Rudder Agent Configuration Index\n\nInstalled adapters:\n- fixture: /llms/agent-configuration/fixture.txt\n\nRelated API endpoints:\n- GET /api/orgs/:orgId/agent-configurations\n- GET /api/agents/:id/configuration\n- POST /api/orgs/:orgId/agent-hires\n\nAgent identity references:\n- GET /llms/agent-icons.txt (legacy named icons for compatibility/debugging)\n\nNotes:\n- Sensitive values are redacted in configuration read APIs.\n- New hires may be created in pending_approval state depending on organization settings.\n- Omit `icon` for normal hires and creates; Rudder generates an Oreo avatar.\n");

        let icons = render(
            LlmReflectionDocument::Icons,
            snapshot(vec![], vec!["search", "planning"]),
        );
        assert_eq!(icons.status(), StatusCode::OK);
        let icons = String::from_utf8(to_bytes(icons.into_body()).await.unwrap().to_vec()).unwrap();
        assert!(icons.contains("- search\n- planning\n"));
        assert!(icons.contains("{ \"name\": \"SearchOps\", \"role\": \"researcher\" }"));

        let adapter = render(
            LlmReflectionDocument::Adapter("fixture"),
            snapshot(
                vec![LlmReflectionAdapter {
                    adapter_type: "fixture".to_owned(),
                    agent_configuration_doc: Some("# Fixture adapter\n".to_owned()),
                }],
                vec![],
            ),
        );
        assert_eq!(adapter.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(adapter.into_body()).await.unwrap().as_ref(),
            b"# Fixture adapter\n"
        );

        let unknown = render(
            LlmReflectionDocument::Adapter("missing"),
            snapshot(vec![], vec![]),
        );
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            to_bytes(unknown.into_body()).await.unwrap().as_ref(),
            b"Unknown adapter type: missing"
        );
    }

    #[test]
    fn requires_nullable_adapter_docs_to_be_present_and_accepts_explicit_null() {
        let missing = serde_json::from_str::<LlmReflectionSnapshot>(
            r#"{"adapters":[{"type":"fixture"}],"iconNames":[]}"#,
        );
        assert!(missing.is_err(), "missing property must fail closed");

        let explicit_null = serde_json::from_str::<LlmReflectionSnapshot>(
            r#"{"adapters":[{"type":"fixture","agentConfigurationDoc":null}],"iconNames":[]}"#,
        )
        .unwrap();
        assert_eq!(explicit_null.adapters[0].agent_configuration_doc, None);
    }
}
