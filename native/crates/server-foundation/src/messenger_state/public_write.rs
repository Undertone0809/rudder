//! Public identity enters the same state writer, without minting a private
//! actor envelope or making any Node transport request.
use super::{
    protocol::{Command, Request},
    store::*,
    titles,
};
use actix_web::{HttpResponse, http::StatusCode};
use rudder_d1_persistence::{
    agent_core::NativeAgentAuthorizer,
    messenger_reads::{self, Read},
};
use rudder_native_chat_executor::HostPaths;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
pub(crate) async fn execute(
    pool: &sqlx::PgPool,
    org: &str,
    user: &str,
    mut command: Value,
    auth: &dyn NativeAgentAuthorizer,
    paths: Option<&HostPaths>,
) -> HttpResponse {
    let audit = titles::host_audit();
    let s = Scope {
        org,
        user,
        audit: &audit,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = CancelOnDrop(cancelled.clone());
    let op = command["operation"].as_str().unwrap_or("").to_owned();
    if op == "retired" {
        let result = async {
            let mut tx = pool.begin().await?;
            revalidate(&mut tx, &s, Some(auth)).await?;
            tx.commit().await?;
            Ok::<_, Error>(())
        }
        .await;
        return match result{Ok(())=>HttpResponse::Conflict().json(json!({"error":"Ungrouped Saved Views are no longer supported; use POST /api/orgs/:orgId/messenger/saved-views/keep with a group or anchor placement"})),Err(error)=>super::error_response(error)};
    }
    if op == "groupRegenerate" || op == "groupMerge" && command["autoGenerateName"] == true {
        let keys = command["itemKeys"].as_array().map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
        let result = titles::generate(
            pool,
            &s,
            keys.as_deref(),
            if op == "groupRegenerate" {
                command["groupId"].as_str()
            } else {
                None
            },
            auth,
            paths,
            cancelled,
        )
        .await;
        match (op.as_str(), result) {
            ("groupRegenerate", Ok(Some(title))) => {
                command = json!({"operation":"groupUpdate","groupId":command["groupId"],"patch":{"name":title}})
            }
            ("groupRegenerate", Ok(None)) => return HttpResponse::UnprocessableEntity().json(
                json!({"error":"Fast Intelligence did not return a usable Messenger group title"}),
            ),
            ("groupRegenerate", Err((status, message))) => {
                return HttpResponse::build(
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                )
                .json(json!({"error":message}));
            }
            (_, Ok(Some(title))) => command["name"] = json!(title),
            _ => (), // Existing optional merge auto-name deliberately falls back to name.
        }
    }
    command.as_object_mut().unwrap().remove("autoGenerateName");
    let input = match serde_json::from_value::<Request>(
        json!({"input":command,"auditContext":{"userNames":[],"homeDirs":[]}}),
    ) {
        Ok(input) if input.validate() => input,
        _ => return HttpResponse::BadRequest().json(json!({"error":"Validation error"})),
    };
    let status = if matches!(
        input.input,
        Command::SavedViewKeep { .. }
            | Command::GroupCreate { .. }
            | Command::GroupMerge { .. }
            | Command::GroupEntryAssign { .. }
            | Command::IssueFollow { .. }
    ) {
        201
    } else {
        200
    };
    let hydrate = matches!(
        input.input,
        Command::GroupMerge { .. }
            | Command::GroupReorder { .. }
            | Command::GroupEntryReorder { .. }
    );
    match mutate_authorized(pool, &s, &input.input, Some(auth)).await {
        Ok(body) => {
            if hydrate {
                return match messenger_reads::read(pool, org, user, &locale(), &Read::Groups, auth)
                    .await
                {
                    Ok(groups) => {
                        HttpResponse::build(StatusCode::from_u16(status).unwrap()).json(groups)
                    }
                    Err(error) => super::error_response(Error::Snapshot(error)),
                };
            }
            HttpResponse::build(StatusCode::from_u16(status).unwrap())
                .content_type("application/json; charset=utf-8")
                .body(body)
        }
        Err(error) => super::error_response(error),
    }
}
