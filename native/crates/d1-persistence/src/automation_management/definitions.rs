use super::*;
pub(super) async fn references(tx: &mut Tx<'_>, org: &str, input: &Value) -> Result<()> {
    for (key, table, label) in [
        ("projectId", "projects", "Project"),
        ("goalId", "goals", "Goal"),
        ("parentIssueId", "issues", "Parent issue"),
        ("assigneeAgentId", "agents", "Assignee agent"),
    ] {
        let Some(id) = text(input, key) else {
            continue;
        };
        let query =
            format!("SELECT to_jsonb(t)::text FROM {table} t WHERE id=$1::uuid FOR KEY SHARE");
        let row = sqlx::query_scalar::<_, String>(&query)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| http(404, format!("{label} not found")))?;
        let row: Value = serde_json::from_str(&row)?;
        if row["org_id"] != org {
            return Err(http(
                422,
                if key == "assigneeAgentId" {
                    "Assignee must belong to same organization".to_owned()
                } else {
                    format!("{label} must belong to same organization")
                },
            ));
        }
        if key == "assigneeAgentId" {
            match row["status"].as_str() {
                Some("pending_approval") => {
                    return Err(http(
                        409,
                        "Cannot assign automations to pending approval agents",
                    ));
                }
                Some("terminated") => {
                    return Err(http(409, "Cannot assign automations to terminated agents"));
                }
                _ => (),
            }
        }
    }
    Ok(())
}
fn notification(value: &mut Value, old: Option<&Value>, actor: &Actor<'_>, patch: &Value) {
    if value["outputMode"] != "track_issue" {
        value["notifyOnIssueCreated"] = json!(false);
        value["notifyOnIssueCreatedUserId"] = Value::Null;
        return;
    }
    let enabled = value["notifyOnIssueCreated"] == true;
    let user = if patch["notifyOnIssueCreated"] == true {
        (actor.kind == "user")
            .then_some(actor.id)
            .or_else(|| old.and_then(|v| text(v, "notifyOnIssueCreatedUserId")))
    } else {
        old.and_then(|v| text(v, "notifyOnIssueCreatedUserId"))
    };
    value["notifyOnIssueCreated"] = json!(enabled && user.is_some());
    value["notifyOnIssueCreatedUserId"] = json!(if enabled { user } else { None });
}
pub(super) async fn create(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    input: &Value,
) -> Result<Value> {
    references(tx, org, input).await?;
    let mut value = input.clone();
    notification(&mut value, None, actor, input);
    value["chatConversationId"] = Value::Null;
    value
        .as_object_mut()
        .unwrap()
        .extend(actor_fields(actor, true).as_object().unwrap().clone());
    let id = projection::write(tx, org, None, false, &value).await?;
    let row = projection::automation(tx, &id, false)
        .await?
        .ok_or_else(|| http(500, "Internal server error"))?;
    audit(
        tx,
        org,
        actor,
        "automation.created",
        "automation",
        &id,
        json!({"title":row["title"],"assigneeAgentId":row["assigneeAgentId"]}),
    )
    .await?;
    Ok(row)
}
pub(super) async fn update(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    old: &Value,
    input: &Value,
) -> Result<Value> {
    let mut checked_references = input.clone();
    // Legacy revalidates the resulting Project even when PATCH leaves it
    // unchanged; Goal/parent/assignee validation remains patch-specific.
    if checked_references.get("projectId").is_none() {
        checked_references["projectId"] = old["projectId"].clone();
    }
    references(tx, org, &checked_references).await?;
    let mut value = old.clone();
    value
        .as_object_mut()
        .unwrap()
        .extend(input.as_object().unwrap().clone());
    if input
        .get("assigneeAgentId")
        .is_some_and(|v| v != &old["assigneeAgentId"])
        && input.get("assigneeAgentRuntimeOverrides").is_none()
    {
        value["assigneeAgentRuntimeOverrides"] = Value::Null;
    }
    value["chatConversationId"] = Value::Null;
    notification(&mut value, Some(old), actor, input);
    // Only definition fields are writable; scheduler-owned touched state is not
    // copied back from the pre-lock projection.
    let keys = [
        "projectId",
        "goalId",
        "parentIssueId",
        "title",
        "description",
        "assigneeAgentId",
        "assigneeAgentRuntimeOverrides",
        "outputMode",
        "chatConversationId",
        "notifyOnIssueCreated",
        "notifyOnIssueCreatedUserId",
        "priority",
        "status",
        "concurrencyPolicy",
        "catchUpPolicy",
    ];
    let mut patch = Value::Object(
        keys.into_iter()
            .map(|key| (key.to_owned(), value[key].clone()))
            .collect(),
    );
    patch
        .as_object_mut()
        .unwrap()
        .extend(actor_fields(actor, false).as_object().unwrap().clone());
    patch["updatedAt"] = json!(schedule::stamp(now_ms())?);
    let id = text(old, "id").unwrap();
    projection::write(tx, org, Some(id), false, &patch).await?;
    // Legacy definition PATCH emits no activity; preserve that contract.
    projection::automation(tx, id, false)
        .await?
        .ok_or_else(|| http(404, "Automation not found"))
}
pub(super) async fn delete(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    old: &Value,
) -> Result<()> {
    let id = text(old, "id").unwrap();
    sqlx::query("DELETE FROM organization_secrets WHERE org_id=$1::uuid AND id IN (SELECT secret_id FROM automation_triggers WHERE automation_id=$2::uuid AND org_id=$1::uuid AND secret_id IS NOT NULL)").bind(org).bind(id).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM automations WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(id)
        .bind(org)
        .execute(&mut **tx)
        .await?;
    audit(
        tx,
        org,
        actor,
        "automation.deleted",
        "automation",
        id,
        json!({"title":old["title"]}),
    )
    .await
}
