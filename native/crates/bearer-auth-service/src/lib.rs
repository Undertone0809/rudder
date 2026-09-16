//! Private, SQL-backed bearer authentication for future Actix integration.
//! Sessions, OAuth, implicit local operators, and public listener activation
//! remain owned by the existing server. This crate never grants an anonymous
//! request board privileges and never constructs an actor from request JSON.

mod jwt;
mod middleware;
mod store;

pub use jwt::{AuthConfigError, JwtConfig};
pub use middleware::BearerAuth;
pub use store::BearerAuthenticator;

use actix_web::{
    FromRequest, HttpMessage, HttpRequest, HttpResponse, ResponseError, http::StatusCode,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::future::{Ready, ready};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorSource {
    None,
    BoardKey,
    AgentKey,
    AgentJwt,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Actor {
    None {
        source: ActorSource,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
    },
    Board {
        user_id: String,
        org_ids: Vec<String>,
        is_instance_admin: bool,
        key_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        source: ActorSource,
    },
    Agent {
        agent_id: String,
        org_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        key_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        adapter_type: Option<String>,
        source: ActorSource,
    },
}

/// The private representation prevents callers from fabricating authenticated
/// identities. It is serializable for response parity, never deserializable.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TrustedActor(Actor);
impl TrustedActor {
    fn anonymous(run: Option<&str>) -> Self {
        Self(Actor::None {
            source: ActorSource::None,
            run_id: run.map(str::to_owned),
        })
    }
    pub fn source(&self) -> ActorSource {
        match &self.0 {
            Actor::None { source, .. }
            | Actor::Board { source, .. }
            | Actor::Agent { source, .. } => *source,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self.0 {
            Actor::None { .. } => "none",
            Actor::Board { .. } => "board",
            Actor::Agent { .. } => "agent",
        }
    }
    pub fn agent_id(&self) -> Option<&str> {
        match &self.0 {
            Actor::Agent { agent_id, .. } => Some(agent_id),
            _ => None,
        }
    }
    pub fn run_id(&self) -> Option<&str> {
        match &self.0 {
            Actor::None { run_id, .. }
            | Actor::Board { run_id, .. }
            | Actor::Agent { run_id, .. } => run_id.as_deref(),
        }
    }
    /// Request-time scope only; transaction-connected writers must recheck
    /// membership/status when their mutation requires current authorization.
    pub fn require_organization(&self, org: &str) -> Result<(), AuthorizationError> {
        match &self.0 {
            Actor::Board {
                is_instance_admin,
                org_ids,
                ..
            } if *is_instance_admin || org_ids.iter().any(|id| id == org) => Ok(()),
            Actor::Agent { org_id, .. } if org_id == org => Ok(()),
            Actor::None { .. } => Err(AuthorizationError::Unauthenticated),
            _ => Err(AuthorizationError::Forbidden),
        }
    }
    fn check_context(
        &self,
        method: &str,
        agent: Option<&str>,
        run: Option<&str>,
    ) -> Result<(), ContextError> {
        if self.source() == ActorSource::AgentJwt
            && let Some(run) = run.filter(|run| Some(*run) != self.run_id())
        {
            return Err(ContextError {
                status: StatusCode::FORBIDDEN,
                error: "Agent run header does not match the signed runtime context",
                code: "agent_run_context_mismatch",
                details: json!({"signedRunId":self.run_id(),"requestedRunId":run}),
            });
        }
        let Some(expected) = agent.filter(|_| !matches!(method, "GET" | "HEAD" | "OPTIONS")) else {
            return Ok(());
        };
        let Some(actual) = self.agent_id() else {
            return Err(ContextError {
                status: StatusCode::UNAUTHORIZED,
                error: "Agent authentication required for agent-scoped CLI request",
                code: "agent_auth_required",
                details: json!({"expectedAgentId":expected,"actorType":self.kind(),"actorSource":self.source()}),
            });
        };
        if actual != expected {
            return Err(ContextError {
                status: StatusCode::FORBIDDEN,
                error: "Agent authentication does not match the CLI agent context",
                code: "agent_context_mismatch",
                details: json!({"expectedAgentId":expected,"authenticatedAgentId":actual}),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Database authentication lookup failed")]
    Database(#[from] sqlx::Error),
}
impl ResponseError for AuthError {
    fn error_response(&self) -> HttpResponse {
        HttpResponse::InternalServerError().json(json!({"error":"Authentication lookup failed"}))
    }
}

#[derive(Debug, Error)]
pub enum AuthorizationError {
    #[error("Authentication required")]
    Unauthenticated,
    #[error("Board access required")]
    BoardRequired,
    #[error("Organization access forbidden")]
    Forbidden,
}
impl ResponseError for AuthorizationError {
    fn status_code(&self) -> StatusCode {
        if matches!(self, Self::Unauthenticated) {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        }
    }
    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code()).json(json!({"error":self.to_string()}))
    }
}

#[derive(Debug, Serialize)]
struct ContextError {
    #[serde(skip)]
    status: StatusCode,
    error: &'static str,
    code: &'static str,
    details: Value,
}
impl std::fmt::Display for ContextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.error)
    }
}
impl std::error::Error for ContextError {}
impl ResponseError for ContextError {
    fn status_code(&self) -> StatusCode {
        self.status
    }
    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status).json(self)
    }
}

#[derive(Clone, Debug)]
pub struct AuthenticatedActor(pub TrustedActor);
impl FromRequest for AuthenticatedActor {
    type Error = AuthorizationError;
    type Future = Ready<Result<Self, Self::Error>>;
    fn from_request(req: &HttpRequest, _: &mut actix_web::dev::Payload) -> Self::Future {
        ready(match req.extensions().get::<TrustedActor>().cloned() {
            Some(actor) if actor.kind() != "none" => Ok(Self(actor)),
            _ => Err(AuthorizationError::Unauthenticated),
        })
    }
}

#[derive(Clone, Debug)]
pub struct BoardActor(pub TrustedActor);
impl FromRequest for BoardActor {
    type Error = AuthorizationError;
    type Future = Ready<Result<Self, Self::Error>>;
    fn from_request(req: &HttpRequest, _: &mut actix_web::dev::Payload) -> Self::Future {
        ready(match req.extensions().get::<TrustedActor>().cloned() {
            Some(actor) if actor.kind() == "board" => Ok(Self(actor)),
            Some(actor) if actor.kind() == "agent" => Err(AuthorizationError::BoardRequired),
            _ => Err(AuthorizationError::Unauthenticated),
        })
    }
}

fn valid_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
// End of private actor and extractor definitions.
