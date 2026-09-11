//! PostgreSQL adapters for organization-scoped Rudder data surfaces.
//!
//! The repository owns SQL construction and database-to-projection mapping so
//! Actix handlers do not have to duplicate organization fencing, pagination, or
//! visibility policy. All values are sent through SQLx bind parameters; only
//! the fixed table, column, and projection fragments are assembled as SQL.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
pub use rudder_read_surfaces_core::{
    AgentListOptions, AgentProjection, ApprovalListOptions, ApprovalProjection,
    ApprovalTargetProjection, EntityKind, GoalCriterionProjection, GoalEvaluationProjection,
    GoalProjection, IssueListOptions, IssueProjection, OrganizationProjection, OrganizationScope,
    OrganizationWorkspaceProjection, Page, PageRequest, ProjectGoalProjection, ProjectProjection,
    QueryBind, QueryPlan, ReadError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{
    FromRow, PgPool, Postgres,
    postgres::{PgArguments, PgRow},
    query::QueryAs,
};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub mod issue_mutation;

#[cfg(test)]
#[path = "issue_mutation_contract_tests.rs"]
mod issue_mutation_contract_tests;

#[cfg(test)]
#[path = "issue_mutation_postgres_tests.rs"]
mod issue_mutation_postgres_tests;

const PAGE_LOOKAHEAD: usize = 1;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProjectionError {
    #[error("{entity} field {field} must be a JSON object")]
    ObjectRequired {
        entity: &'static str,
        field: &'static str,
    },
    #[error("{entity} field {field} must be a JSON array")]
    ArrayRequired {
        entity: &'static str,
        field: &'static str,
    },
    #[error("{entity} field {field} contains a non-string value")]
    StringRequired {
        entity: &'static str,
        field: &'static str,
    },
    #[error("{entity} field {field} contains an invalid object")]
    InvalidObject {
        entity: &'static str,
        field: &'static str,
    },
}

#[derive(Debug, Error)]
pub enum ReadAdapterError {
    #[error(transparent)]
    Contract(#[from] ReadError),
    #[error("{entity} {id} was not found in the authorized organization scope")]
    NotFound { entity: &'static str, id: String },
    #[error("database read failed")]
    Database(#[source] sqlx::Error),
    #[error(transparent)]
    Projection(#[from] ProjectionError),
}

pub type DbError = ReadAdapterError;
pub type DbReadError = ReadAdapterError;

impl From<sqlx::Error> for ReadAdapterError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// The row selected by the organization read query.
///
/// JSON configuration stays a JSON value until projection so malformed legacy
/// data can be reported as a projection error rather than silently exposed.
#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct OrganizationDbRow {
    pub id: String,
    pub url_key: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub issue_prefix: String,
    pub issue_prefix_aliases: Value,
    pub workspace_config: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// The columns needed to project a Goal read surface.
#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct GoalDbRow {
    pub id: String,
    pub org_id: String,
    pub title: String,
    pub description: Option<String>,
    pub alignment_question: Option<String>,
    pub outcome_statement: Option<String>,
    pub level: String,
    pub status: String,
    pub objective_mode: String,
    pub lifecycle: String,
    pub criteria: Value,
    pub autonomy_envelope: Value,
    pub human_authorities: Value,
    pub evaluation_policy: Value,
    pub evaluation_result: Option<Value>,
    pub result_payload: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// The columns needed to project a Project read surface.
#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct ProjectDbRow {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub goal_id: Option<String>,
    pub goal_refs: Value,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The columns needed to project an Agent read surface.
#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct AgentDbRow {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub role: String,
    pub title: Option<String>,
    pub status: String,
    pub readiness_state: String,
    pub readiness_result_code: Option<String>,
    pub capabilities: Option<String>,
    pub agent_runtime_type: String,
    pub agent_runtime_config: Value,
    pub runtime_config: Value,
    pub metadata: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct IssueDbRow {
    pub id: String,
    pub org_id: String,
    pub project_id: Option<String>,
    pub goal_id: Option<String>,
    pub issue_number: Option<i32>,
    pub identifier: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub board_order: i32,
    pub assignee_agent_id: Option<String>,
    pub assignee_user_id: Option<String>,
    pub reviewer_agent_id: Option<String>,
    pub reviewer_user_id: Option<String>,
    pub revision: i64,
    pub fencing_token: i64,
    pub checkout_run_id: Option<String>,
    pub execution_run_id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub hidden_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct ApprovalDbRow {
    pub id: String,
    pub org_id: String,
    pub approval_type: String,
    pub status: String,
    pub revision: i64,
    pub decision: Option<String>,
    pub requested_by_agent_id: Option<String>,
    pub requested_by_user_id: Option<String>,
    pub decision_note: Option<String>,
    pub decided_by_user_id: Option<String>,
    pub decided_at: Option<String>,
    pub payload: Value,
    pub target_rows: Value,
    pub created_at: String,
    pub updated_at: String,
}

impl OrganizationDbRow {
    pub fn into_projection(self) -> Result<OrganizationProjection, ProjectionError> {
        Ok(OrganizationProjection {
            id: self.id,
            url_key: self.url_key,
            name: self.name,
            description: self.description,
            status: self.status,
            issue_prefix: self.issue_prefix,
            issue_prefix_aliases: string_array(
                self.issue_prefix_aliases,
                "organization",
                "issue_prefix_aliases",
            )?,
            workspace: workspace_projection(self.workspace_config)?,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl GoalDbRow {
    pub fn into_projection(self) -> Result<GoalProjection, ProjectionError> {
        let criteria = self
            .criteria
            .as_array()
            .ok_or(ProjectionError::ArrayRequired {
                entity: "goal",
                field: "criteria",
            })?
            .iter()
            .filter_map(goal_criterion)
            .collect();
        let evaluation_result = self.evaluation_result.as_ref().and_then(|value| {
            Some(GoalEvaluationProjection {
                outcome: value.get("outcome")?.as_str()?.to_owned(),
            })
        });
        Ok(GoalProjection {
            id: self.id,
            org_id: self.org_id,
            title: self.title,
            description: self.description,
            level: self.level,
            status: self.status,
            criteria,
            evaluation_result,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl ProjectDbRow {
    pub fn into_projection(self) -> Result<ProjectProjection, ProjectionError> {
        let goals = goal_refs(self.goal_refs)?;
        Ok(ProjectProjection {
            id: self.id,
            org_id: self.org_id,
            name: self.name.clone(),
            url_key: slug(&self.name),
            description: self.description,
            status: self.status,
            goal_ids: goals.iter().map(|goal| goal.id.clone()).collect(),
            goals,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl AgentDbRow {
    pub fn into_projection(self) -> Result<AgentProjection, ProjectionError> {
        Ok(AgentProjection {
            id: self.id,
            org_id: self.org_id,
            name: self.name.clone(),
            url_key: slug(&self.name),
            role: self.role,
            title: self.title,
            status: self.status,
            readiness_state: self.readiness_state,
            readiness_result_code: self.readiness_result_code,
            capabilities: self.capabilities,
            agent_runtime_type: self.agent_runtime_type,
            agent_runtime_config: if self.agent_runtime_config.is_object() {
                self.agent_runtime_config
            } else {
                json!({})
            },
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl IssueDbRow {
    pub fn into_projection(self) -> Result<IssueProjection, ProjectionError> {
        Ok(IssueProjection {
            id: self.id,
            org_id: self.org_id,
            project_id: self.project_id,
            goal_id: self.goal_id,
            issue_number: self.issue_number,
            identifier: self.identifier,
            title: self.title,
            description: self.description,
            status: self.status,
            priority: self.priority,
            board_order: self.board_order,
            assignee_agent_id: self.assignee_agent_id,
            assignee_user_id: self.assignee_user_id,
            reviewer_agent_id: self.reviewer_agent_id,
            reviewer_user_id: self.reviewer_user_id,
            revision: nonnegative("issue", self.revision, "revision")?,
            fencing_token: nonnegative("issue", self.fencing_token, "fencing_token")?,
            checkout_run_id: self.checkout_run_id,
            execution_run_id: self.execution_run_id,
            started_at: self.started_at,
            completed_at: self.completed_at,
            cancelled_at: self.cancelled_at,
            hidden_at: self.hidden_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

impl ApprovalDbRow {
    pub fn into_projection(self) -> Result<ApprovalProjection, ProjectionError> {
        let targets = approval_targets(&self.payload, &self.target_rows, &self.org_id)?;
        Ok(ApprovalProjection {
            id: self.id,
            org_id: self.org_id,
            approval_type: self.approval_type,
            status: self.status,
            revision: nonnegative("approval", self.revision, "revision")?,
            decision: self.decision,
            requested_by_agent_id: self.requested_by_agent_id,
            requested_by_user_id: self.requested_by_user_id,
            decision_note: self.decision_note,
            decided_by_user_id: self.decided_by_user_id,
            decided_at: self.decided_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
            targets,
        })
    }
}

fn nonnegative(
    entity: &'static str,
    value: i64,
    field: &'static str,
) -> Result<u64, ProjectionError> {
    u64::try_from(value).map_err(|_| ProjectionError::InvalidObject { entity, field })
}

fn approval_targets(
    payload: &Value,
    target_rows: &Value,
    org_id: &str,
) -> Result<Vec<ApprovalTargetProjection>, ProjectionError> {
    let payload_object = payload.as_object().ok_or(ProjectionError::ObjectRequired {
        entity: "approval",
        field: "payload",
    })?;
    let payload_issue_id = match payload_object.get("issueId") {
        None => None,
        Some(value) => Some(value.as_str().ok_or(ProjectionError::StringRequired {
            entity: "approval",
            field: "payload.issueId",
        })?),
    };
    let rows = target_rows
        .as_array()
        .ok_or(ProjectionError::ArrayRequired {
            entity: "approval",
            field: "target_rows",
        })?;
    if rows.len() > rudder_read_surfaces_core::MAX_APPROVAL_TARGETS {
        return Err(ProjectionError::InvalidObject {
            entity: "approval",
            field: "target_rows",
        });
    }

    let mut targets = Vec::with_capacity(rows.len().max(1));
    for value in rows {
        let object = value.as_object().ok_or(ProjectionError::InvalidObject {
            entity: "approval",
            field: "target_rows",
        })?;
        let kind = required_json_string(object, "kind")?;
        let id = required_json_string(object, "id")?;
        if kind == "issue"
            && (object.get("associationOrgId").and_then(Value::as_str) != Some(org_id)
                || object.get("issueOrgId").and_then(Value::as_str) != Some(org_id))
        {
            return Err(ProjectionError::InvalidObject {
                entity: "approval",
                field: "target_rows",
            });
        }
        if kind == "organization" && id != org_id {
            return Err(ProjectionError::InvalidObject {
                entity: "approval",
                field: "target_rows",
            });
        }
        if kind == "issue" && payload_issue_id.is_some_and(|payload_id| payload_id != id) {
            return Err(ProjectionError::InvalidObject {
                entity: "approval",
                field: "payload.issueId",
            });
        }
        targets.push(ApprovalTargetProjection {
            kind: kind.to_owned(),
            id: id.to_owned(),
            identifier: optional_json_string(object, "identifier")?,
            title: optional_json_string(object, "title")?,
        });
    }
    if targets.is_empty() {
        if payload_issue_id.is_some() {
            return Err(ProjectionError::InvalidObject {
                entity: "approval",
                field: "payload.issueId",
            });
        }
        targets.push(ApprovalTargetProjection {
            kind: "organization".into(),
            id: org_id.into(),
            identifier: None,
            title: None,
        });
    }
    Ok(targets)
}

fn required_json_string<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, ProjectionError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(ProjectionError::StringRequired {
            entity: "approval",
            field,
        })
}

fn optional_json_string(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<String>, ProjectionError> {
    let Some(value) = object.get(field) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(ToOwned::to_owned)
        .map(Some)
        .ok_or(ProjectionError::StringRequired {
            entity: "approval",
            field,
        })
}

fn string_array(
    value: Value,
    entity: &'static str,
    field: &'static str,
) -> Result<Vec<String>, ProjectionError> {
    value
        .as_array()
        .ok_or(ProjectionError::ArrayRequired { entity, field })?
        .iter()
        .map(|item| {
            item.as_str()
                .map(ToOwned::to_owned)
                .ok_or(ProjectionError::StringRequired { entity, field })
        })
        .collect()
}

fn workspace_projection(
    value: Option<Value>,
) -> Result<Option<OrganizationWorkspaceProjection>, ProjectionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value.as_object().ok_or(ProjectionError::ObjectRequired {
        entity: "organization",
        field: "workspace_config",
    })?;
    Ok(Some(OrganizationWorkspaceProjection {
        source_type: optional_object_string(object, "sourceType", "source_type")?,
        cwd: optional_object_string(object, "cwd", "cwd")?,
        repo_url: optional_object_string(object, "repoUrl", "repo_url")?,
        repo_ref: optional_object_string(object, "repoRef", "repo_ref")?,
        default_ref: optional_object_string(object, "defaultRef", "default_ref")?,
    }))
}

fn optional_object_string(
    object: &Map<String, Value>,
    preferred: &'static str,
    alternate: &'static str,
) -> Result<Option<String>, ProjectionError> {
    let Some(value) = object.get(preferred).or_else(|| object.get(alternate)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or(ProjectionError::StringRequired {
            entity: "organization",
            field: preferred,
        })
        .map(Some)
}

fn goal_criterion(value: &Value) -> Option<GoalCriterionProjection> {
    let object = value.as_object()?;
    let id = object.get("id")?.as_str()?.to_owned();
    let label = object.get("label")?.as_str()?.trim();
    (!label.is_empty()).then(|| GoalCriterionProjection {
        id,
        label: label.to_owned(),
    })
}

fn goal_refs(value: Value) -> Result<Vec<ProjectGoalProjection>, ProjectionError> {
    value
        .as_array()
        .ok_or(ProjectionError::ArrayRequired {
            entity: "project",
            field: "goal_refs",
        })?
        .iter()
        .map(|value| {
            let object = value.as_object().ok_or(ProjectionError::InvalidObject {
                entity: "project",
                field: "goal_refs",
            })?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or(ProjectionError::InvalidObject {
                    entity: "project",
                    field: "goal_refs",
                })?;
            let title = object.get("title").and_then(Value::as_str).ok_or(
                ProjectionError::InvalidObject {
                    entity: "project",
                    field: "goal_refs",
                },
            )?;
            Ok(ProjectGoalProjection {
                id: id.to_owned(),
                title: title.to_owned(),
            })
        })
        .collect()
}

fn slug(value: &str) -> String {
    let mut result = String::new();
    let mut pending_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !result.is_empty() {
                result.push('-');
            }
            pending_separator = false;
            result.push(character.to_ascii_lowercase());
        } else if !result.is_empty() {
            pending_separator = true;
        }
    }
    result
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorWire {
    created_at: String,
    id: String,
}

fn invalid_cursor() -> ReadAdapterError {
    ReadAdapterError::Contract(ReadError::InvalidCursor)
}

fn decode_cursor(page: &PageRequest) -> Result<Option<CursorWire>, ReadAdapterError> {
    let Some(encoded) = page.cursor() else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| invalid_cursor())?;
    let cursor: CursorWire = serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())?;
    if cursor.created_at.is_empty()
        || cursor.id.is_empty()
        || OffsetDateTime::parse(&cursor.created_at, &Rfc3339).is_err()
        || !is_canonical_uuid(&cursor.id)
    {
        return Err(invalid_cursor());
    }
    Ok(Some(cursor))
}

fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn encode_cursor(created_at: &str, id: &str) -> String {
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&CursorWire {
            created_at: created_at.to_owned(),
            id: id.to_owned(),
        })
        .expect("cursor wire is serializable"),
    )
}

trait CursorRow {
    fn id(&self) -> &str;
    fn created_at(&self) -> &str;
}

impl CursorRow for OrganizationDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

impl CursorRow for GoalDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

impl CursorRow for ProjectDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

impl CursorRow for AgentDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

impl CursorRow for IssueDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

impl CursorRow for ApprovalDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

fn page_rows<T, U>(
    mut rows: Vec<T>,
    page: &PageRequest,
    project: impl FnMut(T) -> Result<U, ProjectionError>,
) -> Result<Page<U>, ReadAdapterError>
where
    T: CursorRow,
{
    let has_more = rows.len() > page.limit();
    rows.truncate(page.limit());
    let next_cursor = if has_more {
        rows.last()
            .map(|row| encode_cursor(row.created_at(), row.id()))
    } else {
        None
    };
    let project = project;
    let items = rows
        .into_iter()
        .map(project)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Page {
        items,
        next_cursor,
        has_more,
    })
}

fn table_parts(kind: EntityKind) -> (&'static str, &'static str, &'static str) {
    match kind {
        EntityKind::Organization => ("organizations", "o", "o.id"),
        EntityKind::Goal => ("goals", "g", "g.org_id"),
        EntityKind::Project => ("projects", "p", "p.org_id"),
        EntityKind::Agent => ("agents", "a", "a.org_id"),
        EntityKind::Issue => ("issues", "i", "i.org_id"),
        EntityKind::Approval => ("approvals", "a", "a.org_id"),
    }
}

fn list_select(kind: EntityKind) -> &'static str {
    match kind {
        EntityKind::Organization => {
            "SELECT o.id::text AS id, o.url_key, o.name, o.description, o.status, \
             o.issue_prefix, \
             COALESCE((SELECT jsonb_agg(alias.prefix ORDER BY alias.prefix) \
                       FROM organization_issue_prefix_aliases alias \
                       WHERE alias.org_id = o.id), '[]'::jsonb) AS issue_prefix_aliases, \
             o.workspace_config, \
             to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
             to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at \
             FROM organizations o"
        }
        EntityKind::Goal => {
            "SELECT g.id::text AS id, g.org_id::text AS org_id, g.title, g.description, \
             g.alignment_question, g.outcome_statement, g.level, g.status, \
             g.objective_mode, g.lifecycle, g.criteria, g.autonomy_envelope, \
             g.human_authorities, g.evaluation_policy, g.evaluation_result, \
             g.result_payload, \
             to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
             to_char(g.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at \
             FROM goals g"
        }
        EntityKind::Project => {
            "SELECT p.id::text AS id, p.org_id::text AS org_id, p.name, p.description, p.status, \
             p.goal_id::text AS goal_id, \
             COALESCE((SELECT jsonb_agg(jsonb_build_object('id', refs.id::text, 'title', refs.title) \
                                      ORDER BY refs.id) \
                       FROM ( \
                         SELECT goal.id, goal.title \
                         FROM goals goal \
                         WHERE goal.id = p.goal_id AND goal.org_id = p.org_id \
                         UNION \
                         SELECT goal.id, goal.title \
                         FROM project_goals project_goal \
                         JOIN goals goal ON goal.id = project_goal.goal_id \
                                         AND goal.org_id = project_goal.org_id \
                         WHERE project_goal.project_id = p.id \
                           AND project_goal.org_id = p.org_id \
                       ) refs), '[]'::jsonb) AS goal_refs, \
             p.color, p.icon, \
             to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
             to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at \
             FROM projects p"
        }
        EntityKind::Agent => {
            "SELECT a.id::text AS id, a.org_id::text AS org_id, a.name, a.role, a.title, \
             a.status, a.readiness_state, a.readiness_result_code, a.capabilities, \
             a.agent_runtime_type, a.agent_runtime_config, a.runtime_config, a.metadata, \
             to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
             to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at \
             FROM agents a"
        }
        EntityKind::Issue => {
            "SELECT i.id::text AS id, i.org_id::text AS org_id, \
             i.project_id::text AS project_id, i.goal_id::text AS goal_id, i.issue_number, \
             i.identifier, i.title, i.description, i.status, i.priority, i.board_order, \
             i.assignee_agent_id::text AS assignee_agent_id, i.assignee_user_id, \
             i.reviewer_agent_id::text AS reviewer_agent_id, i.reviewer_user_id, \
             i.revision, i.fencing_token, i.checkout_run_id::text AS checkout_run_id, \
             i.execution_run_id::text AS execution_run_id, \
             to_char(i.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS started_at, \
             to_char(i.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS completed_at, \
             to_char(i.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cancelled_at, \
             to_char(i.hidden_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS hidden_at, \
             to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
             to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at \
             FROM issues i"
        }
        EntityKind::Approval => {
            "SELECT a.id::text AS id, a.org_id::text AS org_id, a.type AS approval_type, \
             a.status, a.revision, a.decision, a.requested_by_agent_id::text AS requested_by_agent_id, \
             a.requested_by_user_id, a.decision_note, a.decided_by_user_id, \
             to_char(a.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS decided_at, \
             a.payload, \
             COALESCE((SELECT jsonb_agg(jsonb_build_object( \
                 'kind', 'issue', 'id', ia.issue_id::text, 'identifier', target.identifier, \
                 'title', target.title, 'associationOrgId', ia.org_id::text, \
                 'issueOrgId', target.org_id::text) ORDER BY ia.created_at, ia.issue_id) \
               FROM (SELECT ia.issue_id, ia.approval_id, ia.org_id, ia.created_at \
                     FROM issue_approvals ia WHERE ia.approval_id = a.id \
                       AND ia.org_id = a.org_id \
                     ORDER BY ia.created_at, ia.issue_id LIMIT 33) ia \
               LEFT JOIN issues target ON target.id = ia.issue_id \
                                      AND target.org_id = ia.org_id), '[]'::jsonb) AS target_rows, \
             to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
             to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at \
             FROM approvals a"
        }
    }
}

fn scoped_predicate(column: &str, bind_count: usize) -> String {
    if bind_count == 1 {
        format!("{column} = $1::uuid")
    } else {
        let placeholders = (1..=bind_count)
            .map(|index| format!("${index}::uuid"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{column} IN ({placeholders})")
    }
}

/// Build the parameterized SELECT used by a list method.
///
/// The query fetches one bounded look-ahead row so the repository can return
/// `has_more` without a count query. `PageRequest` has already capped the
/// caller's requested page size at the shared read-surface maximum.
pub fn list_query_plan(
    kind: EntityKind,
    scope: &OrganizationScope,
    page: &PageRequest,
    agent_options: AgentListOptions,
) -> Result<QueryPlan, ReadAdapterError> {
    let cursor = decode_cursor(page)?;
    let (_, _alias, scope_column) = table_parts(kind);
    let mut binds = scope
        .ids()
        .map(|id| QueryBind::Text(id.to_owned()))
        .collect::<Vec<_>>();
    let mut predicates = vec![scoped_predicate(scope_column, binds.len())];
    if let Some(cursor) = cursor {
        let created_bind = binds.len() + 1;
        let id_bind = created_bind + 1;
        predicates.push(format!(
            "(created_at, id) > (${created_bind}::timestamptz, ${id_bind}::uuid)"
        ));
        binds.push(QueryBind::Text(cursor.created_at));
        binds.push(QueryBind::Text(cursor.id));
    }
    if kind == EntityKind::Agent {
        if !agent_options.include_terminated {
            predicates.push("a.status <> 'terminated'".into());
        }
        if !agent_options.include_hidden {
            predicates.push("COALESCE(a.metadata->>'hidden', 'false') <> 'true'".into());
            predicates
                .push("COALESCE(a.metadata->>'systemManaged', '') <> 'rudder_copilot'".into());
        }
    } else if kind == EntityKind::Issue {
        if !agent_options.include_terminated {
            predicates.push("i.status <> 'terminated'".into());
        }
        if !agent_options.include_hidden {
            predicates.push("i.hidden_at IS NULL".into());
        }
    } else if kind == EntityKind::Approval && !agent_options.include_terminated {
        predicates.push("a.status <> 'terminated'".into());
    }
    let limit_bind = binds.len() + 1;
    binds.push(QueryBind::Limit(page.limit() + PAGE_LOOKAHEAD));
    Ok(QueryPlan {
        sql: format!(
            "{} WHERE {} ORDER BY created_at ASC, id ASC LIMIT ${limit_bind}::int4",
            list_select(kind),
            predicates.join(" AND "),
        ),
        binds,
    })
}

/// Compatibility name for callers that only need the default list policy.
pub fn query_plan(
    kind: EntityKind,
    scope: &OrganizationScope,
    page: &PageRequest,
) -> Result<QueryPlan, ReadAdapterError> {
    list_query_plan(kind, scope, page, AgentListOptions::default())
}

/// Build the parameterized SELECT used by a get method.
pub fn get_query_plan(
    kind: EntityKind,
    scope: &OrganizationScope,
    id: &str,
) -> Result<QueryPlan, ReadAdapterError> {
    let (_, alias, scope_column) = table_parts(kind);
    let mut binds = scope
        .ids()
        .map(|scope_id| QueryBind::Text(scope_id.to_owned()))
        .collect::<Vec<_>>();
    let entity_bind = binds.len() + 1;
    let limit_bind = entity_bind + 1;
    binds.push(QueryBind::Text(id.to_owned()));
    binds.push(QueryBind::Limit(1));
    Ok(QueryPlan {
        sql: format!(
            "{} WHERE {} AND {alias}.id = ${entity_bind}::uuid LIMIT ${limit_bind}::int4",
            list_select(kind),
            scoped_predicate(scope_column, entity_bind - 1),
        ),
        binds,
    })
}

trait QueryPlanExt {
    fn bind_query_as<'q, O>(&'q self) -> QueryAs<'q, Postgres, O, PgArguments>
    where
        O: for<'r> FromRow<'r, PgRow>;
}

impl QueryPlanExt for QueryPlan {
    fn bind_query_as<'q, O>(&'q self) -> QueryAs<'q, Postgres, O, PgArguments>
    where
        O: for<'r> FromRow<'r, PgRow>,
    {
        let mut query = sqlx::query_as::<_, O>(&self.sql);
        for bind in &self.binds {
            query = match bind {
                QueryBind::Text(value) => query.bind(value.clone()),
                QueryBind::Limit(value) => query.bind(*value as i32),
            };
        }
        query
    }
}

#[derive(Clone)]
pub struct ReadRepository {
    pool: PgPool,
}

pub type OrganizationReadRepository = ReadRepository;
pub type DbReadRepository = ReadRepository;

impl ReadRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self::new(pool)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn list_organizations(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<OrganizationProjection>, ReadAdapterError> {
        let plan = list_query_plan(
            EntityKind::Organization,
            scope,
            &page,
            AgentListOptions::default(),
        )?;
        let rows = plan
            .bind_query_as::<OrganizationDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_rows(rows, &page, OrganizationDbRow::into_projection)
    }

    pub async fn get_organization(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<OrganizationProjection, ReadAdapterError> {
        let plan = get_query_plan(EntityKind::Organization, scope, id)?;
        let row = plan
            .bind_query_as::<OrganizationDbRow>()
            .fetch_optional(&self.pool)
            .await?;
        row.map(OrganizationDbRow::into_projection)
            .transpose()?
            .ok_or_else(|| not_found("organization", id))
    }

    pub async fn list_goals(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<GoalProjection>, ReadAdapterError> {
        let plan = list_query_plan(EntityKind::Goal, scope, &page, AgentListOptions::default())?;
        let rows = plan
            .bind_query_as::<GoalDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_rows(rows, &page, GoalDbRow::into_projection)
    }

    pub async fn get_goal(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<GoalProjection, ReadAdapterError> {
        let plan = get_query_plan(EntityKind::Goal, scope, id)?;
        let row = plan
            .bind_query_as::<GoalDbRow>()
            .fetch_optional(&self.pool)
            .await?;
        row.map(GoalDbRow::into_projection)
            .transpose()?
            .ok_or_else(|| not_found("goal", id))
    }

    pub async fn list_projects(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<ProjectProjection>, ReadAdapterError> {
        let plan = list_query_plan(
            EntityKind::Project,
            scope,
            &page,
            AgentListOptions::default(),
        )?;
        let rows = plan
            .bind_query_as::<ProjectDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_rows(rows, &page, ProjectDbRow::into_projection)
    }

    pub async fn get_project(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<ProjectProjection, ReadAdapterError> {
        let plan = get_query_plan(EntityKind::Project, scope, id)?;
        let row = plan
            .bind_query_as::<ProjectDbRow>()
            .fetch_optional(&self.pool)
            .await?;
        row.map(ProjectDbRow::into_projection)
            .transpose()?
            .ok_or_else(|| not_found("project", id))
    }

    pub async fn list_agents(
        &self,
        scope: &OrganizationScope,
        options: AgentListOptions,
        page: PageRequest,
    ) -> Result<Page<AgentProjection>, ReadAdapterError> {
        let plan = list_query_plan(EntityKind::Agent, scope, &page, options)?;
        let rows = plan
            .bind_query_as::<AgentDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_rows(rows, &page, AgentDbRow::into_projection)
    }

    pub async fn get_agent(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<AgentProjection, ReadAdapterError> {
        let plan = get_query_plan(EntityKind::Agent, scope, id)?;
        let row = plan
            .bind_query_as::<AgentDbRow>()
            .fetch_optional(&self.pool)
            .await?;
        row.map(AgentDbRow::into_projection)
            .transpose()?
            .ok_or_else(|| not_found("agent", id))
    }

    pub async fn list_issues(
        &self,
        scope: &OrganizationScope,
        options: IssueListOptions,
        page: PageRequest,
    ) -> Result<Page<IssueProjection>, ReadAdapterError> {
        let plan = list_query_plan(EntityKind::Issue, scope, &page, options)?;
        let rows = plan
            .bind_query_as::<IssueDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_rows(rows, &page, IssueDbRow::into_projection)
    }

    pub async fn get_issue(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<IssueProjection, ReadAdapterError> {
        let plan = get_query_plan(EntityKind::Issue, scope, id)?;
        let row = plan
            .bind_query_as::<IssueDbRow>()
            .fetch_optional(&self.pool)
            .await?;
        row.map(IssueDbRow::into_projection)
            .transpose()?
            .ok_or_else(|| not_found("issue", id))
    }

    pub async fn list_approvals(
        &self,
        scope: &OrganizationScope,
        options: ApprovalListOptions,
        page: PageRequest,
    ) -> Result<Page<ApprovalProjection>, ReadAdapterError> {
        let plan = list_query_plan(EntityKind::Approval, scope, &page, options)?;
        let rows = plan
            .bind_query_as::<ApprovalDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_rows(rows, &page, ApprovalDbRow::into_projection)
    }

    pub async fn get_approval(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<ApprovalProjection, ReadAdapterError> {
        let plan = get_query_plan(EntityKind::Approval, scope, id)?;
        let row = plan
            .bind_query_as::<ApprovalDbRow>()
            .fetch_optional(&self.pool)
            .await?;
        row.map(ApprovalDbRow::into_projection)
            .transpose()?
            .ok_or_else(|| not_found("approval", id))
    }
}

fn not_found(entity: &'static str, id: &str) -> ReadAdapterError {
    ReadAdapterError::NotFound {
        entity,
        id: id.to_owned(),
    }
}
