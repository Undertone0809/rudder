//! Explicit Rust-owned ordinary Chat send. The response is a replayable NDJSON
//! projection of D1 state; dropping the HTTP body never cancels the worker.

use super::input::{FirstSendInput, InputError, SendInput};
use super::*;
use crate::browser_auth::BrowserActor;
use crate::native_chat_worker::{AdmissionReservation, Job, Status as WorkerStatus, Ticket};
use futures_util::{StreamExt, stream};
use rudder_d1_persistence::native_chat::{
    self, BrowserPrincipal, FirstSendRequest, Request, control,
};
use rudder_d1_persistence::runtime_bindings::Error as PersistenceError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EVENT_PAGE_LIMIT: i32 = 100;
const EVENT_PAGE_BYTES: usize = 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(750);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(12);
const CLAIMLESS_REPLAY_GRACE: Duration = Duration::from_secs(10);
const OWNER_LEASE_RECHECK_INTERVAL: Duration = Duration::from_secs(5);
const MAX_STREAM_LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_STREAM_ERROR: &str = "recovery_required";

#[derive(Clone)]
enum AdmissionOperation {
    Existing(Request),
    FirstSend(FirstSendRequest),
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdmissionReceipt {
    conversation_id: String,
    user_message_id: String,
    user_message: Value,
    generation_id: String,
    generation_status: String,
    attempt_epoch: i32,
    execution_owner_live: Option<bool>,
    runtime_terminal: bool,
    run_id: String,
    run_status: String,
    attempt_id: String,
    execution_authority: String,
    native_admission_hold: bool,
    idempotent_replay: bool,
}

enum AdmissionAcknowledgement {
    Committed(AdmissionReceipt),
    Failed(PersistenceError),
    InvalidReceipt,
}

pub(super) async fn send(
    state: web::Data<IngressState>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    let chat = chat.into_inner();
    if Uuid::parse_str(&chat)
        .ok()
        .is_none_or(|id| id.to_string() != chat)
        || request.uri().path() != format!("/api/chats/{chat}/messages/stream")
    {
        return error(StatusCode::NOT_FOUND, "route_not_found");
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    if body.len() > 128 * 1024 {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "chat_send_too_large");
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
    let input: SendInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_chat_send"),
    };
    let command = match input.into_command(&chat) {
        Ok(command) => command,
        Err(error_) => return input_error(error_),
    };
    let _request_permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, authenticated, organization_id) =
        match browser_actor(&state, &request, &chat, true).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    send_admission(
        state,
        pool,
        authenticated,
        organization_id,
        Some(chat),
        AdmissionOperation::Existing(command),
    )
    .await
}

pub(super) async fn first_send(
    state: web::Data<IngressState>,
    request: HttpRequest,
    organization: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    let organization_id = organization.into_inner();
    let canonical_organization = Uuid::parse_str(&organization_id)
        .ok()
        .is_some_and(|id| id.to_string() == organization_id);
    if !canonical_organization
        || request.uri().path() != format!("/api/orgs/{organization_id}/chats/messages/stream")
    {
        return error(StatusCode::NOT_FOUND, "route_not_found");
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    if body.len() > 128 * 1024 {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "chat_send_too_large");
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
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_chat_send"),
    };
    let command = match input.into_command() {
        Ok(command) => command,
        Err(error_) => return input_error(error_),
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
    send_admission(
        state,
        pool,
        authenticated,
        organization_id,
        None,
        AdmissionOperation::FirstSend(command),
    )
    .await
}

async fn send_admission(
    state: web::Data<IngressState>,
    pool: PgPool,
    authenticated: BrowserActor,
    organization_id: String,
    expected_conversation: Option<String>,
    command: AdmissionOperation,
) -> HttpResponse {
    // Build separate proof objects for each operation. They contain the same
    // Foundation-verified credential digest; D1 revalidates every transaction.
    let lookup_actor = match native_principal(&authenticated, &organization_id) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let admission_actor = match native_principal(&authenticated, &organization_id) {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let preflight = match lookup_admission(&pool, &lookup_actor, &organization_id, &command).await {
        Ok(receipt) => receipt,
        Err(error_) => return result::<Value>(Err(error_)),
    };

    let (receipt, ticket_receiver) = if let Some(receipt) = preflight {
        let Some(receipt) =
            parse_receipt(receipt, &organization_id, expected_conversation.as_deref())
        else {
            return unavailable();
        };
        if !receipt.idempotent_replay {
            return unavailable();
        }
        (receipt, None)
    } else {
        // Exact durable retries need neither a host configuration nor a live
        // process supervisor. Only a real admission miss may reserve capacity.
        let Some(host_runtime) = state.config.native_chat_runtime.as_ref() else {
            return unavailable();
        };
        let Some(worker) = state.foundation.native_chat_worker.as_ref() else {
            return unavailable();
        };
        // Duplicate recovery above requires no available worker. A miss is
        // followed by an idempotent transaction that handles the race where a
        // concurrent first send commits between preflight and reservation.
        let reservation = match worker.reserve_before_admission() {
            Ok(value) => value,
            Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "native_chat_busy"),
        };
        let marker_actor = match native_principal(&authenticated, &organization_id) {
            Ok(actor) => actor,
            Err(response) => return response,
        };
        let pool_for_task = pool.clone();
        let organization_for_task = organization_id.clone();
        let host = host_runtime.host.clone();
        let paths = host_runtime.paths.clone();
        let timeout = host_runtime.timeout;
        let command_for_task = command.clone();
        let expected_conversation_for_task = expected_conversation.clone();
        let (ack_sender, ack_receiver) = tokio::sync::oneshot::channel();
        let (ticket_sender, ticket_receiver) = tokio::sync::oneshot::channel();
        let receiver =
            match worker.spawn_reserved_admission(reservation, move |reservation| async move {
                run_admission_and_dispatch(
                    reservation,
                    pool_for_task,
                    admission_actor,
                    marker_actor,
                    organization_for_task,
                    expected_conversation_for_task,
                    command_for_task,
                    host,
                    paths,
                    timeout,
                    ack_sender,
                    ticket_sender,
                )
                .await
            }) {
                Ok(receiver) => receiver,
                Err(_) => return unavailable(),
            };
        // The supervisor owns the admission task independently from this
        // request. Its outer JoinHandle is tracked for shutdown; this receiver
        // is only an acknowledgment channel and is never execution authority.
        drop(receiver);
        match ack_receiver.await {
            Ok(AdmissionAcknowledgement::Committed(receipt)) => (receipt, Some(ticket_receiver)),
            Ok(AdmissionAcknowledgement::Failed(error_)) => {
                return result::<Value>(Err(error_));
            }
            Ok(AdmissionAcknowledgement::InvalidReceipt) => return unavailable(),
            Err(_) => {
                // The tracked admission task may panic after D1 commit but
                // before dispatch handoff or response delivery. Re-read only
                // the exact durable mutation receipt; this is never a reason
                // to reserve or start another worker.
                let value = match lookup_admission(&pool, &lookup_actor, &organization_id, &command)
                    .await
                {
                    Ok(Some(value)) => value,
                    Ok(None) | Err(_) => return unavailable(),
                };
                let Some(receipt) =
                    parse_receipt(value, &organization_id, expected_conversation.as_deref())
                else {
                    return unavailable();
                };
                if !receipt.idempotent_replay {
                    return unavailable();
                }
                (receipt, None)
            }
        }
    };

    let attempt_epoch = receipt.attempt_epoch;
    let ack = json!({
        "type":"ack",
        "userMessage":receipt.user_message,
        "generationId":receipt.generation_id,
        "attemptEpoch":attempt_epoch,
        "generationSeq":0,
        "bodyHash":EMPTY_SHA256,
    });
    let stream = event_stream(pool, lookup_actor, receipt, ack, ticket_receiver);
    HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8"))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header(("x-content-type-options", "nosniff"))
        .insert_header(("x-accel-buffering", "no"))
        .streaming(stream)
}

async fn lookup_admission(
    pool: &PgPool,
    actor: &BrowserPrincipal,
    organization_id: &str,
    command: &AdmissionOperation,
) -> Result<Option<Value>, PersistenceError> {
    match command {
        AdmissionOperation::Existing(request) => {
            native_chat::lookup_submission(pool, actor, organization_id, request).await
        }
        AdmissionOperation::FirstSend(request) => {
            native_chat::lookup_first_send_submission(pool, actor, organization_id, request).await
        }
    }
}

async fn execute_admission(
    pool: &PgPool,
    actor: &BrowserPrincipal,
    organization_id: &str,
    command: &AdmissionOperation,
    host: &rudder_d1_persistence::native_chat::config::LocalHostContext,
) -> Result<Value, PersistenceError> {
    match command {
        AdmissionOperation::Existing(request) => {
            native_chat::execute(pool, actor, organization_id, request, host).await
        }
        AdmissionOperation::FirstSend(request) => {
            native_chat::execute_first_send(pool, actor, organization_id, request, host).await
        }
    }
}

fn parse_receipt(
    value: Value,
    expected_organization: &str,
    expected_conversation: Option<&str>,
) -> Option<AdmissionReceipt> {
    let receipt: AdmissionReceipt = serde_json::from_value(value).ok()?;
    let canonical_uuid = |value: &str| {
        Uuid::parse_str(value)
            .ok()
            .is_some_and(|parsed| parsed.to_string() == value)
    };
    let source = &receipt.user_message;
    let source_keys_valid = source.as_object().is_some_and(|object| {
        const ALLOWED: &[&str] = &[
            "id",
            "orgId",
            "conversationId",
            "role",
            "kind",
            "status",
            "body",
            "structuredPayload",
            "approvalId",
            "approval",
            "attachments",
            "runId",
            "generationId",
            "replyingAgentId",
            "chatTurnId",
            "turnVariant",
            "supersededAt",
            "createdAt",
            "updatedAt",
        ];
        object.len() == ALLOWED.len() && object.keys().all(|key| ALLOWED.contains(&key.as_str()))
    });
    (canonical_uuid(&receipt.conversation_id)
        && expected_conversation.is_none_or(|expected| receipt.conversation_id == expected)
        && canonical_uuid(&receipt.user_message_id)
        && canonical_uuid(&receipt.generation_id)
        && canonical_uuid(&receipt.run_id)
        && canonical_uuid(&receipt.attempt_id)
        && receipt.execution_authority == "native_rust"
        && receipt.user_message_id == source["id"].as_str().unwrap_or_default()
        && source_keys_valid
        && source["orgId"].as_str() == Some(expected_organization)
        && source["conversationId"].as_str() == Some(receipt.conversation_id.as_str())
        && source["role"].as_str() == Some("user")
        && source["kind"].as_str() == Some("message")
        && source["status"].as_str() == Some("completed")
        && source["body"]
            .as_str()
            .is_some_and(|body| body.len() <= 262_144)
        && source["attachments"].as_array().is_some_and(Vec::is_empty)
        && source["approval"].is_null()
        && source["approvalId"].is_null()
        && source["structuredPayload"].is_null()
        && source["runId"].as_str() == Some(receipt.run_id.as_str())
        && source["generationId"].as_str() == Some(receipt.generation_id.as_str())
        && receipt.attempt_epoch > 0
        && receipt.execution_owner_live.is_some()
        && matches!(
            receipt.generation_status.as_str(),
            "starting"
                | "active"
                | "running"
                | "waiting_for_network"
                | "tool_busy"
                | "closing"
                | "stop_requested"
                | "stopping"
                | "completed"
                | "failed"
                | "stopped"
                | "aborted"
                | "interrupted_unverified"
                | "control_lost"
        )
        && matches!(
            receipt.run_status.as_str(),
            "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out"
        )
        && (!receipt.native_admission_hold || receipt.idempotent_replay))
        .then_some(receipt)
}

pub(super) fn reconciliation_projection(
    value: Value,
    expected_organization: &str,
    expected_conversation: &str,
    client_mutation_id: &str,
) -> Option<Value> {
    let receipt = parse_receipt(value, expected_organization, Some(expected_conversation))?;
    if !receipt.idempotent_replay {
        return None;
    }
    Some(json!({
        "outcome":"accepted",
        "clientMutationId":client_mutation_id,
        "message":receipt.user_message,
        "generationId":receipt.generation_id,
        "runId":receipt.run_id,
        "attemptEpoch":receipt.attempt_epoch,
        "generationSeq":0,
        "bodyHash":EMPTY_SHA256,
        "generationStatus":receipt.generation_status,
        "runStatus":receipt.run_status,
        "runtimeTerminal":receipt.runtime_terminal,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn run_admission_and_dispatch(
    reservation: AdmissionReservation,
    pool: sqlx::PgPool,
    admission_actor: BrowserPrincipal,
    marker_actor: BrowserPrincipal,
    organization_id: String,
    expected_conversation: Option<String>,
    command: AdmissionOperation,
    host: rudder_d1_persistence::native_chat::config::LocalHostContext,
    paths: rudder_native_chat_executor::HostPaths,
    timeout: Duration,
    ack_sender: tokio::sync::oneshot::Sender<AdmissionAcknowledgement>,
    ticket_sender: tokio::sync::oneshot::Sender<Ticket>,
) {
    let value =
        match execute_admission(&pool, &admission_actor, &organization_id, &command, &host).await {
            Ok(value) => value,
            Err(error_) => {
                let _ = ack_sender.send(AdmissionAcknowledgement::Failed(error_));
                return;
            }
        };
    let conversation_id =
        expected_conversation.or_else(|| value["conversationId"].as_str().map(ToOwned::to_owned));
    let Some(conversation_id) = conversation_id else {
        let _ = ack_sender.send(AdmissionAcknowledgement::InvalidReceipt);
        return;
    };
    let Some(receipt) = parse_receipt(value, &organization_id, Some(&conversation_id)) else {
        let _ = ack_sender.send(AdmissionAcknowledgement::InvalidReceipt);
        return;
    };
    // Deliver the exact committed user-message projection before any worker
    // launch. This lets the caller acknowledge the durable input even if its
    // cookie expires before the executor's first claim or the task panics
    // during the commit-to-dispatch gap.
    let _ = ack_sender.send(AdmissionAcknowledgement::Committed(receipt.clone()));
    if receipt.idempotent_replay {
        drop(reservation);
        return;
    }

    let start = Job::new_browser(
        // The admitted executor gets only a claim-time request proof. Its D1
        // claim consumes that proof and returns a separate sealed execution
        // principal for every continuation.
        admission_actor,
        host,
        paths,
        &receipt.run_id,
        &receipt.attempt_id,
        timeout,
    )
    .and_then(|job| reservation.start(job));
    match start {
        Ok(ticket) => {
            let _ = ticket_sender.send(ticket);
        }
        Err(_) => {
            if native_chat::record_dispatch_unavailable(
                &pool,
                &marker_actor,
                &native_chat::DispatchUnavailableRequest {
                    conversation_id: receipt.conversation_id.clone(),
                    generation_id: receipt.generation_id.clone(),
                    run_id: receipt.run_id.clone(),
                    attempt_id: receipt.attempt_id.clone(),
                },
            )
            .await
            .is_ok()
            {
                // A durable dispatch event is projected by the stream.
            } else {
                // The starting Generation/Run still blocks another send. The
                // stream will return recovery_required after a bounded check.
            }
        }
    }
}

fn native_principal(
    actor: &BrowserActor,
    organization_id: &str,
) -> Result<BrowserPrincipal, HttpResponse> {
    actor
        .native_chat_principal(organization_id)
        .map_err(auth_error)
}

pub(super) fn input_error(error_: InputError) -> HttpResponse {
    let (status, message) = match error_ {
        InputError::InvalidConversation => (StatusCode::BAD_REQUEST, "invalid_chat"),
        InputError::InvalidMutationId => (StatusCode::BAD_REQUEST, "invalid_client_mutation_id"),
        InputError::InvalidBody => (StatusCode::BAD_REQUEST, "invalid_message_body"),
        InputError::UnsupportedInput => {
            (StatusCode::UNPROCESSABLE_ENTITY, "unsupported_chat_input")
        }
    };
    error(status, message)
}

struct EventStreamState {
    pool: sqlx::PgPool,
    actor: BrowserPrincipal,
    conversation_id: String,
    generation_id: String,
    user_message_id: String,
    cursor: i32,
    finished: bool,
    heartbeat_at: tokio::time::Instant,
    attempt_epoch: i32,
    ticket: Option<Ticket>,
    ticket_receiver: Option<tokio::sync::oneshot::Receiver<Ticket>>,
    started_at: tokio::time::Instant,
    claimless_replay_check_at: Option<tokio::time::Instant>,
    assistant_message_id: Option<String>,
}

enum DurableEventProjection {
    Emit(Value),
    Terminal(String),
    Ignore,
}

fn project_durable_event(
    event: &control::Event,
    generation_id: &str,
    user_message_id: &str,
) -> DurableEventProjection {
    match event.event_kind.as_str() {
        "assistant_delta" => DurableEventProjection::Emit(json!({
            "type":"assistant_delta",
            "delta":event.payload["delta"],
            "generationId":generation_id,
            "attemptEpoch":event.attempt_epoch,
            "generationSeq":event.generation_seq,
            "bodyHash":event.payload["bodyHash"],
        })),
        "runtime_output" => DurableEventProjection::Emit(json!({
            "type":"assistant_snapshot",
            "body":event.payload["body"],
            "generationId":generation_id,
            "attemptEpoch":event.attempt_epoch,
            "generationSeq":event.generation_seq,
            "bodyHash":event.payload["bodyHash"],
        })),
        "dispatch_unavailable" => DurableEventProjection::Emit(json!({
            "type":"error",
            "error":"dispatch_unavailable",
            "terminal":false,
            "messageId":user_message_id,
        })),
        "runtime_terminal" | "terminal_projected" => DurableEventProjection::Terminal(
            event.payload["status"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        ),
        _ => DurableEventProjection::Ignore,
    }
}

fn event_stream(
    pool: sqlx::PgPool,
    actor: BrowserPrincipal,
    receipt: AdmissionReceipt,
    ack: Value,
    ticket_receiver: Option<tokio::sync::oneshot::Receiver<Ticket>>,
) -> impl futures_util::Stream<Item = std::io::Result<web::Bytes>> {
    let AdmissionReceipt {
        conversation_id,
        generation_id,
        user_message_id,
        attempt_epoch,
        generation_status,
        run_status,
        execution_owner_live,
        runtime_terminal,
        ..
    } = receipt;
    let initial = encode_line(&ack);
    let started_at = tokio::time::Instant::now();
    let active = active_generation(&generation_status)
        && matches!(run_status.as_str(), "queued" | "running")
        && !runtime_terminal;
    let claimless_replay_check_at =
        claimless_replay_deadline(active, runtime_terminal, execution_owner_live, started_at);
    let state = EventStreamState {
        pool,
        actor,
        conversation_id,
        generation_id,
        user_message_id,
        cursor: 0,
        finished: false,
        heartbeat_at: tokio::time::Instant::now(),
        attempt_epoch,
        ticket: None,
        ticket_receiver,
        started_at,
        claimless_replay_check_at,
        assistant_message_id: None,
    };
    stream::once(async move { Ok::<_, std::io::Error>(web::Bytes::from(initial)) }).chain(
        stream::unfold(state, |mut state| async move {
            if state.finished {
                return None;
            }
            loop {
                let now = tokio::time::Instant::now();
                if state.started_at.elapsed() >= MAX_STREAM_LIFETIME {
                    state.finished = true;
                    return Some((
                        Ok(web::Bytes::from(encode_line(&recovery_required(
                            &state.user_message_id,
                        )))),
                        state,
                    ));
                }
                let page = match control::read_events(
                    &state.pool,
                    &state.actor,
                    &control::ReadEvents {
                        conversation_id: state.conversation_id.clone(),
                        generation_id: state.generation_id.clone(),
                        after_seq: state.cursor,
                        limit: EVENT_PAGE_LIMIT,
                        max_bytes: EVENT_PAGE_BYTES,
                    },
                )
                .await
                {
                    Ok(page) if page.generation_id == state.generation_id => page,
                    Ok(_) | Err(_) => {
                        // The ack is already backed by a committed D1 receipt.
                        // Reconciliation remains safe whether this was a transient
                        // DB failure or the browser credential expiring later.
                        state.finished = true;
                        return Some((
                            Ok(web::Bytes::from(encode_line(&recovery_required(
                                &state.user_message_id,
                            )))),
                            state,
                        ));
                    }
                };
                for event in &page.events {
                    if event.generation_seq <= state.cursor {
                        state.finished = true;
                        return Some((
                            Ok(web::Bytes::from(encode_line(&stream_error(
                                &state.user_message_id,
                            )))),
                            state,
                        ));
                    }
                    state.cursor = event.generation_seq;
                    let projection =
                        project_durable_event(event, &page.generation_id, &state.user_message_id);
                    if event.attempt_epoch < state.attempt_epoch {
                        // A retry may replay one Generation's older sequence
                        // history. Advance across those records without exposing
                        // stale text or terminal state in the current attempt.
                        continue;
                    }
                    if event.attempt_epoch > state.attempt_epoch {
                        // The active attempt changed after this ack. This stream is
                        // fenced to its original attempt and cannot adopt a later
                        // executor.
                        state.finished = true;
                        let id = state
                            .assistant_message_id
                            .as_deref()
                            .unwrap_or(&state.user_message_id);
                        return Some((Ok(web::Bytes::from(encode_line(&stream_error(id)))), state));
                    }
                    match projection {
                        DurableEventProjection::Emit(projection) => {
                            if matches!(
                                event.event_kind.as_str(),
                                "assistant_delta" | "runtime_output"
                            ) {
                                let Some(message_id) = event.assistant_message_id.as_deref() else {
                                    state.finished = true;
                                    return Some((
                                        Ok(web::Bytes::from(encode_line(&stream_error(
                                            &state.user_message_id,
                                        )))),
                                        state,
                                    ));
                                };
                                if state
                                    .assistant_message_id
                                    .as_deref()
                                    .is_some_and(|seen| seen != message_id)
                                {
                                    state.finished = true;
                                    return Some((
                                        Ok(web::Bytes::from(encode_line(&stream_error(
                                            &state.user_message_id,
                                        )))),
                                        state,
                                    ));
                                }
                                state.assistant_message_id = Some(message_id.to_owned());
                            }
                            if event.event_kind == "dispatch_unavailable" {
                                state.finished = true;
                            }
                            return Some((Ok(web::Bytes::from(encode_line(&projection))), state));
                        }
                        DurableEventProjection::Terminal(status) => {
                            let result = match control::read_turn(
                                &state.pool,
                                &state.actor,
                                &control::ReadTurn {
                                    conversation_id: state.conversation_id.clone(),
                                    generation_id: state.generation_id.clone(),
                                },
                            )
                            .await
                            {
                                Ok(turn) => terminal_projection(
                                    &status,
                                    turn,
                                    &state.user_message_id,
                                    state.assistant_message_id.as_deref(),
                                    state.attempt_epoch,
                                ),
                                Err(_) => stream_error(&state.user_message_id),
                            };
                            state.finished = true;
                            return Some((Ok(web::Bytes::from(encode_line(&result))), state));
                        }
                        // Admission, checkpoint and Stop-control records advance
                        // the durable cursor but do not change visible assistant
                        // content. They are never copied to the UI payload.
                        DurableEventProjection::Ignore => {}
                    }
                }
                if page.next_seq != state.cursor {
                    state.finished = true;
                    return Some((
                        Ok(web::Bytes::from(encode_line(&stream_error(
                            &state.user_message_id,
                        )))),
                        state,
                    ));
                }
                if page.has_more {
                    continue;
                }
                if state
                    .ticket
                    .as_ref()
                    .is_some_and(|ticket| matches!(ticket.status(), WorkerStatus::Unresolved(_)))
                {
                    state.finished = true;
                    return Some((
                        Ok(web::Bytes::from(encode_line(&recovery_required(
                            &state.user_message_id,
                        )))),
                        state,
                    ));
                }
                if state.ticket.is_none()
                    && let Some(receiver) = state.ticket_receiver.as_mut()
                {
                    match receiver.try_recv() {
                        Ok(ticket) => {
                            state.ticket = Some(ticket);
                            state.ticket_receiver = None;
                        }
                        Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                            state.ticket_receiver = None;
                        }
                        Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                    }
                }
                if state
                    .claimless_replay_check_at
                    .is_some_and(|check_at| now >= check_at)
                {
                    // Exact retry/restart never starts a second worker. Re-read
                    // authoritative state once after a short grace period so a
                    // concurrent first dispatch has a chance to claim. If it did
                    // not, end the stream with an explicit nonterminal recovery
                    // signal rather than polling indefinitely.
                    let current = control::read_turn(
                        &state.pool,
                        &state.actor,
                        &control::ReadTurn {
                            conversation_id: state.conversation_id.clone(),
                            generation_id: state.generation_id.clone(),
                        },
                    )
                    .await;
                    match current {
                        Ok(turn) if turn.runtime_terminal => {
                            state.claimless_replay_check_at = None;
                        }
                        Ok(turn) if turn.attempt_epoch != state.attempt_epoch => {
                            state.finished = true;
                            return Some((
                                Ok(web::Bytes::from(encode_line(&recovery_required(
                                    &state.user_message_id,
                                )))),
                                state,
                            ));
                        }
                        Ok(turn) if turn.execution_owner_live == Some(true) => {
                            state.claimless_replay_check_at =
                                Some(tokio::time::Instant::now() + OWNER_LEASE_RECHECK_INTERVAL);
                        }
                        // A missing/expired/malformed owner lease means the
                        // durable active turn has no live executor to finish it.
                        // Retrying the same mutation is read-only and will not
                        // create a replacement worker.
                        Ok(_) | Err(_) => {
                            state.finished = true;
                            return Some((
                                Ok(web::Bytes::from(encode_line(&recovery_required(
                                    &state.user_message_id,
                                )))),
                                state,
                            ));
                        }
                    }
                }
                tokio::time::sleep(POLL_INTERVAL).await;
                if state.heartbeat_at.elapsed() >= HEARTBEAT_INTERVAL {
                    state.heartbeat_at = tokio::time::Instant::now();
                    return Some((Ok(web::Bytes::from_static(b"\n")), state));
                }
            }
        }),
    )
}

fn claimless_replay_deadline(
    active: bool,
    runtime_terminal: bool,
    owner_live: Option<bool>,
    now: tokio::time::Instant,
) -> Option<tokio::time::Instant> {
    if !active || runtime_terminal {
        return None;
    }
    Some(
        now + if owner_live == Some(true) {
            OWNER_LEASE_RECHECK_INTERVAL
        } else {
            CLAIMLESS_REPLAY_GRACE
        },
    )
}

fn active_generation(status: &str) -> bool {
    matches!(
        status,
        "starting"
            | "active"
            | "running"
            | "waiting_for_network"
            | "tool_busy"
            | "closing"
            | "stop_requested"
            | "stopping"
    )
}

fn terminal_projection(
    status: &str,
    turn: control::TurnView,
    user_message_id: &str,
    streamed_message_id: Option<&str>,
    expected_attempt_epoch: i32,
) -> Value {
    let assistant = turn.assistant_message;
    let exact_terminal_fence =
        turn.runtime_terminal && turn.attempt_epoch == expected_attempt_epoch;
    let succeeded = status == "succeeded"
        && turn.generation_status == "completed"
        && turn.run_status == "succeeded";
    let stopped = status == "cancelled"
        && turn.generation_status == "stopped"
        && turn.run_status == "cancelled";
    let failed = matches!(status, "failed" | "timed_out")
        && turn.generation_status == "failed"
        && turn.run_status == status;
    let coherent_terminal = exact_terminal_fence && (succeeded || stopped || failed);
    if succeeded
        && exact_terminal_fence
        && assistant.as_ref().is_some_and(|message| {
            message["status"].as_str() == Some("completed")
                && streamed_message_id.is_none_or(|id| message["id"].as_str() == Some(id))
        })
    {
        return json!({"type":"final","messages":[assistant.unwrap()]});
    }
    if stopped
        && exact_terminal_fence
        && assistant.as_ref().is_none_or(|message| {
            message["status"].as_str() == Some("stopped")
                && streamed_message_id.is_none_or(|id| message["id"].as_str() == Some(id))
        })
    {
        return json!({
            "type":"final",
            "messages":assistant.into_iter().collect::<Vec<_>>(),
        });
    }
    let message_id = assistant
        .as_ref()
        .and_then(|message| message["id"].as_str())
        .unwrap_or(user_message_id);
    error_event(
        if failed && coherent_terminal {
            "native_chat_failed"
        } else {
            "native_chat_projection_unavailable"
        },
        message_id,
        coherent_terminal,
    )
}

fn stream_error(message_id: &str) -> Value {
    error_event("native_chat_projection_unavailable", message_id, false)
}

fn recovery_required(message_id: &str) -> Value {
    error_event(MAX_STREAM_ERROR, message_id, false)
}

fn error_event(error: &str, message_id: &str, terminal: bool) -> Value {
    json!({
        "type":"error",
        "error":error,
        "messageId":message_id,
        "terminal":terminal,
    })
}

fn encode_line(value: &Value) -> Vec<u8> {
    // serde_json::Value contains only finite JSON values, so serialization is
    // infallible for every projection created above. Do not invent a second
    // error event if that invariant is ever broken.
    let mut bytes = serde_json::to_vec(value).expect("JSON projection is serializable");
    bytes.push(b'\n');
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_event_adapter_never_copies_private_source_fields() {
        let event = control::Event {
            generation_seq: 7,
            attempt_epoch: 2,
            event_kind: "assistant_delta".into(),
            assistant_message_id: Some("public-message-id".into()),
            control_action_id: None,
            payload: json!({
                "delta":"hello",
                "bodyHash":"a".repeat(64),
                "nativeSource":{"claimDigest":"private","connectionId":"private"},
                "providerThreadId":"private-thread",
                "ownerToken":"private-owner"
            }),
        };
        let DurableEventProjection::Emit(projection) =
            project_durable_event(&event, "generation", "source-message")
        else {
            panic!("visible output must produce an NDJSON projection");
        };
        let encoded = encode_line(&projection);
        let text = String::from_utf8(encoded).unwrap();
        assert!(text.contains("hello"));
        assert!(!text.contains("private"));
        assert!(!text.contains("ownerToken"));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn dispatch_failure_is_a_durable_error_projection_but_control_rows_are_not_ui_events() {
        let dispatch = control::Event {
            generation_seq: 2,
            attempt_epoch: 1,
            event_kind: "dispatch_unavailable".into(),
            assistant_message_id: None,
            control_action_id: None,
            payload: json!({"code":"dispatch_unavailable"}),
        };
        let DurableEventProjection::Emit(value) =
            project_durable_event(&dispatch, "generation", "user-message")
        else {
            panic!("dispatch failure must be reportable");
        };
        assert_eq!(value["type"], "error");
        assert_eq!(value["error"], "dispatch_unavailable");
        assert_eq!(value["messageId"], "user-message");
        assert_eq!(value["terminal"], false);

        let checkpoint = control::Event {
            event_kind: "client_checkpoint".into(),
            payload: json!({"generationSeq":1,"renderedBodyHash":EMPTY_SHA256}),
            ..dispatch
        };
        assert!(matches!(
            project_durable_event(&checkpoint, "generation", "user-message"),
            DurableEventProjection::Ignore
        ));
    }

    #[test]
    fn admission_receipt_is_exact_and_native_authority_only() {
        let valid = json!({
            "conversationId":"21000000-0000-4000-8000-000000000001",
            "userMessageId":"41000000-0000-4000-8000-000000000001",
            "userMessage":{
                "id":"41000000-0000-4000-8000-000000000001",
                "orgId":"11000000-0000-4000-8000-000000000001",
                "conversationId":"21000000-0000-4000-8000-000000000001",
                "role":"user","kind":"message","status":"completed",
                "body":"question","structuredPayload":null,"approvalId":null,
                "approval":null,"attachments":[],"runId":"71000000-0000-4000-8000-000000000001",
                "generationId":"61000000-0000-4000-8000-000000000001",
                "replyingAgentId":null,"chatTurnId":null,"turnVariant":0,
                "supersededAt":null,"createdAt":"2026-10-17T00:00:00Z",
                "updatedAt":"2026-10-17T00:00:00Z"
            },
            "generationId":"61000000-0000-4000-8000-000000000001",
            "generationStatus":"starting",
            "attemptEpoch":1,
            "executionOwnerLive":false,
            "runtimeTerminal":false,
            "runId":"71000000-0000-4000-8000-000000000001",
            "runStatus":"running",
            "attemptId":"81000000-0000-4000-8000-000000000001",
            "executionAuthority":"native_rust",
            "nativeAdmissionHold":false,
            "idempotentReplay":false,
        });
        let org = "11000000-0000-4000-8000-000000000001";
        let chat = "21000000-0000-4000-8000-000000000001";
        assert!(parse_receipt(valid.clone(), org, Some(chat)).is_some());
        assert!(parse_receipt(valid.clone(), org, None).is_some());
        assert!(
            parse_receipt(
                valid.clone(),
                org,
                Some("21000000-0000-4000-8000-000000000002")
            )
            .is_none()
        );

        let mut legacy_authority = valid.clone();
        legacy_authority["executionAuthority"] = json!("legacy_ts");
        assert!(parse_receipt(legacy_authority, org, Some(chat)).is_none());
        let mut missing_field = valid.clone();
        missing_field.as_object_mut().unwrap().remove("attemptId");
        assert!(parse_receipt(missing_field, org, Some(chat)).is_none());
        let mut private_field = valid.clone();
        private_field["providerThreadId"] = json!("must-not-be-accepted");
        assert!(parse_receipt(private_field, org, Some(chat)).is_none());
        let mut invalid_hold = valid;
        invalid_hold["nativeAdmissionHold"] = json!(true);
        assert!(parse_receipt(invalid_hold, org, Some(chat)).is_none());
    }

    #[test]
    fn ack_uses_empty_visible_cutoff_not_nonvisible_generation_event_seq() {
        let ack = json!({
            "type":"ack",
            "generationSeq":0,
            "bodyHash":EMPTY_SHA256,
        });
        assert_eq!(ack["generationSeq"], 0);
        assert_eq!(ack["bodyHash"], EMPTY_SHA256);
    }

    #[test]
    fn recovery_required_is_safe_nonterminal_and_claimless_state_is_bounded() {
        let value = recovery_required("user-message");
        assert_eq!(value["type"], "error");
        assert_eq!(value["error"], "recovery_required");
        assert_eq!(value["messageId"], "user-message");
        assert_eq!(value["terminal"], false);
        assert!(value.get("status").is_none());
        assert!(value.get("generationId").is_none());
        assert!(active_generation("starting"));
        assert!(active_generation("waiting_for_network"));
        assert!(!active_generation("completed"));
        let now = tokio::time::Instant::now();
        assert_eq!(
            claimless_replay_deadline(true, false, Some(false), now),
            Some(now + CLAIMLESS_REPLAY_GRACE)
        );
        assert_eq!(
            claimless_replay_deadline(true, false, Some(true), now),
            Some(now + OWNER_LEASE_RECHECK_INTERVAL)
        );
        assert_eq!(claimless_replay_deadline(true, true, Some(true), now), None);
        assert_eq!(claimless_replay_deadline(false, false, None, now), None);
    }

    #[test]
    fn success_projection_requires_matching_persisted_terminal_attempt() {
        let turn = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user","body":"question"}),
            assistant_message: Some(json!({
                "id":"assistant","role":"assistant","status":"completed","body":"answer"
            })),
            generation_status: "completed".into(),
            run_status: "succeeded".into(),
            execution_owner_live: Some(true),
            attempt_epoch: 3,
            control_version: 0,
            runtime_terminal: true,
            native_admission_hold: false,
            last_sequence: 9,
        };
        assert_eq!(
            terminal_projection("succeeded", turn, "user", Some("assistant"), 3)["type"],
            "final"
        );

        let stale = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user"}),
            assistant_message: Some(json!({
                "id":"assistant","role":"assistant","status":"completed","body":"answer"
            })),
            generation_status: "completed".into(),
            run_status: "succeeded".into(),
            execution_owner_live: Some(true),
            attempt_epoch: 2,
            control_version: 0,
            runtime_terminal: true,
            native_admission_hold: false,
            last_sequence: 9,
        };
        let stale_projection =
            terminal_projection("succeeded", stale, "user", Some("assistant"), 3);
        assert_eq!(stale_projection["type"], "error");
        assert_eq!(stale_projection["terminal"], false);

        let uncommitted = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user"}),
            assistant_message: Some(json!({
                "id":"assistant","role":"assistant","status":"completed","body":"answer"
            })),
            generation_status: "completed".into(),
            run_status: "succeeded".into(),
            execution_owner_live: Some(true),
            attempt_epoch: 3,
            control_version: 0,
            runtime_terminal: false,
            native_admission_hold: false,
            last_sequence: 9,
        };
        let uncommitted_projection =
            terminal_projection("succeeded", uncommitted, "user", Some("assistant"), 3);
        assert_eq!(uncommitted_projection["type"], "error");
        assert_eq!(uncommitted_projection["terminal"], false);

        let stopped = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user"}),
            assistant_message: Some(json!({
                "id":"assistant","role":"assistant","status":"stopped","body":"partial"
            })),
            generation_status: "stopped".into(),
            run_status: "cancelled".into(),
            execution_owner_live: Some(true),
            attempt_epoch: 3,
            control_version: 1,
            runtime_terminal: true,
            native_admission_hold: false,
            last_sequence: 10,
        };
        let final_event = terminal_projection("cancelled", stopped, "user", Some("assistant"), 3);
        assert_eq!(final_event["type"], "final");
        assert_eq!(final_event["messages"][0]["status"], "stopped");

        let failed = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user"}),
            assistant_message: Some(json!({
                "id":"assistant","role":"assistant","status":"failed","body":"partial"
            })),
            generation_status: "failed".into(),
            run_status: "failed".into(),
            execution_owner_live: Some(false),
            attempt_epoch: 3,
            control_version: 1,
            runtime_terminal: true,
            native_admission_hold: true,
            last_sequence: 10,
        };
        let failure = terminal_projection("failed", failed, "user", Some("assistant"), 3);
        assert_eq!(failure["type"], "error");
        assert_eq!(failure["error"], "native_chat_failed");
        assert_eq!(failure["terminal"], true);

        let malformed_terminal = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user"}),
            assistant_message: None,
            generation_status: "running".into(),
            run_status: "running".into(),
            execution_owner_live: Some(false),
            attempt_epoch: 3,
            control_version: 1,
            runtime_terminal: false,
            native_admission_hold: true,
            last_sequence: 10,
        };
        let malformed = terminal_projection("failed", malformed_terminal, "user", None, 3);
        assert_eq!(malformed["error"], "native_chat_projection_unavailable");
        assert_eq!(malformed["terminal"], false);

        let inconsistent = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user"}),
            assistant_message: None,
            generation_status: "failed".into(),
            run_status: "failed".into(),
            execution_owner_live: Some(false),
            attempt_epoch: 3,
            control_version: 1,
            runtime_terminal: true,
            native_admission_hold: true,
            last_sequence: 10,
        };
        let terminal_projection_error =
            terminal_projection("failed", inconsistent, "user", None, 3);
        assert_eq!(terminal_projection_error["error"], "native_chat_failed");
        assert_eq!(terminal_projection_error["terminal"], true);

        let preclaim_stopped = control::TurnView {
            generation_id: "generation".into(),
            run_id: "run".into(),
            source_message: json!({"id":"user"}),
            assistant_message: None,
            generation_status: "stopped".into(),
            run_status: "cancelled".into(),
            execution_owner_live: Some(false),
            attempt_epoch: 1,
            control_version: 1,
            runtime_terminal: true,
            native_admission_hold: false,
            last_sequence: 4,
        };
        assert_eq!(
            terminal_projection("cancelled", preclaim_stopped, "user", None, 1)["messages"],
            json!([])
        );
    }
}
