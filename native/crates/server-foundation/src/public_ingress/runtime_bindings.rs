//! Native-only public binding reads. No Node authorization or query fallback.
use super::*;
use rudder_d1_persistence::runtime_bindings::{self, Error, Request, Target, TargetType};

pub(super) async fn current(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let (org_id, target_id) = path.into_inner();
    read(
        state,
        request,
        body,
        org_id,
        Request::PublicCurrent {
            target: Target {
                target_type: TargetType::ChatConversation,
                target_id,
            },
        },
    )
    .await
}

pub(super) async fn historical(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let (org_id, binding_id) = path.into_inner();
    read(
        state,
        request,
        body,
        org_id,
        Request::PublicRead { binding_id },
    )
    .await
}

async fn read(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: String,
    input: Request,
) -> HttpResponse {
    let foundation = &state.foundation;
    if !body.is_empty() || !request.query_string().is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "binding_read_body_or_query_not_allowed",
        );
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if Uuid::parse_str(&org_id).is_err() {
        return error(StatusCode::NOT_FOUND, "organization_not_found");
    }
    let Some(token) =
        bearer_token(&request).filter(|token| native_bearer_auth::is_native_bearer(token))
    else {
        // Cookie/JWT/implicit credentials have no native resolver yet. New
        // surfaces must never ask the compatibility backend to authorize them.
        return error(StatusCode::UNAUTHORIZED, "native_api_key_required");
    };
    let _permit = match foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => return unavailable(),
    };
    use native_bearer_auth::{NativeBearerAccess, NativeBearerResolution};
    let (identity, session_id, token_hash) =
        match foundation.resolve_native_bearer(token, &org_id).await {
            NativeBearerResolution::Authorized {
                actor,
                session_id,
                token_hash,
            } => (actor, session_id, token_hash),
            NativeBearerResolution::Unauthorized | NativeBearerResolution::Compatibility => {
                return error(StatusCode::UNAUTHORIZED, "unauthorized");
            }
            NativeBearerResolution::Forbidden => {
                return error(StatusCode::FORBIDDEN, "forbidden");
            }
            NativeBearerResolution::DatabaseDisabled | NativeBearerResolution::Unavailable => {
                return unavailable();
            }
        };
    let DatabaseState::Configured(pool) = &foundation.database else {
        return unavailable();
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return unavailable(),
    };
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return unavailable();
    }
    // Membership/revocation and every target/binding row share one snapshot.
    match native_bearer_auth::revalidate_native_bearer_in_snapshot(
        &mut tx,
        &token_hash,
        &org_id,
        &identity,
        &session_id,
    )
    .await
    {
        Ok(NativeBearerAccess::Authorized) => {}
        Ok(NativeBearerAccess::Unauthorized) => {
            return error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        Ok(NativeBearerAccess::Forbidden) => {
            return error(StatusCode::FORBIDDEN, "forbidden");
        }
        Err(_) => return unavailable(),
    }
    // Mint the existing opaque VerifiedActor only from DB-resolved identity.
    // Caller headers never provide claims, signature, session or request ID.
    let Some(key) = foundation.config.actor_envelope_key.as_ref() else {
        return unavailable();
    };
    let action = match &input {
        Request::PublicCurrent { .. } => "runtime.binding.public_current",
        Request::PublicRead { .. } => "runtime.binding.public_read",
        _ => return unavailable(),
    };
    let now = unix_time_seconds();
    let request_id = Uuid::new_v4().to_string();
    let envelope = ActorEnvelope::new(
        identity,
        &org_id,
        session_id,
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        request.method().as_str(),
        request.uri().to_string(),
        action,
        b"",
        &request_id,
        Uuid::new_v4().to_string(),
        now,
        now + 30,
    )
    .and_then(|unsigned| unsigned.sign_with_key(key));
    let actor = match envelope.ok().and_then(|envelope| {
        foundation
            .verify_actor_envelope_parts(
                key,
                &envelope,
                &request,
                &org_id,
                action,
                None,
                b"",
                &request_id,
            )
            .ok()
    }) {
        Some(actor) => actor,
        None => return unavailable(),
    };
    match runtime_bindings::execute_public_read_in_transaction(&mut tx, &actor, &org_id, &input)
        .await
    {
        Ok(value) => {
            if tx.commit().await.is_err() {
                return unavailable();
            }
            HttpResponse::Ok().json(value)
        }
        Err(Error::Http(status, message)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(serde_json::json!({"error": message})),
        Err(Error::Database(_)) => unavailable(),
    }
}

fn unavailable() -> HttpResponse {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_binding_authority_unavailable",
    )
}

/// Reserve the migrated namespace, including encoded and case variants, so
/// unmatched methods/paths cannot fall through to the Node proxy.
pub(super) fn reserved_path(path: &str) -> bool {
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
    let parts: Vec<_> = decoded.split('/').filter(|part| !part.is_empty()).collect();
    parts.len() >= 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
        && (parts[3].eq_ignore_ascii_case("runtime-bindings")
            || (parts.len() >= 6
                && parts[3].eq_ignore_ascii_case("chats")
                && parts[5].eq_ignore_ascii_case("runtime-binding")))
}

fn error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status).json(serde_json::json!({"error": message}))
}
