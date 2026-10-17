//! Read-only recovery lookup for a previously accepted ordinary Chat send.
//!
//! This route never reserves worker capacity, consults the host runtime, or
//! dispatches a provider. A same-ID/different-body request is a D1 conflict;
//! a retry can only recover the exact persisted admission receipt.

use super::input::FirstSendInput;
use super::*;
use crate::browser_auth::BrowserAuthError;
use rudder_d1_persistence::native_chat::{self, Request};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReconcileInput {
    body: String,
    client_mutation_id: String,
}

pub(super) async fn reconcile(
    state: web::Data<IngressState>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    let chat = chat.into_inner();
    if let Err(response) = canonical(&request, &chat, "reconcile") {
        return response;
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    if body.len() > 128 * 1024 {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "chat_reconcile_too_large");
    }
    if !request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_required");
    }
    let input: ReconcileInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_chat_reconcile"),
    };
    let command = match input::submit_command(&chat, input.body, input.client_mutation_id) {
        Ok(command) => command,
        Err(error_) => return send::input_error(error_),
    };
    let Request::SubmitNativeChatTurn {
        client_mutation_id, ..
    } = &command;

    // Reconciliation is read-only and is available without a process worker,
    // host config, or an execution slot. The shared request gate only bounds
    // concurrent public database work; it cannot reserve or dispatch a job.
    let _request_permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, authenticated, organization_id) =
        match browser_actor(&state, &request, &chat, true).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    let actor = match authenticated.native_chat_principal(&organization_id) {
        Ok(actor) => actor,
        Err(BrowserAuthError::Forbidden | BrowserAuthError::Unauthorized) => {
            // Hide whether a target in an inaccessible organization exists.
            return error(StatusCode::NOT_FOUND, "chat_not_found");
        }
        Err(BrowserAuthError::Unavailable) => return unavailable(),
    };

    match native_chat::lookup_submission(&pool, &actor, &organization_id, &command).await {
        Ok(Some(receipt)) => {
            let Some(projection) = send::reconciliation_projection(
                receipt,
                &organization_id,
                &chat,
                client_mutation_id,
            ) else {
                return unavailable();
            };
            HttpResponse::Ok()
                .insert_header((header::CACHE_CONTROL, "no-store"))
                .json(projection)
        }
        Ok(None) => HttpResponse::Ok()
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .json(json!({
                "outcome":"not_found",
                "clientMutationId":client_mutation_id,
            })),
        Err(error_) => result::<Value>(Err(error_)),
    }
}

pub(super) async fn first_send_reconcile(
    state: web::Data<IngressState>,
    request: HttpRequest,
    organization: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    let organization_id = organization.into_inner();
    if Uuid::parse_str(&organization_id)
        .ok()
        .is_none_or(|id| id.to_string() != organization_id)
        || request.uri().path()
            != format!("/api/orgs/{organization_id}/chats/messages/stream/reconcile")
    {
        return error(StatusCode::NOT_FOUND, "route_not_found");
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    if body.len() > 128 * 1024 {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "chat_reconcile_too_large");
    }
    if !request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_required");
    }
    let input: FirstSendInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_chat_reconcile"),
    };
    let client_mutation_id = input.client_mutation_id().to_owned();
    let command = match input.into_command() {
        Ok(command) => command,
        Err(error_) => return send::input_error(error_),
    };
    let _request_permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, authenticated, organization_id) =
        match browser_actor_for_org(&state, &request, &organization_id, true).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    let actor = match authenticated.native_chat_principal(&organization_id) {
        Ok(actor) => actor,
        Err(BrowserAuthError::Forbidden | BrowserAuthError::Unauthorized) => {
            return error(StatusCode::NOT_FOUND, "chat_not_found");
        }
        Err(BrowserAuthError::Unavailable) => return unavailable(),
    };

    match native_chat::lookup_first_send_submission(&pool, &actor, &organization_id, &command).await
    {
        Ok(Some(receipt)) => {
            let Some(projection) = send::first_send_reconciliation_projection(
                receipt,
                &organization_id,
                &client_mutation_id,
            ) else {
                return unavailable();
            };
            HttpResponse::Ok()
                .insert_header((header::CACHE_CONTROL, "no-store"))
                .json(projection)
        }
        Ok(None) => HttpResponse::Ok()
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .json(json!({"outcome":"not_found","clientMutationId":client_mutation_id})),
        Err(error_) => result::<Value>(Err(error_)),
    }
}
