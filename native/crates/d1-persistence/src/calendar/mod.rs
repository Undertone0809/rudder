//! Calendar source and event authority for the public calendar routes.
//!
//! The Node adapter authenticates the board user and signs this bounded command;
//! all validation, organization checks, SQL projections, writes, and activity
//! delivery intent live here. Google OAuth/configuration and provider sync stay
//! deliberately outside this contract.
mod audit;
mod common;
mod events;
mod projections;
mod sources;

use common::Audit;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum CalendarError {
    #[error("{0}")]
    Http(u16, String),
    #[error("calendar database operation failed")]
    Database(#[from] sqlx::Error),
}

pub(crate) type Result<T> = std::result::Result<T, CalendarError>;

fn http(status: u16, message: impl Into<String>) -> CalendarError {
    CalendarError::Http(status, message.into())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub async fn execute_calendar(
    pool: &PgPool,
    org: &str,
    actor_id: &str,
    run_id: Option<&str>,
    request: &Value,
) -> Result<(u16, Value)> {
    let org = Uuid::parse_str(org)
        .map_err(|_| http(422, "Invalid organization id"))?
        .to_string();
    let actor = Audit {
        actor_type: "user",
        actor_id: actor_id.to_owned(),
        run_id: run_id.map(str::to_owned),
    };
    let operation = text(request, "operation").ok_or_else(|| http(400, "Validation error"))?;
    let result = match operation {
        "source.list" => (200, sources::list_sources(pool, &org).await?),
        "source.create" => (
            201,
            sources::source_create(
                pool,
                &org,
                &actor,
                request
                    .get("input")
                    .ok_or_else(|| http(400, "Validation error"))?,
            )
            .await?,
        ),
        "source.update" => (
            200,
            sources::source_update(
                pool,
                &org,
                &actor,
                text(request, "id").ok_or_else(|| http(400, "Validation error"))?,
                request
                    .get("input")
                    .ok_or_else(|| http(400, "Validation error"))?,
            )
            .await?,
        ),
        "source.delete" => (
            200,
            sources::source_delete(
                pool,
                &org,
                &actor,
                text(request, "id").ok_or_else(|| http(400, "Validation error"))?,
            )
            .await?,
        ),
        "event.list" => {
            let filters = events::parse_filters(
                request
                    .get("filters")
                    .ok_or_else(|| http(400, "Validation error"))?,
            )?;
            (
                200,
                events::list_events(pool, &org, &actor.actor_id, &filters).await?,
            )
        }
        "event.create" => (
            201,
            events::event_create(
                pool,
                &org,
                &actor,
                request
                    .get("input")
                    .ok_or_else(|| http(400, "Validation error"))?,
            )
            .await?,
        ),
        "event.detail" => {
            let id = text(request, "id").ok_or_else(|| http(400, "Validation error"))?;
            if let Some(run_id) = id.strip_prefix("run:") {
                let start = "1970-01-01T00:00:00.000Z";
                let end = (time::OffsetDateTime::now_utc() + time::Duration::days(365))
                    .format(&time::format_description::well_known::Rfc3339)
                    .map_err(|_| http(500, "Internal server error"))?;
                let runs = projections::list_derived_events(
                    pool,
                    &org,
                    &actor.actor_id,
                    start,
                    &end,
                    &[],
                    &[],
                    &[],
                    &[],
                    Some(run_id),
                )
                .await?;
                match runs.into_iter().next() {
                    Some(event) => (200, event),
                    None => (404, json!({"error":"Calendar event not found"})),
                }
            } else {
                match events::get_persisted_event(pool, &org, id).await? {
                    Some(event) => (200, event),
                    None => (404, json!({"error":"Calendar event not found"})),
                }
            }
        }
        "event.update" => (
            200,
            events::event_update(
                pool,
                &org,
                &actor,
                text(request, "id").ok_or_else(|| http(400, "Validation error"))?,
                request
                    .get("input")
                    .ok_or_else(|| http(400, "Validation error"))?,
            )
            .await?,
        ),
        "event.delete" => (
            200,
            events::event_delete(
                pool,
                &org,
                &actor,
                text(request, "id").ok_or_else(|| http(400, "Validation error"))?,
            )
            .await?,
        ),
        _ => return Err(http(400, "Validation error")),
    };
    Ok(result)
}
