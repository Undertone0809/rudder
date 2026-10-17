//! Fenced Run-span admission and Native Segment locator persistence.

use rudder_auth_core::VerifiedActor;
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

pub use crate::runtime_bindings::Error;

mod admission;
mod context;
mod locator;
mod projection;
mod reads;
mod validation;

type Result<T> = std::result::Result<T, Error>;

/// Strict signed-internal contract for one primary span per durable attempt.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Open {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "attemptEpoch")]
        attempt_epoch: i32,
        #[serde(rename = "ownerToken")]
        owner_token: String,
        #[serde(rename = "bindingId")]
        binding_id: String,
        #[serde(rename = "segmentId")]
        segment_id: String,
    },
    BindLocator {
        #[serde(rename = "spanId")]
        span_id: String,
        #[serde(rename = "attemptId")]
        attempt_id: String,
        #[serde(rename = "attemptEpoch")]
        attempt_epoch: i32,
        #[serde(rename = "ownerToken")]
        owner_token: String,
        #[serde(rename = "nativeSessionId")]
        native_session_id: String,
        #[serde(default, rename = "rootSessionId")]
        root_session_id: Option<String>,
        #[serde(default, rename = "leafId")]
        leaf_id: Option<String>,
    },
    Read {
        #[serde(rename = "spanId")]
        span_id: String,
    },
    ReadTranscript {
        #[serde(rename = "spanId")]
        span_id: String,
        #[serde(default, rename = "afterSeq")]
        after_seq: i32,
        #[serde(default = "default_transcript_limit")]
        limit: i32,
    },
    ReadMessageTranscript {
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(default, rename = "afterSeq")]
        after_seq: i32,
        #[serde(default = "default_transcript_limit")]
        limit: i32,
    },
}

fn default_transcript_limit() -> i32 {
    100
}

/// Execute a Run-span operation in Rust with fresh actor and organization checks.
pub async fn execute(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &Request,
) -> Result<Value> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    if actor.organization_id() != organization_id {
        return Err(validation::http(403, "Organization access denied"));
    }

    match request {
        Request::Open { .. } => admission::open(pool, actor, &organization_id, request).await,
        Request::BindLocator { .. } => locator::bind(pool, actor, &organization_id, request).await,
        Request::Read { span_id } => reads::read(pool, actor, &organization_id, span_id).await,
        Request::ReadTranscript { .. } => {
            reads::read_transcript(pool, actor, &organization_id, request).await
        }
        Request::ReadMessageTranscript { .. } => {
            reads::read_message_transcript(pool, actor, &organization_id, request).await
        }
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_is_tagged_strict_and_camel_case() {
        let parsed: Request = serde_json::from_value(json!({
            "operation":"open",
            "runId":"60000000-0000-4000-8000-000000000001",
            "attemptId":"61000000-0000-4000-8000-000000000001",
            "attemptEpoch":3,
            "ownerToken":"opaque-owner-token",
            "bindingId":"62000000-0000-4000-8000-000000000001",
            "segmentId":"63000000-0000-4000-8000-000000000001"
        }))
        .unwrap();
        assert!(matches!(parsed, Request::Open { .. }));
        let transcript: Request = serde_json::from_value(json!({
            "operation":"read_transcript",
            "spanId":"60000000-0000-4000-8000-000000000001",
            "afterSeq":4,
            "limit":25
        }))
        .unwrap();
        assert!(matches!(
            transcript,
            Request::ReadTranscript {
                after_seq: 4,
                limit: 25,
                ..
            }
        ));
        let message_transcript: Request = serde_json::from_value(json!({
            "operation":"read_message_transcript",
            "messageId":"60000000-0000-4000-8000-000000000001",
            "afterSeq":7,
            "limit":10
        }))
        .unwrap();
        assert!(matches!(
            message_transcript,
            Request::ReadMessageTranscript {
                after_seq: 7,
                limit: 10,
                ..
            }
        ));

        for invalid in [
            json!({"operation":"open","runId":"x","attemptId":"x","attemptEpoch":0,"ownerToken":"x","bindingId":"x","segmentId":"x","ordinal":5}),
            json!({"operation":"bind_locator","spanId":"x","attemptId":"x","attemptEpoch":1,"ownerToken":"x","nativeSessionId":"session","providerState":{"token":"secret"}}),
            json!({"operation":"read","spanId":"x","ownerToken":"must-not-be-accepted"}),
            json!({"operation":"read_transcript","spanId":"x","afterSeq":0,"limit":100,"ownerToken":"must-not-be-accepted"}),
            json!({"operation":"read_message_transcript","messageId":"x","afterSeq":0,"limit":100,"ownerToken":"must-not-be-accepted"}),
            json!({"operation":"delete","spanId":"x"}),
        ] {
            assert!(serde_json::from_value::<Request>(invalid).is_err());
        }
    }
}
