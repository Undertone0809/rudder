use actix_web::{HttpResponse, ResponseError, http::StatusCode};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CollectorError {
    #[error("invalid configuration: {0}")]
    Configuration(String),
    #[error("invalid telemetry assertion")]
    Unauthorized,
    #[error("invalid request: {0}")]
    InvalidRequest(&'static str),
    #[error("invalid event: {0}")]
    InvalidEvent(&'static str),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migration(String),
    #[error("maintenance error: {0}")]
    Maintenance(String),
    #[error("internal collector error: {0}")]
    Internal(String),
}

#[derive(Serialize)]
struct ErrorBody {
    #[serde(rename = "errorCode")]
    error_code: &'static str,
}

impl ResponseError for CollectorError {
    fn status_code(&self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::InvalidRequest(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::InvalidEvent(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Database(_)
            | Self::Migration(_)
            | Self::Maintenance(_)
            | Self::Internal(_)
            | Self::Configuration(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn error_response(&self) -> HttpResponse {
        let error_code = match self {
            Self::Unauthorized => "unauthorized",
            Self::InvalidRequest(_) => "invalid_request",
            Self::InvalidEvent(_) => "invalid_event",
            Self::Database(_)
            | Self::Migration(_)
            | Self::Maintenance(_)
            | Self::Internal(_)
            | Self::Configuration(_) => "collector_request_failed",
        };
        HttpResponse::build(self.status_code()).json(ErrorBody { error_code })
    }
}
