//! Automation GET authority. Mutation, trigger and coalescing services keep their owners.
mod projection;
use crate::{
    StoreError,
    activity_reads::{JsString, legacy_date_text, legacy_stamp},
    legacy_read_json::normalize_legacy_read_json,
};
use projection::{Object, array, encode, projection, record, text};
use serde::Deserialize;
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationReadOperation {
    List,
    Detail,
    Runs,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AutomationReadInput {
    pub operation: AutomationReadOperation,
    pub automation_id: Option<String>,
    pub limit: Option<f64>,
    pub legacy_date_timezone: Option<String>,
}
impl AutomationReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if (self.operation != AutomationReadOperation::List && self.automation_id.is_none())
            || self.limit.is_some_and(|value| !value.is_finite())
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
pub enum AutomationReadError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
fn id(row: &Object) -> Result<String, StoreError> {
    text(row, "id")?.ok_or(StoreError::InvalidReceipt)
}
fn retain(row: &Object, fields: &[&str]) -> Object {
    fields
        .iter()
        .filter_map(|key| {
            row.get(&JsString::from(*key))
                .map(|value| (JsString::from(*key), value.clone()))
        })
        .collect()
}
fn run_projection() -> String {
    let base = projection("automationRuns", "r");
    let updated = legacy_date_text(&legacy_stamp("coalesce(i.updated_at,r.updated_at)"));
    let chat_date = legacy_date_text(&legacy_stamp("c.last_message_at"));
    format!(
        r#"({base}) || jsonb_build_object(
      'linkedIssue',CASE WHEN r.linked_issue_id IS NULL THEN NULL ELSE jsonb_build_object('id',r.linked_issue_id,
        'identifier',i.identifier,'title',coalesce(i.title,'Automation execution'),'status',coalesce(i.status,'todo'),
        'priority',coalesce(i.priority,'medium'),'updatedAt',{updated}) END,
      'linkedChatConversation',CASE WHEN r.linked_chat_conversation_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id',r.linked_chat_conversation_id,'title',coalesce(c.title,'Chat'),'status',coalesce(c.status,'active'),
        'preferredAgentId',c.preferred_agent_id,'lastMessageAt',{chat_date}) END,
      'trigger',CASE WHEN r.trigger_id IS NULL THEN NULL ELSE jsonb_build_object('id',r.trigger_id,'kind',t.kind,'label',t.label) END)"#
    )
}
const RUN_JOINS: &str = "LEFT JOIN automation_triggers t ON t.id=r.trigger_id AND t.org_id=r.org_id LEFT JOIN issues i ON i.id=r.linked_issue_id AND i.org_id=r.org_id LEFT JOIN chat_conversations c ON c.id=r.linked_chat_conversation_id AND c.org_id=r.org_id AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$3::text)";
async fn runs(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    automation: &str,
    owner: Option<&str>,
    limit: f64,
) -> Result<String, AutomationReadError> {
    let rows=sqlx::query_scalar::<_,String>(&format!("SELECT ({})::text FROM automation_runs r {RUN_JOINS} WHERE r.org_id=$1::uuid AND r.automation_id=$2::uuid ORDER BY r.created_at DESC LIMIT $4::text::bigint",run_projection()))
        .bind(org).bind(automation).bind(owner).bind(limit.clamp(1.0,200.0).to_string()).fetch_all(&mut **tx).await?;
    Ok(array(
        rows.into_iter()
            .map(|raw| record("automationRuns", &raw).map(encode))
            .collect::<Result<_, _>>()?,
    ))
}
async fn active_issues(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    ids: &[String],
) -> Result<BTreeMap<String, Object>, AutomationReadError> {
    let mut found = BTreeMap::new();
    for direct in [true, false] {
        let remaining = ids
            .iter()
            .filter(|id| !found.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>();
        if remaining.is_empty() {
            break;
        }
        // The same-org fence applies only to these admitted reads. The legacy
        // mutation/coalescing helper is intentionally untouched.
        let link = if direct {
            "h.id=i.execution_run_id AND h.org_id=i.org_id"
        } else {
            "h.org_id=i.org_id AND h.context_snapshot->>'issueId'=i.id::text"
        };
        let rows=sqlx::query(&format!("SELECT DISTINCT ON (i.origin_id) i.origin_id, ({})::text payload FROM issues i INNER JOIN heartbeat_runs h ON {link} AND h.status IN ('queued','running') WHERE i.org_id=$1::uuid AND i.origin_kind='automation_execution' AND i.origin_id=ANY($2::text[]) AND i.status IN ('backlog','todo','in_progress','in_review','blocked') AND i.hidden_at IS NULL ORDER BY i.origin_id,i.updated_at DESC,i.created_at DESC",projection("issues","i")))
            .bind(org).bind(&remaining).fetch_all(&mut **tx).await?;
        for row in rows {
            found.insert(
                row.try_get::<String, _>("origin_id")?,
                record("issues", &row.try_get::<String, _>("payload")?)?,
            );
        }
    }
    Ok(found)
}
async fn list(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    owner: Option<&str>,
) -> Result<String, AutomationReadError> {
    let rows=sqlx::query_scalar::<_,String>(&format!("SELECT ({})::text FROM automations r WHERE r.org_id=$1::uuid AND r.status<>'archived' ORDER BY r.updated_at DESC,r.title ASC",projection("automations","r")))
        .bind(org).fetch_all(&mut **tx).await?;
    let rows = rows
        .into_iter()
        .map(|raw| record("automations", &raw))
        .collect::<Result<Vec<_>, _>>()?;
    let ids = rows.iter().map(id).collect::<Result<Vec<_>, _>>()?;
    if ids.is_empty() {
        return Ok("[]".to_owned());
    }
    let triggers=sqlx::query(&format!("SELECT t.automation_id::text owner,({})::text payload FROM automation_triggers t WHERE t.org_id=$1::uuid AND t.automation_id=ANY($2::text[]::uuid[]) ORDER BY t.created_at ASC,t.id ASC",projection("automationTriggers","t")))
        .bind(org).bind(&ids).fetch_all(&mut **tx).await?;
    let mut trigger_map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in triggers {
        let trigger = record("automationTriggers", &row.try_get::<String, _>("payload")?)?;
        trigger_map
            .entry(row.try_get("owner")?)
            .or_default()
            .push(encode(retain(
                &trigger,
                &[
                    "id",
                    "kind",
                    "label",
                    "enabled",
                    "nextRunAt",
                    "lastFiredAt",
                    "lastResult",
                ],
            )));
    }
    let latest=sqlx::query(&format!("SELECT DISTINCT ON (r.automation_id) r.automation_id::text owner,({})::text payload FROM automation_runs r {RUN_JOINS} WHERE r.org_id=$1::uuid AND r.automation_id=ANY($2::text[]::uuid[]) ORDER BY r.automation_id,r.created_at DESC,r.id DESC",run_projection()))
        .bind(org).bind(&ids).bind(owner).fetch_all(&mut **tx).await?;
    let mut last_map = BTreeMap::new();
    for row in latest {
        last_map.insert(
            row.try_get::<String, _>("owner")?,
            encode(record(
                "automationRuns",
                &row.try_get::<String, _>("payload")?,
            )?),
        );
    }
    let mut active = active_issues(tx, org, &ids).await?;
    let mut result = Vec::with_capacity(rows.len());
    for mut row in rows {
        let key = id(&row)?;
        row.insert(
            "triggers".into(),
            array(trigger_map.remove(&key).unwrap_or_default()),
        );
        row.insert(
            "lastRun".into(),
            last_map.remove(&key).unwrap_or_else(|| "null".into()),
        );
        row.insert(
            "activeIssue".into(),
            active
                .remove(&key)
                .map(|issue| {
                    encode(retain(
                        &issue,
                        &[
                            "id",
                            "identifier",
                            "title",
                            "status",
                            "priority",
                            "updatedAt",
                        ],
                    ))
                })
                .unwrap_or_else(|| "null".into()),
        );
        result.push(encode(row));
    }
    Ok(array(result))
}
async fn relation(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    table: &str,
    key: Option<String>,
) -> Result<Option<Object>, AutomationReadError> {
    let Some(key) = key else { return Ok(None) };
    let sql_table = match table {
        "projects" => "projects",
        "agents" => "agents",
        "issues" => "issues",
        _ => unreachable!(),
    };
    let row = sqlx::query_scalar::<_, String>(&format!(
        "SELECT ({})::text FROM {sql_table} r WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
        projection(table, "r")
    ))
    .bind(org)
    .bind(&key)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(raw) = row else { return Ok(None) };
    let mut value = record(table, &raw)?;
    if table == "issues" {
        // Parent issue detail includes hidden rows, just like getById. Labels
        // are fenced here without changing the shared mutation/read helper.
        let labels=sqlx::query_scalar::<_,String>(&format!("SELECT ({})::text FROM issue_labels x INNER JOIN labels l ON l.id=x.label_id AND l.org_id=x.org_id WHERE x.org_id=$1::uuid AND x.issue_id=$2::uuid ORDER BY l.name ASC,l.id ASC",projection("labels","l")))
            .bind(org).bind(&key).fetch_all(&mut **tx).await?;
        let mut label_ids = Vec::new();
        for label in &labels {
            label_ids.push(serde_json::to_string(&id(&record("labels", label)?)?)?);
        }
        value.insert("labels".into(), array(labels));
        value.insert("labelIds".into(), array(label_ids));
    }
    Ok(Some(value))
}
pub async fn read_automations(
    pool: &PgPool,
    org: &str,
    owner: Option<&str>,
    input: &AutomationReadInput,
) -> Result<String, AutomationReadError> {
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
    let result = if input.operation == AutomationReadOperation::List {
        list(&mut tx, org, owner).await?
    } else {
        let key = input
            .automation_id
            .as_deref()
            .ok_or(StoreError::InvalidInput)?;
        let raw=sqlx::query_scalar::<_,String>(&format!("SELECT ({})::text FROM automations r WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND ($3 OR r.status<>'archived')",projection("automations","r")))
            .bind(org).bind(key).bind(input.operation==AutomationReadOperation::Runs).fetch_optional(&mut *tx).await?.ok_or(StoreError::NotFound)?;
        if input.operation == AutomationReadOperation::Runs {
            runs(&mut tx, org, key, owner, input.limit.unwrap_or(50.0)).await?
        } else {
            let mut row = record("automations", &raw)?;
            for (field, table, reference) in [
                ("project", "projects", "projectId"),
                ("assignee", "agents", "assigneeAgentId"),
                ("parentIssue", "issues", "parentIssueId"),
            ] {
                let related = relation(&mut tx, org, table, text(&row, reference)?).await?;
                row.insert(
                    field.into(),
                    related.map(encode).unwrap_or_else(|| "null".into()),
                );
            }
            let triggers=sqlx::query_scalar::<_,String>(&format!("SELECT ({})::text FROM automation_triggers t WHERE t.org_id=$1::uuid AND t.automation_id=$2::uuid ORDER BY t.created_at ASC",projection("automationTriggers","t")))
                .bind(org).bind(key).fetch_all(&mut *tx).await?;
            row.insert("chatConversation".into(), "null".into());
            row.insert("triggers".into(), array(triggers));
            row.insert(
                "recentRuns".into(),
                runs(&mut tx, org, key, owner, 25.0).await?,
            );
            row.insert(
                "activeIssue".into(),
                active_issues(&mut tx, org, &[key.to_owned()])
                    .await?
                    .remove(key)
                    .map(encode)
                    .unwrap_or_else(|| "null".into()),
            );
            encode(row)
        }
    };
    tx.commit().await?;
    Ok(normalize_legacy_read_json(&result)?)
}
