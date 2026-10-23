//! Rust-owned Chat control and recovery reads. Activation is explicit in the
//! host config. Native turns never authorize, execute, or retry through Node.
//! Exact, positively identified legacy Stop targets retain compatibility transport.
use super::*;
use crate::browser_auth::{self, BrowserActor, BrowserAuthError};
use rudder_d1_persistence::native_chat::{BrowserPrincipal, control};
use rudder_d1_persistence::runtime_bindings::Error as PersistenceError;
use sqlx::PgPool;

mod input;
mod paths;
mod reconcile;
mod send;
pub(super) fn reserved_path(path: &str) -> bool {
    paths::reserved_path(path)
}

pub(super) fn capability_path(path: &str) -> bool {
    paths::capability_path(path)
}

pub(super) fn configure(routes: &mut web::ServiceConfig, send_enabled: bool) {
    routes
        .service(web::resource("/api/native-chat/capabilities").route(web::get().to(capabilities)));
    // Recovery reads remain available when new provider dispatch is disabled.
    routes.service(
        web::resource("/api/orgs/{org_id}/chats/messages/stream/reconcile")
            .app_data(web::PayloadConfig::new(128 * 1024))
            .route(web::post().to(reconcile::first_send_reconcile)),
    );
    routes.service(
        web::resource("/api/chats/{chat_id}/messages/stream/reconcile")
            .app_data(web::PayloadConfig::new(128 * 1024))
            .route(web::post().to(reconcile::reconcile)),
    );
    if send_enabled {
        routes.service(
            web::resource("/api/orgs/{org_id}/chats/messages/stream")
                // Legacy Agent requests are relayed byte-for-byte and retain
                // the Node ingress's bounded 10 MiB request envelope. Native
                // Chat applies its smaller JSON limit after authority routing.
                .app_data(web::PayloadConfig::new(10 * 1024 * 1024))
                .route(web::post().to(send::first_send)),
        );
        routes.service(
            web::resource("/api/chats/{chat_id}/messages/stream")
                .app_data(web::PayloadConfig::new(10 * 1024 * 1024))
                .route(web::post().to(send::send)),
        );
    }
    routes
        .service(
            web::resource("/api/chats/{chat_id}/messages/stream/checkpoint")
                .app_data(web::PayloadConfig::new(8192))
                .route(web::post().to(checkpoint)),
        )
        .service(
            web::resource("/api/chats/{chat_id}/messages/stream/stop")
                .app_data(web::PayloadConfig::new(8192))
                .route(web::post().to(stop)),
        )
        .service(
            web::resource("/api/chats/{chat_id}/messages/stream/events")
                .route(web::get().to(events)),
        )
        .service(
            web::resource("/api/chats/{chat_id}/messages/stream/turn").route(web::get().to(turn)),
        )
        .service(
            web::resource("/api/chats/{chat_id}/messages/stream/control")
                .app_data(web::PayloadConfig::new(8192))
                .route(web::get().to(control_state)),
        );
}

async fn capabilities(state: web::Data<IngressState>, request: HttpRequest) -> HttpResponse {
    if request.uri().path() != "/api/native-chat/capabilities" {
        return error(StatusCode::NOT_FOUND, "route_not_found");
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    let enabled = state.config.native_chat_mutations.is_some();
    HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(serde_json::json!({
            "executionAuthority":"native_rust",
            "firstSend": enabled
                && state.config.native_chat_runtime.is_some()
                && state.foundation.native_chat_worker.is_some(),
            "readTurn": enabled,
            "nativeControls": enabled,
        }))
}

fn error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(serde_json::json!({"error": message}))
}

fn auth_error(error_: BrowserAuthError) -> HttpResponse {
    match error_ {
        BrowserAuthError::Unauthorized => error(StatusCode::UNAUTHORIZED, "unauthorized"),
        BrowserAuthError::Forbidden => error(StatusCode::FORBIDDEN, "forbidden"),
        BrowserAuthError::Unavailable => unavailable(),
    }
}

fn unavailable() -> HttpResponse {
    error(StatusCode::SERVICE_UNAVAILABLE, "native_chat_unavailable")
}

type HttpResponseResult<T> = Result<T, Box<HttpResponse>>;

fn boxed(response: HttpResponse) -> Box<HttpResponse> {
    Box::new(response)
}

fn result<T: Serialize>(value: Result<T, PersistenceError>) -> HttpResponse {
    match value {
        Ok(value) => HttpResponse::Ok()
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .json(value),
        Err(PersistenceError::Http(status, message)) => {
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            if matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND) {
                // Do not disclose whether a chat in another organization exists.
                error(StatusCode::NOT_FOUND, "chat_not_found")
            } else if status.is_client_error() {
                error(status, &message)
            } else {
                unavailable()
            }
        }
        Err(_) => unavailable(),
    }
}

fn canonical(request: &HttpRequest, chat: &str, suffix: &str) -> Result<(), Box<HttpResponse>> {
    if Uuid::parse_str(chat)
        .ok()
        .is_none_or(|id| id.to_string() != chat)
        || request.uri().path() != format!("/api/chats/{chat}/messages/stream/{suffix}")
    {
        return Err(Box::new(error(StatusCode::NOT_FOUND, "route_not_found")));
    }
    Ok(())
}

// An authenticated identity is established before resolving the chat's org.
// The result is only a request principal: D1 revalidates the exact credential,
// org access, target and generation inside each operation transaction.
async fn principal(
    state: &IngressState,
    request: &HttpRequest,
    chat: &str,
    mutation: bool,
) -> HttpResponseResult<(PgPool, BrowserPrincipal)> {
    let (pool, actor, organization_id) = browser_actor(state, request, chat, mutation).await?;
    let principal = actor
        .native_chat_principal(&organization_id)
        .map_err(|error_| boxed(auth_error(error_)))?;
    Ok((pool, principal))
}

// Retain the verified browser actor for paths such as admission that need a
// separate sealed D1 principal per operation. Target authorization remains in
// each D1 transaction; this only resolves the organization and Origin policy.
async fn browser_actor(
    state: &IngressState,
    request: &HttpRequest,
    chat: &str,
    mutation: bool,
) -> HttpResponseResult<(PgPool, BrowserActor, String)> {
    let (pool, actor) = authenticate_browser_actor(state, request, mutation).await?;
    let org: Option<String> =
        sqlx::query_scalar("SELECT org_id::text FROM chat_conversations WHERE id=$1::uuid")
            .bind(chat)
            .fetch_optional(&pool)
            .await
            .map_err(|_| boxed(unavailable()))?;
    let org = org.ok_or_else(|| boxed(error(StatusCode::NOT_FOUND, "chat_not_found")))?;
    Ok((pool, actor, org))
}

pub(super) async fn browser_actor_for_org(
    state: &IngressState,
    request: &HttpRequest,
    organization_id: &str,
    mutation: bool,
) -> HttpResponseResult<(PgPool, BrowserActor, String)> {
    let (pool, actor) = authenticate_browser_actor(state, request, mutation).await?;
    Ok((pool, actor, organization_id.to_owned()))
}

async fn authenticate_browser_actor(
    state: &IngressState,
    request: &HttpRequest,
    mutation: bool,
) -> HttpResponseResult<(PgPool, BrowserActor)> {
    if state.config.forwarding_policy.identity(request).is_err() {
        return Err(boxed(error(
            StatusCode::BAD_REQUEST,
            "invalid_forwarding_identity",
        )));
    }
    let config = state
        .config
        .browser_auth
        .as_ref()
        .ok_or_else(|| boxed(unavailable()))?;
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return Err(boxed(unavailable()));
    };
    let mut connection = pool.acquire().await.map_err(|_| boxed(unavailable()))?;
    // Origin authorization follows credential verification for cookie-backed
    // mutations. Keep this endpoint's resolver read-only with respect to
    // Better Auth session expiry so a rejected Origin cannot slide a session.
    let actor = browser_auth::authenticate_without_refresh(config, request, &mut connection, None)
        .await
        .map_err(|error_| boxed(auth_error(error_)))?;
    if mutation {
        state
            .config
            .native_chat_mutations
            .as_ref()
            .ok_or_else(|| boxed(unavailable()))?
            .authorize(&actor, request)
            .map_err(|error_| boxed(auth_error(error_)))?;
    }
    Ok((pool.clone(), actor))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointInput {
    generation_id: String,
    attempt_epoch: i32,
    generation_seq: i32,
    rendered_body_hash: String,
}

async fn checkpoint(
    state: web::Data<IngressState>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    if let Err(response) = canonical(&request, &chat, "checkpoint") {
        return *response;
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    let input: CheckpointInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_checkpoint"),
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, actor) = match principal(&state, &request, &chat, true).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    result(
        control::record_client_checkpoint(
            &pool,
            &actor,
            &control::ClientCheckpointRequest {
                conversation_id: chat.into_inner(),
                generation_id: input.generation_id,
                attempt_epoch: input.attempt_epoch,
                generation_seq: input.generation_seq,
                rendered_body_hash: input.rendered_body_hash,
            },
        )
        .await,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopInput {
    control_action_id: String,
    expected_generation_id: String,
    expected_attempt_epoch: i32,
    expected_control_version: i32,
    last_committed_render_seq: i32,
    rendered_body_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopTargetInput {
    expected_generation_id: String,
    // Required even though the existing authority-specific writer owns CAS and
    // idempotency. A partial request must not pick an implicit current target.
    #[serde(rename = "expectedAttemptEpoch")]
    _expected_attempt_epoch: i32,
    #[serde(rename = "expectedControlVersion")]
    _expected_control_version: i32,
}

async fn stop(
    state: web::Data<IngressState>,
    proxy: web::Data<PublicIngressProxy>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    if let Err(response) = canonical(&request, &chat, "stop") {
        return *response;
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    let target_input: StopTargetInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "complete_stop_fence_required"),
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, actor) = match principal(&state, &request, &chat, true).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let authority = match control::read_stop_target_authority(
        &pool,
        &actor,
        &control::ReadTurn {
            conversation_id: chat.to_string(),
            generation_id: target_input.expected_generation_id,
        },
    )
    .await
    {
        Ok(authority) => authority,
        Err(error) => return result::<serde_json::Value>(Err(error)),
    };
    if authority == control::StopTargetAuthority::LegacyTs {
        // This branch requires a positive, authorized exact legacy target.
        // The existing Node handler rechecks the target under its mutation
        // fence. Never route a failed Native control operation through Node.
        use actix_web::FromRequest;
        let mut buffered = actix_web::dev::Payload::from(body);
        let payload = match web::Payload::from_request(&request, &mut buffered).await {
            Ok(payload) => payload,
            Err(_) => return unavailable(),
        };
        return super::forward_compatibility(state, proxy, request, payload).await;
    }
    let input: StopInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "complete_stop_fence_required"),
    };
    let stop_request = control::StopRequest {
        conversation_id: chat.into_inner(),
        generation_id: input.expected_generation_id,
        control_action_id: input.control_action_id,
        expected_attempt_epoch: input.expected_attempt_epoch,
        expected_control_version: input.expected_control_version,
        requested_render_seq: input.last_committed_render_seq,
        requested_body_hash: input.rendered_body_hash,
    };
    let receipt = match control::request_stop(&pool, &actor, &stop_request).await {
        Ok(receipt) => receipt,
        Err(error) => return result::<serde_json::Value>(Err(error)),
    };
    if matches!(
        receipt.outcome,
        control::StopOutcome::StopIntentRecorded | control::StopOutcome::StopInProgress
    ) {
        // The D1 operation proves that no claim or provider effect ever existed.
        // A race won by the worker rejects this path and retains normal Stop intent.
        let final_request = control::FinalizeUnclaimedStop {
            conversation_id: stop_request.conversation_id,
            generation_id: stop_request.generation_id,
            control_action_id: stop_request.control_action_id,
        };
        match control::finalize_unclaimed_stop(&pool, &actor, &final_request).await {
            Ok(finalized) => {
                let mut response = stop_response(receipt);
                response["stopped"] = serde_json::json!(true);
                response["disposition"] = serde_json::json!("stopped_before_start");
                response["inputDisposition"] = serde_json::json!(finalized.input_disposition);
                return result(Ok(response));
            }
            Err(PersistenceError::Http(409, _)) => (),
            Err(error) => return result::<serde_json::Value>(Err(error)),
        }
    }
    result(Ok(stop_response(receipt)))
}

// A persisted cutoff is not proof that a provider has stopped. Preserve the
// UI contract without inventing a terminal acknowledgement.
fn stop_response(receipt: control::StopReceipt) -> serde_json::Value {
    let stopped = receipt.outcome == control::StopOutcome::Stopped;
    let disposition = match &receipt.outcome {
        control::StopOutcome::StopIntentRecorded | control::StopOutcome::StopInProgress => {
            "stopping"
        }
        control::StopOutcome::Stopped => "stopped",
        control::StopOutcome::CompletionCommitted => "completion_committed",
        control::StopOutcome::AlreadyTerminal => "no_active_generation",
    };
    let mut response = serde_json::json!({
        "stopped": stopped, "disposition": disposition,
        "controlActionId": receipt.control_action_id, "generationId": receipt.generation_id,
        "idempotent": receipt.idempotent,
        "appliedControlVersion": receipt.applied_control_version,
        "acceptedThroughSeq": receipt.accepted_through_seq, "frozenBodyHash": receipt.frozen_body_hash,
    });
    if let Some(input_disposition) = receipt.input_disposition {
        response["inputDisposition"] = serde_json::json!(input_disposition);
    }
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventsQuery {
    generation_id: String,
    #[serde(default)]
    after_seq: i32,
}

async fn events(
    state: web::Data<IngressState>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
    query: web::Query<EventsQuery>,
) -> HttpResponse {
    if let Err(response) = canonical(&request, &chat, "events") {
        return *response;
    }
    if !body.is_empty() {
        return error(StatusCode::BAD_REQUEST, "body_not_allowed");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, actor) = match principal(&state, &request, &chat, false).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    result(
        control::read_events(
            &pool,
            &actor,
            &control::ReadEvents {
                conversation_id: chat.into_inner(),
                generation_id: query.generation_id.clone(),
                after_seq: query.after_seq,
                limit: 100,
                max_bytes: 1024 * 1024,
            },
        )
        .await,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnQuery {
    generation_id: String,
}

async fn control_state(
    state: web::Data<IngressState>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
    query: web::Query<TurnQuery>,
) -> HttpResponse {
    if let Err(response) = canonical(&request, &chat, "control") {
        return *response;
    }
    if !body.is_empty() {
        return error(StatusCode::BAD_REQUEST, "body_not_allowed");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, actor) = match principal(&state, &request, &chat, false).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    result(
        control::read_control_state(
            &pool,
            &actor,
            &control::ReadTurn {
                conversation_id: chat.into_inner(),
                generation_id: query.generation_id.clone(),
            },
        )
        .await,
    )
}

async fn turn(
    state: web::Data<IngressState>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
    query: web::Query<TurnQuery>,
) -> HttpResponse {
    if let Err(response) = canonical(&request, &chat, "turn") {
        return *response;
    }
    if !body.is_empty() {
        return error(StatusCode::BAD_REQUEST, "body_not_allowed");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, actor) = match principal(&state, &request, &chat, false).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    result(
        control::read_turn_for_control(
            &pool,
            &actor,
            &control::ReadTurn {
                conversation_id: chat.into_inner(),
                generation_id: query.generation_id.clone(),
            },
        )
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test;
    const CHAT: &str = "21000000-0000-4000-8000-000000000001";

    #[actix_web::test]
    async fn public_control_routes_fail_closed_without_legacy_proxy() {
        let upstream = "http://127.0.0.1:9";
        let config = PublicIngressConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            upstream,
            "0123456789abcdef0123456789abcdef",
        )
        .unwrap()
        .with_native_chat_mutation_policy(browser_auth::BrowserMutationPolicy::new(&[]).unwrap());
        let state = web::Data::new(IngressState {
            foundation: Arc::new(AppState::new(ServerConfig::default()).unwrap()),
            config,
            local_account: None,
            cli_auth_browser_auth: None,
        });
        let proxy = PublicIngressProxy::new(upstream).unwrap();
        let ws = PublicIngressWebSocketProxy::new(proxy.upstream_authority()).unwrap();
        let app = test::init_service(
            App::new()
                .app_data(state)
                .app_data(web::Data::new(proxy))
                .app_data(web::Data::new(ws))
                .configure(|routes| configure(routes, false))
                .default_service(web::to(proxy_request)),
        )
        .await;
        // A partial Stop can never select and cancel whichever generation is
        // current. Raw alias paths remain Rust-owned even when Node is down.
        for (path, body, expected) in [
            (
                format!("/api/chats/{CHAT}/messages/stream/stop"),
                serde_json::json!({"controlActionId":"action"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                format!("/API/CHATS/{CHAT}/MESSAGES/STREAM/STOP/"),
                serde_json::json!({}),
                StatusCode::NOT_FOUND,
            ),
            (
                format!("/api/chats/{CHAT}/messages%2fstream%2fstop"),
                serde_json::json!({}),
                StatusCode::NOT_FOUND,
            ),
            (
                format!("/api/chats/{CHAT}/messages/stream"),
                serde_json::json!({"body":"hi","clientMutationId":"disabled-send"}),
                StatusCode::NOT_FOUND,
            ),
            (
                format!("/api/chats/{CHAT}/messages/stream/unknown"),
                serde_json::json!({}),
                StatusCode::NOT_FOUND,
            ),
            (
                format!("/api/chats/{CHAT}/messages/stream/checkpoint?bypass=1"),
                serde_json::json!({}),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri(&path)
                    .set_json(body)
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), expected, "{path}");
        }
        let path = format!("/api/chats/{CHAT}/messages/stream/events?generationId={CHAT}");
        let response = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&path)
                .peer_addr("127.0.0.1:4000".parse().unwrap())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: serde_json::Value = test::read_body_json(response).await;
        assert_eq!(body["error"], "native_chat_unavailable");
    }

    #[actix_web::test]
    async fn inaccessible_and_missing_target_errors_have_identical_public_bodies() {
        let mut bodies = Vec::new();
        for (status, message) in [
            (403, "Organization access denied"),
            (404, "Chat conversation not found"),
            (404, "Native Chat generation not found"),
        ] {
            let response =
                result::<serde_json::Value>(Err(PersistenceError::Http(status, message.into())));
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            bodies.push(
                actix_web::body::to_bytes(response.into_body())
                    .await
                    .unwrap(),
            );
        }
        assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bodies[0]).unwrap(),
            serde_json::json!({"error":"chat_not_found"})
        );
    }

    #[actix_web::test]
    async fn stop_intent_does_not_claim_provider_termination() {
        let response = stop_response(control::StopReceipt {
            control_action_id: "action".into(),
            generation_id: "generation".into(),
            outcome: control::StopOutcome::StopIntentRecorded,
            idempotent: false,
            applied_control_version: Some(1),
            accepted_through_seq: Some(7),
            frozen_body_hash: Some("hash".into()),
            input_disposition: None,
        });
        assert_eq!(response["stopped"], false);
        assert_eq!(response["disposition"], "stopping");
        assert_eq!(response["acceptedThroughSeq"], 7);
        assert_eq!(response["controlActionId"], "action");
    }

    #[actix_web::test]
    async fn persisted_stop_terminal_is_explicitly_reported() {
        let response = stop_response(control::StopReceipt {
            control_action_id: "action".into(),
            generation_id: "generation".into(),
            outcome: control::StopOutcome::Stopped,
            idempotent: true,
            applied_control_version: Some(1),
            accepted_through_seq: Some(0),
            frozen_body_hash: Some(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
            ),
            input_disposition: None,
        });
        assert_eq!(response["stopped"], true);
        assert_eq!(response["disposition"], "stopped");
        assert_eq!(response["idempotent"], true);
    }
}

#[cfg(all(test, unix))]
mod http_tests;
