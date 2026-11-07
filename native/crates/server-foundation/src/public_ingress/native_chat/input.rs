//! Public input validation happens before any admission or dispatch write.
//! Only user input crosses this wire; identity and host facts remain server-owned.
use rudder_d1_persistence::native_chat::{FirstSendRequest, Request};
use serde::Deserialize;
use serde_json::Value;

/// The existing UI sends null model/effort defaults. Accept those defaults
/// without silently discarding a concrete override or another unsupported input.
/// Deliberately no Debug: message text and annotations are user content.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendInput {
    body: String,
    client_mutation_id: String,
    model_override: Option<String>,
    effort_override: Option<String>,
    edit_user_message_id: Option<String>,
    queued_message_id: Option<String>,
    #[serde(default)]
    inline_annotations: Vec<Value>,
}

/// First-message input carries only existing browser choices implemented by
/// the Rust first-send authority. The UI's empty contextLinks array and false
/// planMode default are accepted for wire compatibility; populated unsupported
/// values fail before worker reservation or any write.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FirstSendInput {
    body: String,
    client_mutation_id: String,
    preferred_agent_id: Option<String>,
    title: Option<String>,
    issue_creation_mode: Option<String>,
    model_override: Option<String>,
    effort_override: Option<String>,
    plan_mode: Option<bool>,
    #[serde(default)]
    context_links: Vec<Value>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum InputError {
    InvalidConversation,
    InvalidMutationId,
    InvalidBody,
    UnsupportedInput,
}

impl SendInput {
    pub(super) fn into_command(self, conversation: &str) -> Result<Request, InputError> {
        if self.model_override.is_some()
            || self.effort_override.is_some()
            || self.edit_user_message_id.is_some()
            || self.queued_message_id.is_some()
            || !self.inline_annotations.is_empty()
        {
            return Err(InputError::UnsupportedInput);
        }
        submit_command(conversation, self.body, self.client_mutation_id)
    }
}

impl FirstSendInput {
    pub(super) fn into_command(self) -> Result<FirstSendRequest, InputError> {
        if self.plan_mode == Some(true) || !self.context_links.is_empty() {
            return Err(InputError::UnsupportedInput);
        }
        // Keep the D1 DTO strict and non-publicly constructible. This ingress
        // conversion only omits the accepted empty compatibility fields.
        serde_json::from_value(serde_json::json!({
            "body": self.body,
            "clientMutationId": self.client_mutation_id,
            "preferredAgentId": self.preferred_agent_id,
            "title": self.title,
            "issueCreationMode": self.issue_creation_mode,
            "modelOverride": self.model_override,
            "effortOverride": self.effort_override,
            "planMode": false,
        }))
        .map_err(|_| InputError::UnsupportedInput)
    }
}

pub(super) fn submit_command(
    conversation: &str,
    body: String,
    client_mutation_id: String,
) -> Result<Request, InputError> {
    let conversation_id = uuid::Uuid::parse_str(conversation)
        .map_err(|_| InputError::InvalidConversation)?
        .to_string();
    // Reject aliases at the authoritative path; never turn a malformed
    // Native request into a legacy-proxy request.
    if conversation_id != conversation {
        return Err(InputError::InvalidConversation);
    }
    let mutation = client_mutation_id.trim();
    if mutation.is_empty() || mutation.len() > 120 || mutation.chars().any(char::is_control) {
        return Err(InputError::InvalidMutationId);
    }
    let body = body.trim();
    if body.is_empty() || body.chars().count() > 20_000 {
        return Err(InputError::InvalidBody);
    }
    Ok(Request::SubmitNativeChatTurn {
        conversation_id,
        client_mutation_id: mutation.to_owned(),
        body: body.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const CHAT: &str = "21000000-0000-4000-8000-000000000001";

    #[test]
    fn ui_null_defaults_preserve_new_input_and_stable_retry_identity() {
        let input: SendInput = serde_json::from_value(json!({
            "body":"  New question 🌍  ", "clientMutationId":"retry-1",
            "modelOverride":null, "effortOverride":null,
            "editUserMessageId":null, "queuedMessageId":null, "inlineAnnotations":[]
        }))
        .unwrap();
        let Request::SubmitNativeChatTurn {
            conversation_id,
            client_mutation_id,
            body,
        } = input.into_command(CHAT).unwrap();
        assert_eq!(conversation_id, CHAT);
        assert_eq!(client_mutation_id, "retry-1");
        assert_eq!(body, "New question 🌍");
    }

    #[test]
    fn client_authority_and_unsupported_content_cannot_be_silently_dropped() {
        for key in [
            "orgId",
            "agentId",
            "actor",
            "hostPath",
            "profileId",
            "history",
            "files",
        ] {
            let mut value = json!({"body":"hi", "clientMutationId":"retry-1"});
            value[key] = json!("untrusted");
            assert!(serde_json::from_value::<SendInput>(value).is_err());
        }
        for (key, value) in [
            ("modelOverride", json!("another-model")),
            ("effortOverride", json!("high")),
            ("editUserMessageId", json!("old-message")),
            ("queuedMessageId", json!("queued-message")),
            ("inlineAnnotations", json!([{"text":"citation"}])),
        ] {
            let mut payload = json!({"body":"hi", "clientMutationId":"retry-1"});
            payload[key] = value;
            let input: SendInput = serde_json::from_value(payload).unwrap();
            assert!(matches!(
                input.into_command(CHAT),
                Err(InputError::UnsupportedInput)
            ));
        }
        // Missing idempotency identity is never replaced with a per-request ID.
        assert!(serde_json::from_value::<SendInput>(json!({"body":"hi"})).is_err());
        assert!(
            serde_json::from_str::<SendInput>(
                r#"{"body":"a","body":"b","clientMutationId":"retry-1"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn first_send_accepts_only_empty_ui_compatibility_defaults() {
        let input: FirstSendInput = serde_json::from_value(json!({
            "body":"first message",
            "clientMutationId":"first-send-1",
            "preferredAgentId":"50000000-0000-4000-8000-000000000001",
            "modelOverride":null,
            "effortOverride":null,
            "planMode":false,
            "contextLinks":[]
        }))
        .unwrap();
        assert!(input.into_command().is_ok());

        for payload in [
            json!({"body":"x","clientMutationId":"id","contextLinks":[{"url":"https://example.test"}]}),
            json!({"body":"x","clientMutationId":"id","planMode":true}),
        ] {
            let input = serde_json::from_value::<FirstSendInput>(payload).unwrap();
            assert!(
                matches!(input.into_command(), Err(InputError::UnsupportedInput)),
                "unsupported first-send fields must fail before admission"
            );
        }
        for payload in [
            json!({"body":"x","clientMutationId":"id","actor":{"kind":"user"}}),
            json!({"body":"x","clientMutationId":"id","history":["old"]}),
        ] {
            assert!(serde_json::from_value::<FirstSendInput>(payload).is_err());
        }
    }
}
