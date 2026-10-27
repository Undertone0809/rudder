//! Approval, association and label GET projections. Mutations retain their
//! existing owner; every joined row is scoped to the authorized target org.
use crate::{
    StoreError,
    request_reads::{redaction, timestamp},
};
use serde::Deserialize;
use sqlx::{PgPool, Row};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalReadOperation {
    List,
    Detail,
    Issues,
    IssueApprovals,
    Labels,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApprovalReadInput {
    pub operation: ApprovalReadOperation,
    pub target_id: Option<String>,
    pub status: Option<String>,
    pub legacy_date_timezone: Option<String>,
}
impl ApprovalReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        let list = matches!(
            self.operation,
            ApprovalReadOperation::List | ApprovalReadOperation::Labels
        );
        if list == self.target_id.is_some()
            || (self.operation != ApprovalReadOperation::List && self.status.is_some())
            || self.legacy_date_timezone.as_ref().is_some_and(|zone| {
                zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
            })
        {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApprovalReadError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub(crate) fn projection(table: &str) -> String {
    let fields: &[(&str, &str)] = match table {
        "approvals" => &[
            ("id", "id"),
            ("orgId", "org_id"),
            ("type", "type"),
            ("requestedByAgentId", "requested_by_agent_id"),
            ("requestedByUserId", "requested_by_user_id"),
            ("status", "status"),
            ("payload", "payload"),
            ("decisionNote", "decision_note"),
            ("decidedByUserId", "decided_by_user_id"),
        ],
        "issues" => &[
            ("id", "id"),
            ("orgId", "org_id"),
            ("projectId", "project_id"),
            ("goalId", "goal_id"),
            ("parentId", "parent_id"),
            ("title", "title"),
            ("description", "description"),
            ("status", "status"),
            ("priority", "priority"),
            ("assigneeAgentId", "assignee_agent_id"),
            ("assigneeUserId", "assignee_user_id"),
            ("createdByAgentId", "created_by_agent_id"),
            ("createdByUserId", "created_by_user_id"),
            ("issueNumber", "issue_number"),
            ("identifier", "identifier"),
            ("requestDepth", "request_depth"),
            ("billingCode", "billing_code"),
        ],
        _ => &[
            ("id", "id"),
            ("orgId", "org_id"),
            ("name", "name"),
            ("color", "color"),
        ],
    };
    let mut parts: Vec<String> = fields
        .iter()
        .map(|(key, col)| format!("'{key}',t.{col}"))
        .collect();
    let dates: &[(&str, &str)] = match table {
        "approvals" => &[
            ("decidedAt", "decided_at"),
            ("createdAt", "created_at"),
            ("updatedAt", "updated_at"),
        ],
        "issues" => &[
            ("startedAt", "started_at"),
            ("completedAt", "completed_at"),
            ("cancelledAt", "cancelled_at"),
            ("createdAt", "created_at"),
            ("updatedAt", "updated_at"),
        ],
        _ => &[("createdAt", "created_at"), ("updatedAt", "updated_at")],
    };
    for (key, col) in dates {
        parts.push(format!("'{key}',{}", timestamp(&format!("t.{col}"))));
    }
    format!("jsonb_build_object({})", parts.join(","))
}

fn array(rows: Vec<String>) -> String {
    format!("[{}]", rows.join(","))
}

pub async fn read_approvals(
    pool: &PgPool,
    org: &str,
    input: &ApprovalReadInput,
) -> Result<String, ApprovalReadError> {
    input.validate()?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    if let Some(zone) = &input.legacy_date_timezone {
        sqlx::query("SELECT set_config('TimeZone',$1,true)")
            .bind(zone)
            .execute(&mut *tx)
            .await?;
    }
    let target = input.target_id.as_deref();
    if let Some(id) = target {
        let table = if input.operation == ApprovalReadOperation::IssueApprovals {
            "issues"
        } else {
            "approvals"
        };
        let current_org = sqlx::query_scalar::<_, String>(&format!(
            "SELECT org_id::text FROM {table} WHERE id=$1::uuid"
        ))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::NotFound)?;
        if current_org != org {
            return Err(StoreError::NotFound.into());
        }
    }
    let output = match input.operation {
        ApprovalReadOperation::List | ApprovalReadOperation::Detail => {
            // The legacy Approval list has no ORDER BY. Preserve that contract.
            let query = format!(
                "SELECT {}::text FROM approvals t WHERE t.org_id=$1::uuid AND ($2::uuid IS NULL OR t.id=$2::uuid) AND ($3::text IS NULL OR $3='' OR t.status=$3)",
                projection("approvals")
            );
            let rows = sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .bind(target)
                .bind(input.status.as_deref())
                .fetch_all(&mut *tx)
                .await?;
            let mut values = rows
                .iter()
                .map(|row| redaction::row(row, true))
                .collect::<Result<Vec<_>, _>>()?;
            if input.operation == ApprovalReadOperation::Detail {
                values.pop().ok_or(StoreError::NotFound)?
            } else {
                array(values)
            }
        }
        ApprovalReadOperation::Labels => {
            let query = format!(
                "SELECT {}::text FROM labels t WHERE t.org_id=$1::uuid ORDER BY t.name ASC,t.id ASC",
                projection("labels")
            );
            let rows = sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .fetch_all(&mut *tx)
                .await?;
            array(
                rows.iter()
                    .map(|row| redaction::row(row, false))
                    .collect::<Result<_, _>>()?,
            )
        }
        ApprovalReadOperation::IssueApprovals => {
            let link = format!(
                "jsonb_build_object('issueId',l.issue_id,'approvalId',l.approval_id,'linkedByAgentId',l.linked_by_agent_id,'linkedByUserId',l.linked_by_user_id,'createdAt',{})",
                timestamp("l.created_at")
            );
            let query = format!(
                "SELECT ({} || jsonb_build_object('link',{}))::text FROM issue_approvals l JOIN approvals t ON t.id=l.approval_id WHERE l.issue_id=$2::uuid AND l.org_id=$1::uuid AND t.org_id=$1::uuid ORDER BY l.created_at DESC",
                projection("approvals"),
                link
            );
            let rows = sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .bind(target)
                .fetch_all(&mut *tx)
                .await?;
            // Node's association projection uses redactEventPayload(...) ?? {};
            // the existing row encoder applies exactly that payload boundary.
            array(
                rows.iter()
                    .map(|row| redaction::row(row, true))
                    .collect::<Result<_, _>>()?,
            )
        }
        ApprovalReadOperation::Issues => {
            let query = format!(
                "SELECT t.id::text,{}::text value FROM issue_approvals l JOIN issues t ON t.id=l.issue_id WHERE l.approval_id=$2::uuid AND l.org_id=$1::uuid AND t.org_id=$1::uuid ORDER BY l.created_at DESC",
                projection("issues")
            );
            let rows = sqlx::query(&query)
                .bind(org)
                .bind(target)
                .fetch_all(&mut *tx)
                .await?;
            let ids: Vec<String> = rows
                .iter()
                .map(|row| row.try_get("id"))
                .collect::<Result<_, _>>()?;
            let label_query = format!(
                "SELECT l.issue_id::text,t.id::text,{}::text value FROM issue_labels l JOIN labels t ON t.id=l.label_id WHERE l.issue_id=ANY($2::text[]::uuid[]) AND l.org_id=$1::uuid AND t.org_id=$1::uuid ORDER BY t.name ASC,t.id ASC",
                projection("labels")
            );
            let label_rows = sqlx::query(&label_query)
                .bind(org)
                .bind(&ids)
                .fetch_all(&mut *tx)
                .await?;
            let mut grouped: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
            for label in label_rows {
                let group = grouped.entry(label.try_get("issue_id")?).or_default();
                group.0.push(redaction::row(
                    &label.try_get::<String, _>("value")?,
                    false,
                )?);
                group
                    .1
                    .push(serde_json::to_string(&label.try_get::<String, _>("id")?)?);
            }
            let grouped: HashMap<String, (String, String)> = grouped
                .into_iter()
                .map(|(id, (labels, ids))| (id, (array(labels), array(ids))))
                .collect();
            let empty = (String::from("[]"), String::from("[]"));
            let mut output = Vec::with_capacity(rows.len());
            for row in rows {
                let id: String = row.try_get("id")?;
                let (labels, label_ids) = grouped.get(&id).unwrap_or(&empty);
                let mut value = redaction::row(&row.try_get::<String, _>("value")?, false)?;
                value.pop();
                value.push_str(&format!(
                    ",\"labels\":{},\"labelIds\":{}}}",
                    labels, label_ids
                ));
                output.push(value);
            }
            array(output)
        }
    };
    tx.commit().await?;
    Ok(output)
}
