//! Existing Hermes Agent approval bridge. D1/driver owns Rudder approval rows;
//! this provider transport only submits the returned explicit decision.
use super::*;

fn choice(value: &str) -> Option<AgentRunApprovalChoice> {
    match value.trim().to_ascii_lowercase().as_str() {
        "approved" | "approve" | "allow" | "once" => Some(AgentRunApprovalChoice::Once),
        "deny" | "denied" | "rejected" | "reject" => Some(AgentRunApprovalChoice::Deny),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)] // Bind the provider approval to this Run/session/event.
pub(super) async fn resolve(
    client: &awc::Client,
    base: &url::Url,
    headers: &BTreeMap<String, String>,
    run: &str,
    session: &str,
    request: &Request,
    event: &Value,
    timeout: Duration,
) -> Result<(), Error> {
    if let Ok(mut observed) = request.observed_approval.lock() {
        *observed = json!({"pending":true,"resolved":false,"decision":null,"rudderApprovalId":null,"error":null});
    }
    let configured = request.context["approvalStatus"].as_str().and_then(choice);
    let (choice, approval_id) = if let Some(choice) = configured {
        (choice, None)
    } else {
        let Some(output) = &request.output else {
            return unresolved(
                request,
                "Hermes approval is pending and no Rudder approval bridge is available.",
            );
        };
        let (reply, mut decision) = tokio::sync::oneshot::channel();
        let bounded_timeout = timeout
            .max(Duration::from_secs(1))
            .min(Duration::from_secs(30 * 60));
        tokio::time::timeout(
            Duration::from_secs(5),
            output.send(AgentRunOutput::ApprovalRequest {
                offset: request.output_sequence.fetch_add(1, Ordering::AcqRel),
                provider_run_id: run.into(),
                session_id: session.into(),
                event: event.clone(),
                timeout: bounded_timeout,
                reply,
            }),
        )
        .await
        .map_err(|_| {
            Error::Failed("Run output persistence timed out while requesting approval".into())
        })?
        .map_err(|_| {
            Error::Failed("Run output persistence channel closed while requesting approval".into())
        })?;
        let started = tokio::time::Instant::now();
        let decision = loop {
            if cancelled(request) {
                return Err(Error::Cancelled);
            }
            if started.elapsed() >= bounded_timeout {
                return unresolved(
                    request,
                    "Hermes approval remained unresolved before the bounded wait expired.",
                );
            }
            match tokio::time::timeout(Duration::from_millis(100), &mut decision).await {
                Ok(Ok(decision)) => break decision,
                Ok(Err(_)) => {
                    return unresolved(
                        request,
                        "Hermes approval bridge closed before returning a decision.",
                    );
                }
                Err(_) => (),
            }
        };
        if let Ok(mut observed) = request.observed_approval.lock() {
            observed["rudderApprovalId"] = json!(decision.approval_id);
        }
        match decision.choice {
            Some(choice) => (choice, decision.approval_id),
            None => {
                return unresolved(
                    request,
                    decision.error.as_deref().unwrap_or(
                        "Hermes approval is pending and no Rudder approval decision was supplied.",
                    ),
                );
            }
        }
    };
    if cancelled(request) {
        return Err(Error::Cancelled);
    }
    let selected = match choice {
        AgentRunApprovalChoice::Once => "once",
        AgentRunApprovalChoice::Deny => "deny",
    };
    let response = json_request(
        client,
        awc::http::Method::POST,
        &endpoint(base, &format!("/v1/runs/{}/approval", encoded(run))),
        headers,
        Some(&json!({"choice":selected})),
        timeout.min(Duration::from_secs(15)),
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return unresolved(
            request,
            &format!("Hermes approval returned HTTP {}", response.status),
        );
    }
    if let Ok(mut observed) = request.observed_approval.lock() {
        observed["resolved"] = json!(true);
        observed["decision"] = json!(selected);
        observed["rudderApprovalId"] = json!(approval_id);
    }
    Ok(())
}

fn unresolved<T>(request: &Request, message: &str) -> Result<T, Error> {
    if let Ok(mut observed) = request.observed_approval.lock() {
        observed["error"] = json!(message);
    }
    Err(Error::Failed(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_pending_or_absent_decision_never_authorizes_provider_work() {
        assert_eq!(choice("approved"), Some(AgentRunApprovalChoice::Once));
        assert_eq!(choice("rejected"), Some(AgentRunApprovalChoice::Deny));
        for status in ["pending", "revision_requested", "", "success", "true"] {
            assert_eq!(choice(status), None);
        }
    }
}
