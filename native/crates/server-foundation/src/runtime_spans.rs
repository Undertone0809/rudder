//! Signed internal transport only; Rust persistence owns target authorization,
//! immutable identity and all span/locator effects.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_codex_app_server::{
    ProcessLaunch, ThreadReadError, ThreadReadSelection, project_public_transcript,
    read_exact_thread_turn,
};
use rudder_d1_persistence::{
    native_chat::config::historical_codex_profile_home,
    runtime_spans::{
        self, CodexTranscriptReadCompletion, CodexTranscriptReadPreflight, Error, Request,
    },
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
use uuid::Uuid;

pub(super) async fn command(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    // Inspect only the operation tag to select the signed capability. The
    // typed command is decoded after its complete original bytes are verified.
    let action = match serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value["operation"].as_str().map(str::to_owned))
        .as_deref()
    {
        Some("open") => "runtime.span.open",
        Some("bind_locator") => "runtime.span.bind_locator",
        Some("close") => "runtime.span.close",
        Some("seal_segment") => "runtime.span.seal_segment",
        Some("reconcile_segment") => "runtime.span.reconcile_segment",
        Some("read") => "runtime.span.read",
        Some("read_transcript") => "runtime.span.read_transcript",
        Some("read_message_transcript") => "runtime.span.read_message_transcript",
        Some("read_conversation_messages") => "runtime.span.read_conversation_messages",
        _ => {
            return HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid runtime span operation"}));
        }
    };
    let actor = match state.verify_actor_envelope(&request, &org_id, action, None, &body) {
        Ok(actor) => actor,
        Err(ActorEnvelopeVerificationError::Unconfigured) => {
            return unavailable();
        }
        Err(ActorEnvelopeVerificationError::Invalid) => {
            return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
        }
    };
    let input = match serde_json::from_slice::<Request>(&body) {
        Ok(input) => input,
        Err(_) => {
            return HttpResponse::UnprocessableEntity()
                .json(json!({"error":"Invalid runtime span request"}));
        }
    };
    let DatabaseState::Configured(pool) = &state.database else {
        return unavailable();
    };
    match execute_read(pool, &actor, &org_id, &input, &state).await {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(Error::Http(status, message)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        Err(error) => {
            tracing::warn!(error = %error, "Rust runtime span authority failed");
            HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
        }
    }
}

async fn execute_read(
    pool: &sqlx::PgPool,
    actor: &crate::VerifiedActor,
    organization_id: &str,
    request: &Request,
    state: &AppState,
) -> Result<Value, Error> {
    let ledger = runtime_spans::execute(pool, actor, organization_id, request).await?;
    let Request::ReadMessageTranscript { .. } = request else {
        return Ok(ledger);
    };
    if !ledger["transcript"].as_array().is_some_and(Vec::is_empty) {
        return Ok(ledger);
    }
    match runtime_spans::prepare_codex_transcript_read(pool, actor, organization_id, request)
        .await?
    {
        CodexTranscriptReadPreflight::LedgerPresent => Ok(with_reader_status(
            ledger,
            "incomplete",
            "ledger_source_not_projectable",
        )),
        CodexTranscriptReadPreflight::NotApplicable => Ok(ledger),
        CodexTranscriptReadPreflight::Incomplete(reason) => {
            Ok(with_reader_status(ledger, "incomplete", reason))
        }
        CodexTranscriptReadPreflight::Read(plan) => {
            let Some(runtime) = state
                .native_chat_public_runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            else {
                return Ok(with_reader_status(
                    ledger,
                    "unavailable",
                    "reader_runtime_unavailable",
                ));
            };
            if runtime.host.host_id() != plan.host_id() {
                return Ok(with_reader_status(
                    ledger,
                    "unavailable",
                    "historical_host_unavailable",
                ));
            }
            let (launch, profile_home) = match codex_reader_launch(&runtime, &plan) {
                Ok(launch) => launch,
                Err(reason) => {
                    return Ok(with_reader_status(ledger, "unavailable", reason));
                }
            };
            // The owned process transport is blocking and can remain open up
            // to the configured read deadline. Keep it off Actix's async
            // request executor while preserving the post-IPC SQL fence below.
            let process_host = runtime.paths.process_host.clone();
            let thread_id = plan.thread_id().to_owned();
            let turn_id = plan.turn_id().to_owned();
            let timeout = runtime.timeout;
            let read_result = tokio::task::spawn_blocking(move || {
                read_exact_thread_turn(
                    launch,
                    &process_host,
                    &profile_home,
                    &thread_id,
                    &turn_id,
                    timeout,
                )
            })
            .await
            .unwrap_or(Err(ThreadReadError::Unavailable));
            let (entries, unavailable_reason) = match read_result {
                Ok(ThreadReadSelection::Turn(turn)) => {
                    match project_public_transcript(&turn, plan.message_timestamp()) {
                        Ok(entries) => (entries, None),
                        Err(error) => (Vec::new(), Some(thread_read_error_reason(error))),
                    }
                }
                Ok(ThreadReadSelection::UnknownTurn) => (Vec::new(), Some("exact_turn_not_found")),
                Ok(ThreadReadSelection::Unsupported) => {
                    (Vec::new(), Some("provider_read_unsupported"))
                }
                Ok(ThreadReadSelection::Incomplete) => {
                    (Vec::new(), Some("provider_turn_unhydrated"))
                }
                Err(error) => (Vec::new(), Some(thread_read_error_reason(error))),
            };
            match runtime_spans::complete_codex_transcript_read(
                pool,
                actor,
                organization_id,
                &plan,
                &entries,
            )
            .await?
            {
                CodexTranscriptReadCompletion::UseSqlPrefix => {
                    let prefix =
                        runtime_spans::execute(pool, actor, organization_id, request).await?;
                    Ok(with_reader_status(
                        prefix,
                        "incomplete",
                        "provider_read_fenced",
                    ))
                }
                CodexTranscriptReadCompletion::Complete(value) => match unavailable_reason {
                    Some(reason) => Ok(runtime_spans::incomplete_codex_transcript_response(
                        &plan, reason,
                    )),
                    None => Ok(value),
                },
            }
        }
    }
}

fn with_reader_status(mut value: Value, availability: &str, reason: &str) -> Value {
    if !value["reader"].is_object() {
        value["reader"] = json!({});
    }
    value["reader"]["availability"] = json!(availability);
    value["reader"]["reason"] = json!(reason);
    value
}

fn thread_read_error_reason(error: ThreadReadError) -> &'static str {
    match error {
        ThreadReadError::Oversized => "provider_response_too_large",
        ThreadReadError::Malformed => "provider_response_malformed",
        ThreadReadError::ProviderRejected => "provider_rejected_read",
        ThreadReadError::Unsupported => "provider_read_unsupported",
        ThreadReadError::Incomplete => "provider_turn_incomplete",
        ThreadReadError::Unavailable => "reader_process_unavailable",
    }
}

fn codex_reader_launch(
    runtime: &crate::NativeChatPublicRuntime,
    plan: &runtime_spans::CodexTranscriptReadPlan,
) -> Result<(ProcessLaunch, String), &'static str> {
    let host = &runtime.host;
    let paths = &runtime.paths;
    if !host.has_trusted_executable_search_path() {
        return Err("trusted_executable_path_unavailable");
    }
    let profile_home = historical_codex_profile_home(
        host,
        plan.organization_id(),
        plan.agent_id(),
        plan.profile_id(),
    )
    .map_err(|_| "historical_profile_unavailable")?;
    for path in [
        &paths.process_host,
        &paths.runtime_root,
        &paths.isolated_home,
        &profile_home,
    ] {
        if !path.is_absolute() || path.canonicalize().as_ref().ok() != Some(path) {
            return Err("historical_profile_unavailable");
        }
    }
    if !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
        || !profile_home.is_dir()
    {
        return Err("historical_profile_unavailable");
    }
    let text = |path: &Path| path.to_str().map(str::to_owned).ok_or("invalid_host_path");
    let mut env = BTreeMap::new();
    let isolated_home = text(&paths.isolated_home)?;
    env.insert("HOME".into(), isolated_home.clone());
    env.insert("USERPROFILE".into(), isolated_home);
    env.insert("CODEX_HOME".into(), text(&profile_home)?);
    env.insert("PATH".into(), host.executable_search_path().to_owned());
    let profile_home = text(&profile_home)?;
    Ok((
        ProcessLaunch {
            executable: text(host.codex_executable())?,
            argv: if plan.profile_id().ends_with(":operator-default") {
                vec!["app-server".into()]
            } else {
                vec!["app-server".into(), "--strict-config".into()]
            },
            cwd: text(&paths.isolated_home)?,
            env,
            request_id: plan.attempt_id().to_owned(),
            run_id: plan.run_id().to_owned(),
            attempt_id: plan.attempt_id().to_owned(),
            owner_token: format!("codex-reader:{}:{}", plan.attempt_id(), Uuid::new_v4()),
            runtime_root: text(&paths.runtime_root)?,
        },
        profile_home,
    ))
}

fn unavailable() -> HttpResponse {
    HttpResponse::ServiceUnavailable()
        .json(json!({"error":"Rust runtime span authority is unavailable"}))
}

#[cfg(test)]
mod tests;
