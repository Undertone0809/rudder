use super::*;
use sha2::{Digest, Sha256};

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

async fn conversation(
    tx: &mut Tx<'_>,
    approval: &LockedApproval,
) -> Result<(String, Option<String>)> {
    let id = uuid(
        text(&approval.value()["payload"], "chatConversationId")
            .ok_or_else(|| http(422, "Chat approval missing chatConversationId"))?,
    )?;
    let primary=sqlx::query_scalar::<_,Option<String>>("SELECT primary_issue_id::text FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE").bind(approval.organization_id()).bind(&id).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Conversation not found"))?;
    Ok((id, primary))
}

pub(super) async fn create_issue(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
    staged_assets: &mut Vec<String>,
) -> Result<()> {
    let org = approval.organization_id();
    let payload = &approval.value()["payload"];
    let (conversation, primary) = conversation(tx, approval).await?;
    let mut proposed = payload
        .get("proposedIssue")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| http(422, "Issue proposal payload was incomplete"))?;
    let has_owner =
        text(&proposed, "assigneeAgentId").is_some() || text(&proposed, "assigneeUserId").is_some();
    let reason = text(&proposed, "assigneeUnassignedReason").is_some();
    if has_owner && reason {
        return Err(http(
            422,
            "Issue proposals with an owner must not also include assigneeUnassignedReason",
        ));
    }
    if !has_owner && !reason {
        return Err(http(
            422,
            "Issue proposals without an owner must include assigneeUnassignedReason",
        ));
    }
    if [
        "assigneeAgentId",
        "assigneeUserId",
        "reviewerAgentId",
        "reviewerUserId",
    ]
    .iter()
    .any(|key| text(&proposed, key).is_some())
    {
        let local = context.actor.session_id() == "local-implicit"
            && context.user_id() == Some("local-board")
            && context.agent_host.local_implicit;
        let allowed=local || sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$2 AND role='instance_admin') OR EXISTS(SELECT 1 FROM organization_memberships m JOIN principal_permission_grants g USING(org_id,principal_type,principal_id) WHERE m.org_id=$1::uuid AND m.principal_type='user' AND m.principal_id=$2 AND m.status='active' AND g.permission_key='tasks:assign')").bind(org).bind(context.user_id()).fetch_one(&mut **tx).await?;
        if !allowed {
            return Err(http(403, "Missing permission: tasks:assign"));
        }
    }
    if let Some(agent) = text(payload, "proposedByAgentId") {
        scoped_agent(tx, org, &uuid(agent)?).await?;
        labels(tx, org, &proposed).await?;
    }
    if let Some(note) = text(approval.value(), "decisionNote") {
        let body = proposed["description"].as_str().unwrap_or_default();
        proposed["description"] = json!(format!(
            "{}\n\n## Approval feedback\n\n{note}",
            body.trim_end()
        ));
    }
    let source_message = if let Some(id) = text(payload, "chatMessageId") {
        sqlx::query_scalar::<_,String>("SELECT id::text FROM chat_messages WHERE id=$1::uuid AND org_id=$2::uuid AND conversation_id=$3::uuid").bind(uuid(id)?).bind(org).bind(&conversation).fetch_optional(&mut **tx).await?
    } else {
        None
    };
    let issue = if let Some(id) = primary {
        let raw = sqlx::query_scalar::<_, String>(
            "SELECT to_jsonb(i)::text FROM issues i WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(&id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(raw) = raw {
            crate::issue_checkout::project_issue(tx, &raw)
                .await
                .map_err(|e| http(500, e.to_string()))?
        } else {
            new_issue(tx, context, approval, &proposed, staged_assets).await?
        }
    } else {
        new_issue(tx, context, approval, &proposed, staged_assets).await?
    };
    let issue_id = issue["id"]
        .as_str()
        .ok_or_else(|| http(500, "Invalid Issue result"))?;
    mark_chat_write(tx).await?;
    sqlx::query("UPDATE chat_conversations SET primary_issue_id=$3::uuid,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid").bind(org).bind(&conversation).bind(issue_id).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO chat_context_links (org_id,conversation_id,entity_type,entity_id,metadata) VALUES ($1::uuid,$2::uuid,'issue',$3,$4::jsonb) ON CONFLICT DO NOTHING").bind(org).bind(&conversation).bind(issue_id).bind(source_message.as_ref().map(|id|json!({"sourceMessageId":id}).to_string())).execute(&mut **tx).await?;
    link_issue(tx, context, org, approval.id(), issue_id).await?;
    system_message(tx,approval,&conversation,&format!("Created issue {} from this chat conversation.",issue["identifier"].as_str().unwrap_or(issue_id)),json!({"eventType":"issue_created","issueId":issue_id,"issueIdentifier":issue["identifier"],"approvalId":approval.id()}),"issue-created").await?;
    if let Some(note) = text(approval.value(), "decisionNote") {
        system_message(tx,approval,&conversation,&format!("Approved with execution feedback:\n\n{note}"),json!({"eventType":"approval_feedback","approvalId":approval.id(),"issueId":issue_id,"issueIdentifier":issue["identifier"],"decisionNote":note}),"feedback").await?;
    }
    audit(
        tx,
        context,
        org,
        "chat.issue_converted",
        "chat",
        &conversation,
        json!({"issueId":issue_id,"issueIdentifier":issue["identifier"],"approvalId":approval.id(),"source":"approval"}),
        None,
    )
    .await?;
    if let Some(agent) = issue["assigneeAgentId"].as_str() {
        wake_best_effort(tx,context,approval,agent,"assignment","issue_assigned",json!({"issueId":issue_id,"mutation":"chat_approval_approved"}),json!({"issueId":issue_id,"issue":issue,"source":"chat.approval_approved","wakeReason":"issue_assigned"}),"chat.issue_assignee_wakeup").await?;
    }
    Ok(())
}

async fn new_issue(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
    source: &Value,
    staged_assets: &mut Vec<String>,
) -> Result<Value> {
    let source = source
        .get("issueProposal")
        .filter(|v| v.is_object())
        .unwrap_or(source);
    let title =
        text(source, "title").ok_or_else(|| http(422, "Issue proposal payload was incomplete"))?;
    let description = text(source, "description")
        .ok_or_else(|| http(422, "Issue proposal payload was incomplete"))?;
    let mut input = json!({"title":title,"description":description,
        "status":source["status"].as_str().filter(|s|matches!(*s,"backlog"|"todo"|"in_progress"|"in_review"|"blocked"|"done"|"cancelled")).unwrap_or("todo"),
        "priority":source["priority"].as_str().filter(|s|matches!(*s,"urgent"|"high"|"medium"|"low"|"none")).unwrap_or("medium")});
    for key in [
        "projectId",
        "goalId",
        "parentId",
        "assigneeAgentId",
        "assigneeUserId",
        "reviewerAgentId",
        "reviewerUserId",
    ] {
        input[key] = json!(text(source, key));
    }
    if let Some(labels) = source["labelIds"].as_array() {
        input["labelIds"] = json!(
            labels
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .collect::<Vec<_>>()
        );
    }
    let value = crate::issue_core_writes::create_approved_chat_issue(
        tx,
        approval,
        &context.actor.actor().id,
        &input,
        context.asset_storage,
        staged_assets,
    )
    .await?;
    Ok(value)
}

async fn labels(tx: &mut Tx<'_>, org: &str, proposal: &Value) -> Result<()> {
    let ids = proposal["labelIds"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    if !ids.is_empty() {
        for id in &ids {
            uuid(id)?;
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM labels WHERE org_id=$1::uuid AND id::text=ANY($2::text[])",
        )
        .bind(org)
        .bind(ids.into_iter().collect::<Vec<_>>())
        .fetch_one(&mut **tx)
        .await?;
        if count
            != proposal["labelIds"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                })
                .unwrap_or(0) as i64
        {
            return Err(http(
                422,
                "One or more labels are invalid for this organization",
            ));
        }
        return Ok(());
    }
    if let Some(parent) = text(proposal, "parentId") {
        let inherited=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM issue_labels l JOIN issues i ON i.id=l.issue_id AND i.org_id=l.org_id WHERE l.org_id=$1::uuid AND l.issue_id=$2::uuid)").bind(org).bind(uuid(parent)?).fetch_one(&mut **tx).await?;
        if inherited {
            return Ok(());
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM labels WHERE org_id=$1::uuid")
        .bind(org)
        .fetch_one(&mut **tx)
        .await?;
    if count >= 5 {
        return Err(ApprovalWriteError::Http(
            422,
            format!("当前组织有 {count} 个 labels，agent 创建 issue 需要选择至少一个 label"),
            Some(json!({"code":"agent_issue_label_required","labelCount":count})),
        ));
    }
    Ok(())
}

pub(super) async fn operation(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
) -> Result<()> {
    let payload = &approval.value()["payload"];
    let proposal = payload
        .get("operationProposal")
        .filter(|v| v.is_object())
        .unwrap_or(payload);
    let target = text(proposal, "targetId")
        .ok_or_else(|| http(422, "Chat operation proposal payload was incomplete"))?;
    let summary = text(proposal, "summary")
        .ok_or_else(|| http(422, "Chat operation proposal payload was incomplete"))?;
    let patch = proposal
        .get("patch")
        .filter(|v| v.is_object())
        .ok_or_else(|| http(422, "Chat operation proposal payload was incomplete"))?;
    let kind = proposal["targetType"]
        .as_str()
        .filter(|kind| matches!(*kind, "agent" | "organization"))
        .ok_or_else(|| http(422, "Chat operation proposal payload was incomplete"))?;
    let (conversation, _) = conversation(tx, approval).await?;
    if kind == "organization" {
        if uuid(target)? != approval.organization_id() {
            return Err(http(
                422,
                "Organization approvals can only update the same organization",
            ));
        }
        let branding = patch.get("brandColor").is_some() || patch.get("logoAssetId").is_some();
        if branding
            && patch.as_object().is_some_and(|patch| {
                patch
                    .keys()
                    .any(|key| !matches!(key.as_str(), "brandColor" | "logoAssetId"))
            })
        {
            return Err(http(
                422,
                "Rust-owned Chat branding changes cannot be combined with other organization fields",
            ));
        }
        let key = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "rudder.chat-approval.organization-branding.v1\0{}",
                    approval.id()
                )
                .as_bytes()
            )
        );
        crate::organization_mutations::patch_in_transaction(
            tx,
            crate::organization_mutations::OrganizationPatchCommand {
                organization_id: approval.organization_id(),
                body: patch,
                branding_route: branding,
                actor_kind: "board",
                actor_id: &context.actor.actor().id,
                agent_id: None,
                run_id: context.run_id,
                idempotency_key: Some(&key),
                authorizer: context.authorizer,
            },
        )
        .await?;
        if branding {
            audit(
                tx,
                context,
                approval.organization_id(),
                "organization.updated",
                "organization",
                target,
                patch.clone(),
                Some(&format!(
                    "chat-approval:{}:organization-activity",
                    approval.id()
                )),
            )
            .await?;
        }
    } else {
        scoped_agent(tx, approval.organization_id(), &uuid(target)?).await?;
    }
    system_message(tx,approval,&conversation,&format!("Applied approved {kind} change: {summary}."),json!({"eventType":"operation_applied","approvalId":approval.id(),"targetType":kind,"targetId":target}),if kind=="organization" {"organization-applied"} else {"agent-applied"}).await?;
    Ok(())
}

async fn mark_chat_write(tx: &mut Tx<'_>) -> Result<()> {
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:approval',true)")
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn system_message(
    tx: &mut Tx<'_>,
    approval: &LockedApproval,
    conversation: &str,
    body: &str,
    payload: Value,
    suffix: &str,
) -> Result<()> {
    mark_chat_write(tx).await?;
    let inserted:Option<String>=sqlx::query_scalar("INSERT INTO chat_messages (org_id,conversation_id,role,kind,status,body,structured_payload,client_mutation_id) VALUES ($1::uuid,$2::uuid,'system','system_event','completed',$3,$4::jsonb,$5) ON CONFLICT (conversation_id,client_mutation_id) WHERE client_mutation_id IS NOT NULL DO NOTHING RETURNING created_at::text")
        .bind(approval.organization_id()).bind(conversation).bind(body).bind(payload.to_string()).bind(format!("chat-approval:{}:{suffix}",approval.id())).fetch_optional(&mut **tx).await?;
    if let Some(at) = inserted {
        sqlx::query("UPDATE chat_conversations SET last_message_at=$3::timestamptz,updated_at=$3::timestamptz WHERE org_id=$1::uuid AND id=$2::uuid").bind(approval.organization_id()).bind(conversation).bind(at).execute(&mut **tx).await?;
    } else {
        let matches:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND client_mutation_id=$3 AND role='system' AND kind='system_event' AND status='completed' AND body=$4 AND structured_payload=$5::jsonb AND approval_id IS NULL AND run_id IS NULL AND replying_agent_id IS NULL)")
            .bind(approval.organization_id()).bind(conversation).bind(format!("chat-approval:{}:{suffix}",approval.id())).bind(body).bind(payload.to_string()).fetch_one(&mut **tx).await?;
        if !matches {
            return Err(http(
                409,
                "Chat message idempotency key was reused with different content",
            ));
        }
    }
    Ok(())
}
