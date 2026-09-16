//! Private Rust Agent API-key service. No production listener registers it yet.
//!
//! The legacy `pcp_` token and SHA-256 storage formats are preserved. Callers
//! must supply a board grant from trusted authentication, never request JSON.

pub mod http;
mod store;

use actix_web::{HttpResponse, ResponseError, http::StatusCode};
use serde::Serialize;
use std::fmt;
use thiserror::Error;

pub use store::AgentKeyStore;

/// Non-deserializable proof that the existing authority authorized this board.
/// This is an integration boundary, not an authentication implementation.
#[derive(Clone, Debug)]
pub struct BoardGrant {
    pub(crate) org_id: String,
    pub(crate) principal_id: String,
}
impl BoardGrant {
    pub fn after_authorization(org_id: &str, principal_id: &str) -> Result<Self, KeyError> {
        validate_uuid(org_id)?;
        if principal_id.is_empty() || principal_id.contains('\0') || principal_id.len() > 1024 {
            return Err(KeyError::Unauthorized);
        }
        Ok(Self {
            org_id: org_id.to_ascii_lowercase(),
            principal_id: principal_id.into(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyMetadata {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

/// Only the create response contains plaintext. Debug output always redacts it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedKey {
    pub id: String,
    pub name: String,
    pub token: String,
    pub created_at: String,
}
impl fmt::Debug for IssuedKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IssuedKey")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("token", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// Authentication result at one instant; mutation services recheck authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentIdentity {
    pub org_id: String,
    pub agent_id: String,
    pub role: String,
}

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("Board authentication required")]
    Unauthorized,
    #[error("Invalid request")]
    InvalidInput,
    #[error("Agent not found")]
    AgentNotFound,
    #[error("Key not found")]
    KeyNotFound,
    #[error("Cannot create keys for pending approval agents")]
    PendingApproval,
    #[error("Cannot create keys for terminated agents")]
    Terminated,
    #[error("Secure random generation failed")]
    Entropy,
    #[error("Database transaction failed")]
    Database(#[from] sqlx::Error),
}
impl ResponseError for KeyError {
    fn status_code(&self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::InvalidInput => StatusCode::BAD_REQUEST,
            Self::AgentNotFound | Self::KeyNotFound => StatusCode::NOT_FOUND,
            Self::PendingApproval | Self::Terminated => StatusCode::CONFLICT,
            Self::Database(_) | Self::Entropy => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code()).json(serde_json::json!({"error": self.to_string()}))
    }
}

pub(crate) fn validate_uuid(value: &str) -> Result<(), KeyError> {
    let valid = value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        });
    if !valid {
        return Err(KeyError::InvalidInput);
    }
    Ok(())
}
