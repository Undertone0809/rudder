//! Native Browser/Computer action policy, durable intent and result routing.
//! Desktop remains the authenticated loopback executor for UI primitives.
use crate::{
    desktop_broker::{BrokerError, DesktopBroker, Kind},
    desktop_validation,
    native_agent_jwt::NativeAgentJwtIdentity,
};
use rudder_d1_persistence::desktop_capability::{self as persistence, DesktopActivity};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

pub(crate) struct Error {
    pub status: u16,
    pub code: String,
    pub message: String,
}
impl Error {
    fn new(kind: Kind, status: u16, suffix: &str, message: &str) -> Self {
        Self {
            status,
            code: format!("{}_{suffix}", prefix(kind)),
            message: message.into(),
        }
    }
    fn storage() -> Self {
        Self {
            status: 500,
            code: "internal_error".into(),
            message: "Internal server error".into(),
        }
    }
}
fn prefix(kind: Kind) -> &'static str {
    match kind {
        Kind::Browser => "browser",
        Kind::Computer => "computer",
    }
}
fn broker_error(error: BrokerError) -> Error {
    let status = match error.code.as_str() {
        "browser_unavailable" | "computer_unavailable" => 503,
        "browser_disabled"
        | "computer_disabled"
        | "computer_run_inactive"
        | "computer_permission_required" => 409,
        "browser_tab_limit" => 429,
        "browser_timeout" | "computer_timeout" => 504,
        "browser_result_too_large" | "computer_result_too_large" => 413,
        "browser_tab_forbidden" => 403,
        "browser_tab_not_found"
        | "browser_ref_not_found"
        | "computer_stale_observation"
        | "computer_target_not_found" => 404,
        "browser_invalid_argument" | "browser_unsafe_url" => 422,
        "computer_invalid_argument" => 400,
        _ => 502,
    };
    Error {
        status,
        code: error.code,
        message: error.message,
    }
}
pub(crate) async fn settings(pool: &PgPool, kind: Kind) -> Result<bool, Error> {
    let row =
        sqlx::query("SELECT browser,general FROM instance_settings WHERE singleton_key='default'")
            .fetch_optional(pool)
            .await
            .map_err(|_| Error::storage())?;
    let Some(row) = row else {
        return Ok(kind == Kind::Browser);
    };
    let value: Value = row
        .try_get(match kind {
            Kind::Browser => "browser",
            Kind::Computer => "general",
        })
        .map_err(|_| Error::storage())?;
    Ok(match kind {
        Kind::Browser => value["enabled"] != false,
        Kind::Computer => value["experimentalComputerUseEnabled"] == true,
    })
}
async fn check_run(
    pool: &PgPool,
    kind: Kind,
    identity: &NativeAgentJwtIdentity,
) -> Result<(), Error> {
    let row=sqlx::query("SELECT org_id::text AS org_id,agent_id::text AS agent_id,status FROM heartbeat_runs WHERE id=$1::uuid").bind(&identity.run_id).fetch_optional(pool).await.map_err(|_|Error::storage())?;
    let allowed = row.as_ref().is_some_and(|row| {
        row.try_get::<String, _>("org_id").ok().as_deref() == Some(identity.org_id.as_str())
            && row.try_get::<String, _>("agent_id").ok().as_deref()
                == Some(identity.agent_id.as_str())
    });
    if !allowed {
        return Err(Error::new(
            kind,
            403,
            "run_forbidden",
            match kind {
                Kind::Browser => "The current run does not own this Browser session.",
                Kind::Computer => "The current run does not own this Computer Use session.",
            },
        ));
    }
    if row
        .as_ref()
        .and_then(|row| row.try_get::<String, _>("status").ok())
        .as_deref()
        != Some("running")
    {
        return Err(Error::new(
            kind,
            409,
            "run_inactive",
            "The current run is no longer active.",
        ));
    }
    Ok(())
}
fn runtime_supported(kind: Kind, runtime: &str) -> bool {
    match kind {
        Kind::Browser => matches!(
            runtime,
            "claude_local" | "codex_local" | "opencode_local" | "pi_local"
        ),
        Kind::Computer => runtime == "codex_local",
    }
}
fn target_metadata(args: &Value, result: &Value) -> Value {
    let mut details = json!({});
    for key in ["pid", "windowId"] {
        if let Some(value) = args
            .get(key)
            .or_else(|| result.get(key))
            .filter(|v| v.is_number())
        {
            details[key] = value.clone();
        }
    }
    for key in ["observationId", "effect"] {
        if let Some(value) = args
            .get(key)
            .or_else(|| result.get(key))
            .and_then(Value::as_str)
        {
            details[key] = json!(if key == "effect" {
                value.chars().take(80).collect::<String>()
            } else {
                value.to_owned()
            });
        }
    }
    details
}
fn origin(value: &Value) -> Option<String> {
    let url = url::Url::parse(value.as_str()?).ok()?;
    Some(url.origin().ascii_serialization())
}
async fn record(
    pool: &PgPool,
    kind: Kind,
    identity: &NativeAgentJwtIdentity,
    action: &str,
    status: &str,
    args: &Value,
    result: &Value,
    code: Option<&str>,
) -> Result<(), Error> {
    let event = format!(
        "agent.{}.{action}{}",
        prefix(kind),
        if status == "completed" {
            String::new()
        } else {
            format!(".{status}")
        }
    );
    let (entity_type, entity_id, extra) = match kind {
        Kind::Browser => {
            let id = args["tabId"]
                .as_str()
                .or_else(|| result["tabId"].as_str())
                .unwrap_or(&identity.run_id);
            let mut extra = json!({});
            if let Some(origin) = origin(&args["url"]).or_else(|| origin(&result["url"])) {
                extra["origin"] = json!(origin);
            }
            ("browser_tab", id.to_owned(), extra)
        }
        Kind::Computer => (
            "agent_run",
            identity.run_id.clone(),
            target_metadata(args, result),
        ),
    };
    let mut details = json!({"action":action,"status":status});
    if let Some(extra) = extra.as_object() {
        for (key, value) in extra {
            details[key] = value.clone();
        }
    }
    if let Some(code) = code {
        details["code"] = json!(code);
    }
    persistence::record_action(
        pool,
        &DesktopActivity {
            organization_id: &identity.org_id,
            agent_id: &identity.agent_id,
            run_id: &identity.run_id,
            action: &event,
            entity_type,
            entity_id: &entity_id,
            details: &details,
        },
    )
    .await
    .map_err(|_| Error::storage())?;
    Ok(())
}
pub(crate) async fn action(
    pool: &PgPool,
    broker: &DesktopBroker,
    kind: Kind,
    deployment: &str,
    identity: &NativeAgentJwtIdentity,
    action: &str,
    input: &Value,
) -> Result<Option<Value>, Error> {
    if deployment != "local_trusted" {
        return Err(Error::new(
            kind,
            403,
            "runtime_unsupported",
            match kind {
                Kind::Browser => "Rudder Browser tools are available only in local_trusted mode.",
                Kind::Computer => "Computer Use is available only in local_trusted mode.",
            },
        ));
    }
    let liveness = kind == Kind::Browser && action == "liveness";
    if !liveness && !desktop_validation::known_action(kind, action) {
        return Err(Error::new(
            kind,
            404,
            "action_not_found",
            match kind {
                Kind::Browser => "Unknown Rudder Browser action.",
                Kind::Computer => "Unknown Computer Use action.",
            },
        ));
    }
    let args = if liveness {
        json!({})
    } else {
        desktop_validation::normalize(kind, action, input).map_err(|_| {
            Error::new(
                kind,
                400,
                "invalid_argument",
                match kind {
                    Kind::Browser => "Rudder Browser arguments are invalid.",
                    Kind::Computer => "Computer Use arguments are invalid.",
                },
            )
        })?
    };
    if !settings(pool, kind).await? {
        return Err(Error::new(
            kind,
            409,
            "disabled",
            match kind {
                Kind::Browser => "Rudder Browser is disabled in Settings.",
                Kind::Computer => "Computer Use is disabled in Experimental Settings.",
            },
        ));
    }
    if !runtime_supported(kind, &identity.adapter_type) {
        return Err(Error::new(
            kind,
            403,
            "runtime_unsupported",
            match kind {
                Kind::Browser => "The current Agent runtime does not support Rudder Browser tools.",
                Kind::Computer => "The current Agent runtime does not support Computer Use.",
            },
        ));
    }
    if !liveness && !broker.is_available() {
        return Err(Error::new(
            kind,
            503,
            "unavailable",
            match kind {
                Kind::Browser => "Rudder Browser is unavailable because Desktop is not connected.",
                Kind::Computer => {
                    "Computer Use is unavailable because Rudder Desktop is not ready."
                }
            },
        ));
    }
    check_run(pool, kind, identity).await?;
    if liveness {
        return Ok(None);
    }
    record(
        pool,
        kind,
        identity,
        action,
        "requested",
        &args,
        &Value::Null,
        None,
    )
    .await?;
    let command = json!({"identity":{"orgId":identity.org_id,"agentId":identity.agent_id,"runId":identity.run_id},"action":action,"args":args});
    match broker.forward(&command).await {
        Ok(result) => {
            if record(
                pool,
                kind,
                identity,
                action,
                "completed",
                &args,
                &result,
                None,
            )
            .await
            .is_err()
            {
                tracing::warn!(event="desktop_action_completion_receipt_failed",action,run_id=%identity.run_id);
            }
            Ok(Some(result))
        }
        Err(error) => {
            if record(
                pool,
                kind,
                identity,
                action,
                "failed",
                &args,
                &Value::Null,
                Some(&error.code),
            )
            .await
            .is_err()
            {
                tracing::warn!(event="desktop_action_failure_receipt_failed",action,run_id=%identity.run_id);
            }
            Err(broker_error(error))
        }
    }
}
