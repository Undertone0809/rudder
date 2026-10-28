//! Public Browser/Computer ingress. Electron owns UI primitives only; native
//! policy, Run scope, registration and receipts remain on this listener.
use super::*;
use crate::{desktop_broker::Kind, desktop_capability, native_session_auth::NativeIngressIdentity};
use futures_util::StreamExt;
use serde_json::{Value, json};

#[derive(Debug, PartialEq)]
pub(super) enum Endpoint {
    Registry(Kind),
    Readiness,
    Action(Kind, String),
}
pub(super) fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    if parts
        .first()
        .is_none_or(|part| !part.eq_ignore_ascii_case("api"))
        || parts.iter().any(|p| p.is_empty())
    {
        return None;
    }
    let kind = |part: &str| {
        if part.eq_ignore_ascii_case("browser") {
            Some(Kind::Browser)
        } else if part.eq_ignore_ascii_case("computer") {
            Some(Kind::Computer)
        } else {
            None
        }
    };
    if parts.len() == 4 && parts[1].eq_ignore_ascii_case("instance") {
        if let Some(kind) = kind(parts[2]) {
            if parts[3].eq_ignore_ascii_case("broker")
                && matches!(*method, Method::PUT | Method::DELETE)
            {
                return Some(Endpoint::Registry(kind));
            }
        }
        if parts[2].eq_ignore_ascii_case("computer")
            && parts[3].eq_ignore_ascii_case("readiness")
            && matches!(*method, Method::GET | Method::HEAD)
        {
            return Some(Endpoint::Readiness);
        }
    }
    if parts.len() == 3 && *method == Method::POST {
        return Some(Endpoint::Action(
            kind(parts[1])?,
            percent_encoding::percent_decode_str(parts[2])
                .decode_utf8()
                .ok()?
                .into_owned(),
        ));
    }
    None
}
fn error(status: u16, code: &str, message: &str) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(json!({"error":message,"code":code}))
}
fn internal() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}
async fn admin(
    pool: &sqlx::PgPool,
    state: &IngressState,
    identity: &NativeIngressIdentity,
) -> Result<(), HttpResponse> {
    use crate::native_bearer_auth::NativeBearerAccess;
    use crate::native_session_auth::NativeSessionAccess;
    let mut tx = pool.begin().await.map_err(|_| internal())?;
    match identity {
        NativeIngressIdentity::LocalImplicit => {}
        NativeIngressIdentity::Session(identity) => {
            let kind = state
                .config
                .session_auth
                .as_ref()
                .map_or(NativeSessionAuthKind::BetterAuth, |settings| settings.kind);
            match crate::native_session_auth::revalidate_instance_admin_in_snapshot(
                &mut tx, identity, kind,
            )
            .await
            .map_err(|_| internal())?
            {
                NativeSessionAccess::Authorized => {}
                NativeSessionAccess::Unauthorized => {
                    return Err(HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"})));
                }
                NativeSessionAccess::Forbidden => {
                    return Err(HttpResponse::Forbidden()
                        .json(json!({"error":"Instance admin access required"})));
                }
            }
        }
        NativeIngressIdentity::BoardKey {
            user_id,
            key_id,
            token_hash,
        } => {
            let actor = ActorIdentity::new("user", user_id).map_err(|_| internal())?;
            match crate::native_bearer_auth::revalidate_native_bearer_in_snapshot(
                &mut tx,
                token_hash,
                None,
                &actor,
                &format!("board-key:{key_id}"),
            )
            .await
            .map_err(|_| internal())?
            {
                NativeBearerAccess::Authorized => {}
                NativeBearerAccess::Unauthorized => {
                    return Err(HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"})));
                }
                NativeBearerAccess::Forbidden => {
                    return Err(HttpResponse::Forbidden()
                        .json(json!({"error":"Instance admin access required"})));
                }
            }
            let allowed=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(user_id).fetch_one(&mut *tx).await.map_err(|_|internal())?;
            if !allowed {
                return Err(HttpResponse::Forbidden()
                    .json(json!({"error":"Instance admin access required"})));
            }
        }
        _ => return Err(HttpResponse::Forbidden().json(json!({"error":"Board access required"}))),
    }
    tx.commit().await.map_err(|_| internal())?;
    Ok(())
}
pub(super) async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    target: Endpoint,
) -> HttpResponse {
    let mut bytes = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "invalid_request_body");
        };
        if bytes.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return state
                .foundation
                .json_error(StatusCode::PAYLOAD_TOO_LARGE, "request_body_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &bytes) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD)
        && matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return HttpResponse::Forbidden()
            .json(json!({"error":crate::local_account_ingress::BOARD_ORIGIN_ERROR}));
    }
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "desktop_capability_unavailable",
        );
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let input = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    match target {
        Endpoint::Readiness => {
            if let Err(response) = admin(pool, &state, &identity).await {
                return response;
            }
            let enabled = match desktop_capability::settings(pool, Kind::Computer).await {
                Ok(value) => value,
                Err(_) => return internal(),
            };
            HttpResponse::Ok().json(json!({"enabled":enabled,"desktopConnected":state.foundation.desktop_brokers.computer.is_available(),"supported":state.config.deployment_mode=="local_trusted"}))
        }
        Endpoint::Registry(kind) => {
            if let Err(response) = admin(pool, &state, &identity).await {
                return response;
            }
            let prefix = if kind == Kind::Browser {
                "browser"
            } else {
                "computer"
            };
            let title = if kind == Kind::Browser {
                "Browser"
            } else {
                "Computer"
            };
            if state.config.deployment_mode != "local_trusted" {
                return error(
                    403,
                    &format!("{prefix}_runtime_unsupported"),
                    if kind == Kind::Browser {
                        "Rudder Browser is available only in local_trusted mode."
                    } else {
                        "Computer Use is available only in local_trusted mode."
                    },
                );
            }
            let broker = state.foundation.desktop_brokers.get(kind);
            if *request.method() == Method::DELETE {
                let Some(object) = input.as_object() else {
                    return error(
                        400,
                        &format!("{prefix}_broker_invalid_registration"),
                        &format!("{title} Broker credential is invalid."),
                    );
                };
                let token = object
                    .get("token")
                    .and_then(Value::as_str)
                    .filter(|token| (32..=512).contains(&token.encode_utf16().count()));
                if object.len() != 1 || token.is_none() {
                    return error(
                        400,
                        &format!("{prefix}_broker_invalid_registration"),
                        &format!("{title} Broker credential is invalid."),
                    );
                }
                broker.unregister(token.unwrap());
                return HttpResponse::NoContent().finish();
            }
            match broker.register(&input) {
                Ok(()) => HttpResponse::NoContent().finish(),
                Err(problem) => error(
                    if problem.code.contains("stale") || problem.code.contains("revoked") {
                        409
                    } else {
                        400
                    },
                    &problem.code,
                    &problem.message,
                ),
            }
        }
        Endpoint::Action(kind, action) => {
            let prefix = if kind == Kind::Browser {
                "browser"
            } else {
                "computer"
            };
            let identity = match identity {
                NativeIngressIdentity::AgentJwt(identity) => identity,
                NativeIngressIdentity::AgentKey { .. } => {
                    return error(
                        403,
                        &format!("{prefix}_run_credential_required"),
                        if kind == Kind::Browser {
                            "Rudder Browser requires a run-scoped runtime credential."
                        } else {
                            "Computer Use requires a run-scoped runtime credential."
                        },
                    );
                }
                _ => {
                    return HttpResponse::Forbidden()
                        .json(json!({"error":"Agent access required"}));
                }
            };
            let body = if input.is_null() { json!({}) } else { input };
            match desktop_capability::action(
                pool,
                state.foundation.desktop_brokers.get(kind),
                kind,
                &state.config.deployment_mode,
                &identity,
                &action,
                &body,
            )
            .await
            {
                Ok(Some(value)) => HttpResponse::Ok().json(value),
                Ok(None) => HttpResponse::NoContent().finish(),
                Err(problem) => error(problem.status, &problem.code, &problem.message),
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_endpoint_routes_preserve_legacy_surface_and_action_casing() {
        assert_eq!(
            endpoint("/API/INSTANCE/BROWSER/BROKER/", &Method::PUT),
            Some(Endpoint::Registry(Kind::Browser))
        );
        assert_eq!(
            endpoint("/api/instance/computer/readiness", &Method::HEAD),
            Some(Endpoint::Readiness)
        );
        assert_eq!(
            endpoint("/api/browser/%63lick", &Method::POST),
            Some(Endpoint::Action(Kind::Browser, "click".into()))
        );
        assert_eq!(
            endpoint("/api/computer/CLICK", &Method::POST),
            Some(Endpoint::Action(Kind::Computer, "CLICK".into()))
        );
        for (path, method) in [
            ("/api/browser/click/extra", Method::POST),
            ("/api/browser/click", Method::GET),
            ("/api/instance/browser/broker", Method::POST),
        ] {
            assert_eq!(endpoint(path, &method), None);
        }
    }
}
