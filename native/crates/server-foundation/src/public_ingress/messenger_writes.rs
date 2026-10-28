//! Complete public Messenger personal-state write entrypoints. The existing
//! Foundation writer owns transactions; Rust also owns the eight former Node
//! workflows. Every selected native failure is terminal, never proxied.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use futures_util::StreamExt;
use serde_json::json;
#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod tests;
mod validation;
#[derive(Debug, PartialEq, Eq)]
struct Endpoint {
    org: Option<String>,
    id: Option<String>,
    operation: &'static str,
}
fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let raw = path.split('/').collect::<Vec<_>>();
    if raw.iter().any(|s| s.is_empty()) {
        return None;
    }
    let lower = raw
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let parts = lower.iter().map(String::as_str).collect::<Vec<_>>();
    let (org, id, op) = match (parts.as_slice(), method.as_str()) {
        (["api", "orgs", _, "messenger", "saved-views", "keep"], "POST") => {
            (Some(raw[2]), None, "savedViewKeep")
        }
        (["api", "orgs", _, "messenger", "saved-views"], "POST") => (Some(raw[2]), None, "retired"),
        (["api", "orgs", _, "messenger", "saved-views", "reorder"], "PATCH") => {
            (Some(raw[2]), None, "savedViewReorder")
        }
        (["api", "orgs", _, "messenger", "saved-views", _], "PATCH") => {
            (Some(raw[2]), Some(raw[5]), "savedViewUpdate")
        }
        (["api", "orgs", _, "messenger", "saved-views", _], "DELETE") => {
            (Some(raw[2]), Some(raw[5]), "savedViewDelete")
        }
        (["api", "orgs", _, "messenger", "groups"], "POST") => (Some(raw[2]), None, "groupCreate"),
        (["api", "orgs", _, "messenger", "groups", "merge"], "POST") => {
            (Some(raw[2]), None, "groupMerge")
        }
        (["api", "orgs", _, "messenger", "groups", "reorder"], "PATCH") => {
            (Some(raw[2]), None, "groupReorder")
        }
        (["api", "orgs", _, "messenger", "groups", _], "PATCH") => {
            (Some(raw[2]), Some(raw[5]), "groupUpdate")
        }
        (["api", "orgs", _, "messenger", "groups", _], "DELETE") => {
            (Some(raw[2]), Some(raw[5]), "groupDelete")
        }
        (["api", "orgs", _, "messenger", "groups", _, "separate"], "POST") => {
            (Some(raw[2]), Some(raw[5]), "groupSeparate")
        }
        (
            [
                "api",
                "orgs",
                _,
                "messenger",
                "groups",
                _,
                "title",
                "regenerate",
            ],
            "POST",
        ) => (Some(raw[2]), Some(raw[5]), "groupRegenerate"),
        (["api", "orgs", _, "messenger", "groups", _, "entries"], "POST") => {
            (Some(raw[2]), Some(raw[5]), "groupEntryAssign")
        }
        (
            [
                "api",
                "orgs",
                _,
                "messenger",
                "groups",
                _,
                "entries",
                "reorder",
            ],
            "PATCH",
        ) => (Some(raw[2]), Some(raw[5]), "groupEntryReorder"),
        (["api", "orgs", _, "messenger", "groups", "entries", _], "DELETE") => {
            (Some(raw[2]), Some(raw[6]), "groupEntryRemove")
        }
        (["api", "orgs", _, "messenger", "threads", _, "read"], "POST") => {
            (Some(raw[2]), Some(raw[5]), "threadRead")
        }
        (["api", "orgs", _, "messenger", "threads", _, "user-state"], "POST") => {
            (Some(raw[2]), Some(raw[5]), "threadUserState")
        }
        (["api", "orgs", _, "messenger", "unreads", "dismiss"], "POST") => {
            (Some(raw[2]), None, "dismissUnreads")
        }
        (["api", "issues", _, "read"], "POST") => (None, Some(raw[2]), "issueRead"),
        (["api", "issues", _, "follow"], "POST") => (None, Some(raw[2]), "issueFollow"),
        (["api", "issues", _, "follow"], "DELETE") => (None, Some(raw[2]), "issueUnfollow"),
        _ => return None,
    };
    Some(Endpoint {
        org: org.map(str::to_owned),
        id: id.map(str::to_owned),
        operation: op,
    })
}
pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint(path, method).is_some()
}
fn error(status: u16, message: &str) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(json!({"error":message}))
}
#[allow(clippy::result_large_err)]
fn decode(raw: &str) -> Result<String, HttpResponse> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| error(400, "Failed to decode path parameter"))
}
pub(super) async fn handle(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(mut route) = endpoint(request.uri().path(), request.method()) else {
        return error(404, "Not found");
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return error(400, "Invalid request body");
        };
        if body.len() + chunk.len()
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return error(413, "Request body is too large");
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    let json_body = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    let raw = if body.is_empty() || !json_body {
        None
    } else {
        match rudder_d1_persistence::agent_core::parse_public_json_value(
            std::str::from_utf8(&body).unwrap_or(""),
        ) {
            Ok(v) => Some(v),
            Err(_) => return error(400, "Invalid JSON body"),
        }
    };
    if let Some(org) = &route.org {
        route.org = match decode(org) {
            Ok(org) => Some(org),
            Err(r) => return r,
        };
    }
    if let Some(id) = &route.id {
        route.id = match decode(id) {
            Ok(id) => Some(id),
            Err(r) => return r,
        };
    }
    let needs_schema = matches!(
        route.operation,
        "savedViewKeep"
            | "savedViewUpdate"
            | "savedViewReorder"
            | "groupCreate"
            | "groupUpdate"
            | "groupMerge"
            | "groupReorder"
            | "groupEntryAssign"
            | "groupEntryReorder"
            | "threadUserState"
    );
    let normalized = if needs_schema {
        match validation::normalize(route.operation, raw.as_ref()) {
            Ok(v) => v,
            Err(details) => {
                return HttpResponse::BadRequest()
                    .json(json!({"error":"Validation error","details":details}));
            }
        }
    } else {
        json!({})
    };
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if state.config.identity_auth.is_none() {
        return error(503, "Rust Messenger state is unavailable");
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session)) = agent_core::actor_and_session(&identity) else {
        return error(401, "Unauthorized");
    };
    if actor.kind != "user" {
        return error(403, "Board access required");
    }
    if matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return error(403, crate::local_account_ingress::BOARD_ORIGIN_ERROR);
    }
    let Some(auth) = agent_core::native_authorizer(&identity, &actor, &session, &state) else {
        return error(401, "Unauthorized");
    };
    let user = match crate::run_reads::native_run_owner(&identity) {
        Ok(Some(user)) => user,
        Ok(None) => return error(403, "Board access required"),
        Err(response) => return response,
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return error(503, "Request queue is full"),
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return error(503, "Rust Messenger state is unavailable");
    };
    let org = if let Some(org) = route.org {
        match Uuid::parse_str(&org) {
            Ok(id) => id.to_string(),
            Err(_) => return error(500, "Internal server error"),
        }
    } else {
        use super::issue_core::{IssuePathLookup, resolve_issue_path_reference};
        match resolve_issue_path_reference(
            pool,
            route.id.as_deref().unwrap(),
            None,
            Some(user),
            matches!(&identity, NativeIngressIdentity::LocalImplicit),
        )
        .await
        {
            Ok(IssuePathLookup::Found { issue_id, org_id }) => {
                route.id = Some(issue_id);
                org_id
            }
            Ok(IssuePathLookup::Missing) => return error(404, "Issue not found"),
            Ok(IssuePathLookup::Ambiguous) => {
                return error(
                    409,
                    "Issue ID short reference is ambiguous in this organization. Use a longer typed ref.",
                );
            }
            Ok(IssuePathLookup::Invalid) => {
                return error(
                    422,
                    "Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference",
                );
            }
            Err(_) => return error(500, "Internal server error"),
        }
    };
    let id = route.id.as_deref().unwrap_or("");
    if matches!(route.operation, "savedViewUpdate" | "savedViewDelete")
        && (id.len() != 36 || Uuid::parse_str(id).is_err())
    {
        return HttpResponse::BadRequest().json(json!({"error":"Validation error","details":[{"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":[]}]}));
    }
    let command = match route.operation {
        "savedViewKeep" => json!({"operation":route.operation,"input":normalized}),
        "savedViewUpdate" => json!({"operation":route.operation,"id":id,"patch":normalized}),
        "savedViewDelete" => json!({"operation":route.operation,"id":id}),
        "savedViewReorder" => json!({"operation":route.operation,"ids":normalized["ids"]}),
        "groupCreate" => {
            json!({"operation":route.operation,"name":normalized["name"],"icon":normalized["icon"]})
        }
        "groupUpdate" => json!({"operation":route.operation,"groupId":id,"patch":normalized}),
        "groupMerge" => {
            json!({"operation":route.operation,"name":normalized["name"],"icon":normalized["icon"],"itemKeys":normalized["itemKeys"],"anchorItemKey":normalized["anchorItemKey"],"autoGenerateName":normalized["autoGenerateName"]})
        }
        "groupReorder" => json!({"operation":route.operation,"groupIds":normalized["groupIds"]}),
        "groupEntryAssign" => {
            json!({"operation":route.operation,"groupId":id,"itemKey":normalized["itemKey"]})
        }
        "groupEntryReorder" => {
            json!({"operation":route.operation,"groupId":id,"itemKeys":normalized["itemKeys"]})
        }
        "groupDelete" | "groupSeparate" | "groupRegenerate" => {
            json!({"operation":route.operation,"groupId":id})
        }
        "groupEntryRemove" => json!({"operation":route.operation,"itemKey":id}),
        "threadUserState" => {
            json!({"operation":route.operation,"threadKey":id,"pinned":normalized["pinned"]})
        }
        "threadRead" => {
            json!({"operation":route.operation,"threadKey":id,"readAt":raw.as_ref().and_then(|v|v["lastReadAt"].as_str()).and_then(super::run_reads::js_date_to_iso),"chatLatest":true})
        }
        "issueRead" | "issueFollow" | "issueUnfollow" => {
            json!({"operation":route.operation,"issueId":id})
        }
        _ => json!({"operation":route.operation}),
    };
    crate::messenger_state::public_write(
        pool,
        &org,
        user,
        command,
        &auth,
        state
            .config
            .native_chat_runtime
            .as_ref()
            .map(|runtime| &runtime.paths),
    )
    .await
}
