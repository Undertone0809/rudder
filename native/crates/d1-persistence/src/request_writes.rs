//! Assistance resolution/cancellation and its native Issue wake form one transaction.
use crate::{
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_idempotent},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    agent_execution::{self, AgentExecutionActor, AgentExecutionError, AgentWakeRequest},
    issue_core_writes::{IssueRunEvent, append_issue_run_event, redact_sensitive_text},
    request_reads::projection,
};
use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

pub const REQUEST_WRITE_SCOPE: &str = "request-write";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestWriteOperation {
    Resolve,
    Cancel,
}
impl RequestWriteOperation {
    pub fn action(self) -> &'static str {
        match self {
            Self::Resolve => "request.resolve",
            Self::Cancel => "request.cancel",
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum RequestWriteError {
    #[error("{1}")]
    Http(u16, String),
    #[error("Validation error")]
    Validation(Value),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Admission(#[from] AgentExecutionError),
}
type Result<T> = std::result::Result<T, RequestWriteError>;
fn http(status: u16, message: &str) -> RequestWriteError {
    RequestWriteError::Http(status, message.into())
}

/// Zod's object strips unknown keys; strings trim using ECMAScript whitespace
/// and length checks count UTF-16 code units, as the existing public validators do.
pub fn validate_input(operation: RequestWriteOperation, input: &Value) -> Result<Value> {
    fn kind(value: Option<&Value>) -> &'static str {
        match value {
            None => "undefined",
            Some(Value::Null) => "null",
            Some(Value::Bool(_)) => "boolean",
            Some(Value::Number(_)) => "number",
            Some(Value::String(_)) => "string",
            Some(Value::Array(_)) => "array",
            Some(Value::Object(_)) => "object",
        }
    }
    fn wrong(expected: &str, value: Option<&Value>, path: Value) -> Value {
        let received = kind(value);
        json!({"code":"invalid_type","expected":expected,"received":received,"path":path,"message":if received=="undefined" { "Required".into() } else {format!("Expected {expected}, received {received}")}})
    }
    let Some(object) = input.as_object() else {
        return Err(RequestWriteError::Validation(json!([wrong(
            "object",
            Some(input),
            json!([])
        )])));
    };
    let mut issues = Vec::new();
    let mut result = json!({});
    if operation == RequestWriteOperation::Resolve {
        let options = ["answered", "action_completed", "cannot_help"];
        let value = object.get("resolution");
        let expected = "'answered' | 'action_completed' | 'cannot_help'";
        if let Some(text) = value.and_then(Value::as_str) {
            if options.contains(&text) {
                result["resolution"] = json!(text);
            } else {
                issues.push(json!({"received":text,"code":"invalid_enum_value","options":options,"path":["resolution"],"message":format!("Invalid enum value. Expected {expected}, received '{text}'")}));
            }
        } else {
            issues.push(wrong(expected, value, json!(["resolution"])));
        }
    }
    let (field, limit, required) = if operation == RequestWriteOperation::Resolve {
        ("response", 20_000, true)
    } else {
        ("reason", 2_000, false)
    };
    match object.get(field) {
        Some(Value::String(text)) => {
            let text=text.trim_matches(|ch| matches!(ch,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'));
            let length = text.encode_utf16().count();
            if length == 0 {
                issues.push(json!({"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":[field]}));
            }
            if length > limit {
                issues.push(json!({"code":"too_big","maximum":limit,"type":"string","inclusive":true,"exact":false,"message":format!("String must contain at most {limit} character(s)"),"path":[field]}));
            }
            result[field] = json!(text);
        }
        None if !required => (),
        value => issues.push(wrong("string", value, json!([field]))),
    }
    if issues.is_empty() {
        Ok(result)
    } else {
        Err(RequestWriteError::Validation(json!(issues)))
    }
}

/// The adapter's signed identity is separate from client input. Credentials and
/// organization access are rechecked after the existing Issue→Request→Agent locks.
pub async fn execute(
    pool: &PgPool,
    actor: &VerifiedActor,
    authorizer: &dyn NativeAgentAuthorizer,
    request_id: &str,
    operation: RequestWriteOperation,
    input: &Value,
) -> Result<Value> {
    let input = validate_input(operation, input)?;
    if actor.organization_id() != REQUEST_WRITE_SCOPE {
        return Err(http(401, "Unauthorized"));
    }
    let mut tx = pool.begin().await?;
    let preliminary = sqlx::query(
        "SELECT org_id::text AS org,issue_id::text AS issue FROM requests WHERE id=$1::uuid",
    )
    .bind(request_id)
    .fetch_optional(&mut *tx)
    .await?;
    // Request identity preserves the existing Requests-before-Approvals winner.
    let org = if let Some(row) = &preliminary {
        row.try_get::<String, _>("org")?
    } else {
        sqlx::query_scalar::<_, String>("SELECT org_id::text FROM approvals WHERE id=$1::uuid")
            .bind(request_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| http(404, "Request not found"))?
    };
    let issue_id = preliminary
        .as_ref()
        .map(|r| r.try_get::<Option<String>, _>("issue"))
        .transpose()?
        .flatten();
    if let Some(issue) = issue_id.as_deref() {
        sqlx::query("SELECT p.id FROM projects p JOIN issues i ON i.project_id=p.id WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR KEY SHARE")
            .bind(&org).bind(issue).execute(&mut *tx).await?;
        sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
            .bind(&org)
            .bind(issue)
            .execute(&mut *tx)
            .await?;
    }
    let query = format!(
        "SELECT {} AS value FROM requests t WHERE id=$1::uuid FOR UPDATE",
        projection("requests")
    );
    let current = sqlx::query_scalar::<_, String>(&query)
        .bind(request_id)
        .fetch_optional(&mut *tx)
        .await?;
    let request = current
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()?;
    let mut issue = if let Some(issue) = issue_id.as_deref() {
        sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('id',id,'title',title,'description',description,'status',status,'priority',priority,'assigneeAgentId',assignee_agent_id) FROM issues WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(&org).bind(issue).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    let wake_agent =
        if operation == RequestWriteOperation::Resolve && input["resolution"] != "cannot_help" {
            request
                .as_ref()
                .filter(|r| r["status"] == "open")
                .and_then(|r| {
                    let i = issue.as_ref()?;
                    let agent = i["assigneeAgentId"].as_str()?;
                    (r["assigneeAgentId"].as_str() == Some(agent)
                        && matches!(
                            i["status"].as_str(),
                            Some("blocked" | "todo" | "in_progress")
                        ))
                    .then(|| agent.to_owned())
                })
        } else {
            None
        };
    let agent = if let Some(agent) = wake_agent.as_deref() {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("agent-run-state:{agent}"))
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT name,status,pause_reason,runtime_config,agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
            .bind(&org).bind(agent).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    match authorizer.revalidate(&mut tx, &org).await? {
        NativeAgentAccess::Authorized => (),
        NativeAgentAccess::Unauthorized => return Err(http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => {
            return Err(http(403, "User does not have access to this organization"));
        }
    }
    if actor.actor().kind != "user" {
        return Err(http(
            403,
            match operation {
                RequestWriteOperation::Resolve => {
                    "Only a human operator can resolve an Assistance Request"
                }
                RequestWriteOperation::Cancel => {
                    "Only a human operator can cancel an Assistance Request"
                }
            },
        ));
    }
    let request = request.ok_or_else(|| http(404, "Request not found"))?;
    if request["orgId"] != org {
        return Err(http(404, "Request not found"));
    }
    if request["kind"] != "assistance" {
        return Err(http(
            422,
            match operation {
                RequestWriteOperation::Resolve => {
                    "Approval Requests must use the Approval decision actions"
                }
                RequestWriteOperation::Cancel => {
                    "Approval Requests must use the Approval cancellation actions"
                }
            },
        ));
    }
    // SQL accepts UUID spelling aliases; legacy service effects use the stored ID.
    let request_id = request["id"]
        .as_str()
        .ok_or_else(|| http(500, "Internal server error"))?;
    let status = request["status"].as_str().unwrap_or("");
    if status != "open" {
        if operation == RequestWriteOperation::Cancel
            || status == "superseded"
            || (status == "resolved" && request["resolution"] == input["resolution"])
        {
            tx.commit().await?;
            return Ok(with_wake(request, operation, None));
        }
        return Err(http(422, "Only an open Assistance Request can be resolved"));
    }
    agent_execution::mark_native_write(&mut tx).await?;
    let (event_type, message, prefix, new_status, response, resolution) = match operation {
        RequestWriteOperation::Resolve => (
            "request.resolved",
            "Assistance Request resolved",
            "request-resolved",
            "resolved",
            Some(redact_sensitive_text(input["response"].as_str().unwrap())),
            input["resolution"].as_str(),
        ),
        RequestWriteOperation::Cancel => (
            "request.cancelled",
            "Assistance Request cancelled",
            "request-cancelled",
            "cancelled",
            input["reason"].as_str().map(redact_sensitive_text),
            None,
        ),
    };
    let now: String =
        sqlx::query_scalar("SELECT date_trunc('milliseconds',clock_timestamp())::text")
            .fetch_one(&mut *tx)
            .await?;
    let updated=sqlx::query_scalar::<_,String>(&format!("UPDATE requests t SET status=$2,response=$3,resolution=CASE WHEN $2='resolved' THEN $4 ELSE resolution END,resolved_by_user_id=$5,resolved_at=$6::timestamptz,updated_at=$6::timestamptz WHERE id=$1::uuid AND org_id=$7::uuid AND status='open' RETURNING {}",projection("requests")))
        .bind(request_id).bind(new_status).bind(&response).bind(resolution).bind(&actor.actor().id).bind(&now).bind(&org).fetch_optional(&mut *tx).await?
        .ok_or_else(||http(422,match operation {RequestWriteOperation::Resolve=>"The Assistance Request changed before it could be resolved",RequestWriteOperation::Cancel=>"The Assistance Request changed before it could be cancelled"}))?;
    let updated = serde_json::from_str::<Value>(&updated)?;
    let idempotency_key = format!("{prefix}:{request_id}");
    let mut details = json!({"kind":"assistance","issueId":request["issueId"]});
    if operation == RequestWriteOperation::Resolve {
        details["resolution"] = input["resolution"].clone();
    }
    write_activity_idempotent(
        &mut tx,
        ActivityWrite {
            org: &org,
            audit: &ActivityActor {
                actor_type: "user",
                actor_id: actor.actor().id.clone(),
                run_id: None,
            },
            action: event_type,
            entity_type: "request",
            entity_id: request_id,
            details: Some(&details),
            options: ActivityOptions::default(),
        },
        &idempotency_key,
    )
    .await?;
    let mut run_id = None;
    let mut invocation_error = None;
    let mut wake_queued = false;
    if let Some(agent_id) = wake_agent.as_deref() {
        let agent = agent.as_ref().ok_or_else(|| http(404, "Agent not found"))?;
        let linked = issue.as_mut().expect("wake eligibility requires Issue");
        if linked["status"] == "blocked" {
            sqlx::query("UPDATE issues SET status='in_progress',updated_at=$3::timestamptz WHERE org_id=$1::uuid AND id=$2::uuid")
                .bind(&org).bind(issue_id.as_deref()).bind(&now).execute(&mut *tx).await?;
            linked["status"] = json!("in_progress");
        }
        let wake_payload = json!({"requestId":request_id,"issueId":issue_id,"resolution":resolution,"response":response,"expectedAssigneeAgentId":agent_id,"expectedIssueStatus":linked["status"],"_rudderExecutionProducer":"agent_wakeup_v1"});
        let context = json!({"source":"request.resolved","requestId":request_id,"requestKind":"assistance","requestResolution":resolution,"requestResponse":response,"issueId":issue_id,"taskId":issue_id,"wakeSource":"assignment","wakeReason":"assistance_request_resolved","wakeTriggerDetail":"user","issue":{"id":linked["id"],"title":linked["title"],"description":linked["description"],"status":linked["status"],"priority":linked["priority"]}});
        let wake = AgentWakeRequest {
            organization_id: org.clone(),
            agent_id: agent_id.into(),
            source: "assignment".into(),
            trigger_detail: Some("user".into()),
            reason: Some("assistance_request_resolved".into()),
            payload: Some(wake_payload.clone()),
            idempotency_key: Some(format!("assistance-request:{request_id}:resolved")),
            context_snapshot: context.clone(),
        };
        let admitted = agent_execution::admit_in_transaction(
            &mut tx,
            &AgentExecutionActor {
                actor_type: "user",
                actor_id: actor.actor().id.clone(),
                run_id: None,
            },
            &wake,
            &org,
            agent_id,
            issue_id.as_deref(),
            context,
            &wake_payload,
            agent,
        )
        .await?;
        run_id = admitted.run_id;
        if let Some(block) = admitted.invocation_block {
            invocation_error = Some(AgentExecutionError::Http(
                409,
                block.reason.into(),
                Some(json!({"scopeType":block.scope_type,"scopeId":block.scope_id})),
            ));
        }
        wake_queued = true;
    }
    if let (Some(origin), Some(agent)) = (
        request["originRunId"].as_str(),
        request["assigneeAgentId"].as_str(),
    ) {
        let latency:i64=sqlx::query_scalar("SELECT GREATEST(0,floor(extract(epoch FROM $2::timestamptz)*1000)-floor(extract(epoch FROM created_at)*1000))::bigint FROM requests WHERE id=$1::uuid")
            .bind(request_id).bind(&now).fetch_one(&mut *tx).await?;
        let mut payload = json!({"requestId":request_id,"issueId":request["issueId"],"resolutionLatencyMs":latency});
        if operation == RequestWriteOperation::Resolve {
            payload["resolution"] = input["resolution"].clone();
            payload["wakeIntentQueued"] = json!(wake_queued);
        }
        append_issue_run_event(
            &mut tx,
            &org,
            IssueRunEvent {
                run_id: origin,
                agent_id: agent,
                event_type,
                level: "info",
                message,
                idempotency_key: &idempotency_key,
                payload: &payload,
            },
        )
        .await
        .map_err(|error| match error {
            crate::issue_core_writes::IssueCoreWriteError::Database(error) => {
                RequestWriteError::Database(error)
            }
            _ => http(500, "Internal server error"),
        })?;
    }
    tx.commit().await?;
    if let Some(error) = invocation_error {
        return Err(error.into());
    }
    Ok(with_wake(updated, operation, run_id))
}
fn with_wake(mut request: Value, operation: RequestWriteOperation, run: Option<String>) -> Value {
    if operation == RequestWriteOperation::Resolve {
        request["wakeRunId"] = json!(run);
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validators_preserve_zod_trim_utf16_limits_optional_and_unknown_fields() {
        assert_eq!(
            validate_input(
                RequestWriteOperation::Resolve,
                &json!({"resolution":"answered","response":"\u{feff} ok \u{00a0}","unknown":1})
            )
            .unwrap(),
            json!({"resolution":"answered","response":"ok"})
        );
        assert_eq!(
            validate_input(RequestWriteOperation::Cancel, &json!({"unknown":1})).unwrap(),
            json!({})
        );
        for value in [
            json!({"reason":null}),
            json!({"reason":"   "}),
            json!({"reason":"🦀".repeat(1001)}),
            json!([]),
        ] {
            assert!(matches!(
                validate_input(RequestWriteOperation::Cancel, &value),
                Err(RequestWriteError::Validation(_))
            ));
        }
        assert!(
            validate_input(
                RequestWriteOperation::Cancel,
                &json!({"reason":"🦀".repeat(1000)})
            )
            .is_ok()
        );
    }
    #[test]
    fn resolve_validation_collects_resolution_then_response_zod_issues() {
        let Err(RequestWriteError::Validation(value)) = validate_input(
            RequestWriteOperation::Resolve,
            &json!({"resolution":"invalid","response":null}),
        ) else {
            panic!("invalid body accepted")
        };
        assert_eq!(value[0]["code"], "invalid_enum_value");
        assert_eq!(value[0]["path"], json!(["resolution"]));
        assert_eq!(
            value[1],
            json!({"code":"invalid_type","expected":"string","received":"null","path":["response"],"message":"Expected string, received null"})
        );
    }
}
