//! Direct public Goal reads; resolution, native authorization and projection
//! share the existing read-only transaction. Selected routes never proxy.
use super::*;
use crate::goal_reads::NativeGoalReadTarget;
use crate::member_directory_auth::MemberDirectoryNativeAuth;
use futures_util::StreamExt;

pub(super) fn classify(request: &HttpRequest) -> Option<(String, GoalReadView)> {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return None;
    }
    let segments = request
        .path()
        .trim_end_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    if !(4..=5).contains(&segments.len())
        || !segments[1].eq_ignore_ascii_case("api")
        || !segments[2].eq_ignore_ascii_case("goals")
        || segments[3].is_empty()
    {
        return None;
    }
    let view = match segments.get(4).map(|suffix| suffix.to_ascii_lowercase()) {
        None => GoalReadView::Detail,
        Some(suffix) => match suffix.as_str() {
            "activities" => GoalReadView::Activities,
            "history" => GoalReadView::History,
            "dependencies" => GoalReadView::Dependencies,
            "workspace" => GoalReadView::Workspace,
            "timeline" => GoalReadView::Timeline,
            "agent-context" => GoalReadView::AgentContext,
            _ => return None,
        },
    };
    let reference = percent_encoding::percent_decode_str(segments[3])
        .decode_utf8()
        .ok()?
        .into_owned();
    Some((reference, view))
}

fn single_query_string(request: &HttpRequest, name: &str) -> Option<String> {
    let mut values = url::form_urlencoded::parse(request.query_string().as_bytes())
        .filter(|(key, _)| key == name);
    let value = values.next()?.1.into_owned();
    values.next().is_none().then_some(value)
}

pub(super) async fn dispatch(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    reference: String,
    view: GoalReadView,
) -> HttpResponse {
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "request_body_invalid");
        };
        if body.len().saturating_add(chunk.len()) > state.foundation.config.max_request_bytes {
            return state
                .foundation
                .json_error(StatusCode::PAYLOAD_TOO_LARGE, "request_body_too_large");
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let paged = matches!(view, GoalReadView::History | GoalReadView::Timeline);
    let input = GoalReadRequest {
        view,
        goal_id: None,
        cursor: paged
            .then(|| single_query_string(&request, "cursor"))
            .flatten(),
        limit: paged
            .then(|| single_query_string(&request, "limit"))
            .flatten(),
        agent_id: identity_agent_id(&identity).map(str::to_owned),
        lifecycle: None,
        focus: None,
        facet: None,
    };
    let agent_organization_id = match &identity {
        NativeIngressIdentity::AgentKey { org_id, .. } => Some(org_id.as_str()),
        NativeIngressIdentity::AgentJwt(identity) => Some(identity.org_id.as_str()),
        _ => None,
    };
    let target = NativeGoalReadTarget::Reference {
        reference: &reference,
        agent_organization_id,
    };
    let actor_session = agent_core::actor_and_session(&identity);
    match &identity {
        NativeIngressIdentity::Session(identity) => {
            state
                .foundation
                .goal_read_with_native_auth(
                    target,
                    &input,
                    MemberDirectoryNativeAuth::Session {
                        identity,
                        kind: state
                            .config
                            .session_auth
                            .as_ref()
                            .map_or(NativeSessionAuthKind::BetterAuth, |config| config.kind),
                    },
                    Some(&identity.user_id),
                )
                .await
        }
        NativeIngressIdentity::AgentKey { token_hash, .. }
        | NativeIngressIdentity::BoardKey { token_hash, .. } => {
            let Some((actor, session_id)) = actor_session.as_ref() else {
                return state
                    .foundation
                    .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
            };
            state
                .foundation
                .goal_read_with_native_auth(
                    target,
                    &input,
                    MemberDirectoryNativeAuth::Bearer {
                        actor,
                        session_id,
                        token_hash,
                    },
                    (actor.kind == "user").then_some(actor.id.as_str()),
                )
                .await
        }
        NativeIngressIdentity::AgentJwt(identity) => {
            state
                .foundation
                .goal_read_with_native_auth(
                    target,
                    &input,
                    MemberDirectoryNativeAuth::AgentJwt { identity },
                    None,
                )
                .await
        }
        NativeIngressIdentity::LocalImplicit => {
            state
                .foundation
                .goal_read_with_native_auth(
                    target,
                    &input,
                    MemberDirectoryNativeAuth::LocalImplicit,
                    Some("local-board"),
                )
                .await
        }
        NativeIngressIdentity::None => state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    #[test]
    fn only_the_existing_seven_singular_reads_are_reserved() {
        for suffix in [
            "",
            "/activities",
            "/history",
            "/dependencies",
            "/workspace",
            "/timeline",
            "/agent-context",
        ] {
            let request = TestRequest::get()
                .uri(&format!("/api/goals/gol_abcdef12{suffix}"))
                .to_http_request();
            assert!(classify(&request).is_some());
        }
        assert!(classify(&TestRequest::post().uri("/api/goals/id").to_http_request()).is_none());
        assert!(
            classify(
                &TestRequest::get()
                    .uri("/api/goals/id/feedback")
                    .to_http_request()
            )
            .is_none()
        );
        let request = TestRequest::get()
            .uri("/api/goals/id/history?limit=2&limit=3&cursor=")
            .to_http_request();
        assert_eq!(single_query_string(&request, "limit"), None);
        assert_eq!(single_query_string(&request, "cursor"), Some(String::new()));
    }
}
