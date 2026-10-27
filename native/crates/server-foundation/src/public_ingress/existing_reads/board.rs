use super::*;
use paths::BoardRead;
use rudder_d1_persistence::{
    calendar::{CalendarError, execute_calendar},
    secrets::{SecretsError, database_unavailable, execute_secrets},
};
mod saved;

pub(super) async fn read(
    state: &IngressState,
    org: &str,
    user: &str,
    read: BoardRead,
    request: &HttpRequest,
) -> HttpResponse {
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return internal_error();
    };
    let query = query(request);
    match read {
        BoardRead::Secret(providers) => match execute_secrets(
            pool,
            org,
            user,
            &json!({"operation":if providers {"providers"}else{"list"}}),
        )
        .await
        {
            Ok((status, body)) => reply(status, body),
            Err(SecretsError::Http(status, message)) => reply_error(status, &message),
            Err(SecretsError::Database(database_error))
                if database_unavailable(&database_error) =>
            {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Rust Secrets is unavailable",
                )
            }
            Err(_) => internal_error(),
        },
        BoardRead::Calendar(operation, id) => {
            let id = match id {
                Some(id) => match decode(&id) {
                    Ok(id) => Some(id),
                    Err(response) => return response,
                },
                None => None,
            };
            let input = json!({"operation":operation,"id":id,"filters":query});
            match execute_calendar(pool, org, user, None, &input).await {
                Ok((status, body)) => reply(status, body),
                Err(CalendarError::Http(status, message)) => reply_error(status, &message),
                Err(_) => internal_error(),
            }
        }
        BoardRead::Saved(id) => saved::read(pool, org, user, id, &query).await,
        BoardRead::Backup(None) => {
            let response = state.foundation.workspace_backups_response(org, true).await;
            if response.status() == StatusCode::NOT_FOUND {
                error(StatusCode::NOT_FOUND, "Organization not found")
            } else if response.status().is_server_error() {
                internal_error()
            } else {
                response
            }
        }
        BoardRead::Backup(Some((id, operation))) => {
            let id = match decode(&id) {
                Ok(id) => id,
                Err(response) => return response,
            };
            let path = if operation == "download" {
                ""
            } else {
                query.get("path").and_then(Value::as_str).unwrap_or("")
            };
            let input = json!({"backupId":id,"operation":operation,"path":path});
            crate::workspace_backup_reads::read_authorized(
                &state.foundation,
                org,
                &serde_json::to_vec(&input).expect("JSON backup read input"),
            )
            .await
        }
    }
}
fn reply(status: u16, body: Value) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(body)
}
fn reply_error(status: u16, message: &str) -> HttpResponse {
    error(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        message,
    )
}
