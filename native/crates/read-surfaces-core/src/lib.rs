//! Organization-scoped read projections used by future SQLx/Actix adapters.
//!
//! This crate deliberately has no database or network side effects. It makes
//! the read contract explicit first: an adapter can load the same row types
//! from PostgreSQL, apply the same fencing/projection rules, and serialize the
//! resulting pages without reimplementing product policy in a route handler.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use thiserror::Error;

pub const MAX_PAGE_SIZE: usize = 1_000;
const MAX_SCOPE_IDS: usize = 256;
const MAX_CURSOR_BYTES: usize = 4_096;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ReadError {
    #[error("organization scope must contain at least one organization")]
    InvalidScope,
    #[error("organization scope contains an invalid organization id")]
    InvalidScopeId,
    #[error("page limit must be between 1 and {MAX_PAGE_SIZE} (got {limit})")]
    InvalidPage { limit: usize },
    #[error("cursor is invalid or exceeds the bounded cursor size")]
    InvalidCursor,
    #[error("{entity} {id} was not found in the authorized organization scope")]
    NotFound { entity: &'static str, id: String },
}

/// The trusted organization set supplied by an authenticated adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrganizationScope {
    ids: BTreeSet<String>,
}

impl OrganizationScope {
    pub fn single(id: impl Into<String>) -> Result<Self, ReadError> {
        Self::many([id.into()])
    }

    pub fn many<I, S>(ids: I) -> Result<Self, ReadError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut authorized = BTreeSet::new();
        for id in ids {
            let id = id.into();
            if id.trim().is_empty() || id.len() > 256 || id.contains('\0') {
                return Err(ReadError::InvalidScopeId);
            }
            authorized.insert(id);
            if authorized.len() > MAX_SCOPE_IDS {
                return Err(ReadError::InvalidScope);
            }
        }
        if authorized.is_empty() {
            return Err(ReadError::InvalidScope);
        }
        Ok(Self { ids: authorized })
    }

    pub fn contains(&self, organization_id: &str) -> bool {
        self.ids.contains(organization_id)
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.ids.iter().map(String::as_str)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Cursor {
    created_at: String,
    id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PageRequest {
    limit: usize,
    cursor: Option<Cursor>,
}

impl PageRequest {
    pub fn new(limit: usize) -> Result<Self, ReadError> {
        validate_limit(limit)?;
        Ok(Self {
            limit,
            cursor: None,
        })
    }

    pub fn with_cursor(limit: usize, encoded: impl Into<String>) -> Result<Self, ReadError> {
        validate_limit(limit)?;
        let encoded = encoded.into();
        if encoded.len() > MAX_CURSOR_BYTES {
            return Err(ReadError::InvalidCursor);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|_| ReadError::InvalidCursor)?;
        let cursor: CursorWire =
            serde_json::from_slice(&bytes).map_err(|_| ReadError::InvalidCursor)?;
        if cursor.created_at.is_empty() || cursor.id.is_empty() {
            return Err(ReadError::InvalidCursor);
        }
        Ok(Self {
            limit,
            cursor: Some(Cursor {
                created_at: cursor.created_at,
                id: cursor.id,
            }),
        })
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn cursor(&self) -> Option<String> {
        self.cursor.as_ref().map(encode_cursor)
    }
}

fn validate_limit(limit: usize) -> Result<(), ReadError> {
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(ReadError::InvalidPage { limit });
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorWire {
    created_at: String,
    id: String,
}

fn encode_cursor(cursor: &Cursor) -> String {
    let wire = CursorWire {
        created_at: cursor.created_at.clone(),
        id: cursor.id.clone(),
    };
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&wire).expect("cursor wire is serializable"))
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationWorkspaceProjection {
    pub source_type: Option<String>,
    pub cwd: Option<String>,
    pub repo_url: Option<String>,
    pub repo_ref: Option<String>,
    pub default_ref: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationRow {
    pub id: String,
    pub url_key: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub issue_prefix: String,
    pub issue_prefix_aliases: Vec<String>,
    pub workspace: Option<OrganizationWorkspaceProjection>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalRow {
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

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalRefRow {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub goal_id: Option<String>,
    pub goal_refs: Vec<ProjectGoalRefRow>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
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

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFixtures {
    pub organizations: Vec<OrganizationRow>,
    pub goals: Vec<GoalRow>,
    pub projects: Vec<ProjectRow>,
    pub agents: Vec<AgentRow>,
}

#[derive(Clone, Debug)]
pub struct InMemoryReadStore {
    fixtures: ReadFixtures,
}

impl InMemoryReadStore {
    pub fn new(fixtures: ReadFixtures) -> Self {
        Self { fixtures }
    }
}

pub trait ReadStore: Clone {
    fn organizations(&self) -> &[OrganizationRow];
    fn goals(&self) -> &[GoalRow];
    fn projects(&self) -> &[ProjectRow];
    fn agents(&self) -> &[AgentRow];
}

impl ReadStore for InMemoryReadStore {
    fn organizations(&self) -> &[OrganizationRow] {
        &self.fixtures.organizations
    }

    fn goals(&self) -> &[GoalRow] {
        &self.fixtures.goals
    }

    fn projects(&self) -> &[ProjectRow] {
        &self.fixtures.projects
    }

    fn agents(&self) -> &[AgentRow] {
        &self.fixtures.agents
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationProjection {
    pub id: String,
    pub url_key: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub issue_prefix: String,
    pub issue_prefix_aliases: Vec<String>,
    pub workspace: Option<OrganizationWorkspaceProjection>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalCriterionProjection {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct GoalEvaluationProjection {
    pub outcome: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalProjection {
    pub id: String,
    pub org_id: String,
    pub title: String,
    pub description: Option<String>,
    pub level: String,
    pub status: String,
    pub criteria: Vec<GoalCriterionProjection>,
    pub evaluation_result: Option<GoalEvaluationProjection>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalProjection {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProjection {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub url_key: String,
    pub description: Option<String>,
    pub status: String,
    pub goal_ids: Vec<String>,
    pub goals: Vec<ProjectGoalProjection>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AgentListOptions {
    pub include_terminated: bool,
    pub include_hidden: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjection {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub url_key: String,
    pub role: String,
    pub title: Option<String>,
    pub status: String,
    pub readiness_state: String,
    pub readiness_result_code: Option<String>,
    pub capabilities: Option<String>,
    pub agent_runtime_type: String,
    pub agent_runtime_config: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntityKind {
    Organization,
    Goal,
    Project,
    Agent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QueryBind {
    Text(String),
    Limit(usize),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryPlan {
    pub sql: String,
    pub binds: Vec<QueryBind>,
}

/// Build the SQL shape an SQLx adapter should execute. Values are always binds.
pub fn query_plan(kind: EntityKind, scope: &OrganizationScope, page: &PageRequest) -> QueryPlan {
    let table = match kind {
        EntityKind::Organization => "organizations",
        EntityKind::Goal => "goals",
        EntityKind::Project => "projects",
        EntityKind::Agent => "agents",
    };
    let scope_column = match kind {
        EntityKind::Organization => "id",
        _ => "org_id",
    };
    let mut binds = scope
        .ids()
        .map(|id| QueryBind::Text(id.to_owned()))
        .collect::<Vec<_>>();
    let predicate = if binds.len() == 1 {
        format!("{scope_column} = $1")
    } else {
        let placeholders = (1..=binds.len()).map(|index| format!("${index}"));
        format!(
            "{scope_column} IN ({})",
            placeholders.collect::<Vec<_>>().join(", ")
        )
    };
    let limit_bind = binds.len() + 1;
    binds.push(QueryBind::Limit(page.limit));
    QueryPlan {
        sql: format!(
            "SELECT * FROM {table} WHERE {predicate} ORDER BY created_at ASC, id ASC LIMIT ${limit_bind}"
        ),
        binds,
    }
}

pub struct ReadModel<S> {
    store: S,
}

impl<S: ReadStore> ReadModel<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn list_organizations(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<OrganizationProjection>, ReadError> {
        let mut rows = self
            .store
            .organizations()
            .iter()
            .filter(|row| scope.contains(&row.id))
            .collect::<Vec<_>>();
        sort_rows(&mut rows, |row| (&row.created_at, &row.id));
        let (rows, next_cursor, has_more) =
            page_rows_with_key(rows, &page, |row| (&row.created_at, &row.id));
        Ok(Page {
            items: rows.into_iter().map(project_organization).collect(),
            next_cursor,
            has_more,
        })
    }

    pub fn list_goals(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<GoalProjection>, ReadError> {
        let mut rows = self
            .store
            .goals()
            .iter()
            .filter(|row| scope.contains(&row.org_id))
            .collect::<Vec<_>>();
        sort_rows(&mut rows, |row| (&row.created_at, &row.id));
        let (rows, next_cursor, has_more) =
            page_rows_with_key(rows, &page, |row| (&row.created_at, &row.id));
        Ok(Page {
            items: rows.into_iter().map(project_goal).collect(),
            next_cursor,
            has_more,
        })
    }

    pub fn get_goal(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<GoalProjection, ReadError> {
        self.store
            .goals()
            .iter()
            .find(|row| row.id == id && scope.contains(&row.org_id))
            .map(project_goal)
            .ok_or_else(|| ReadError::NotFound {
                entity: "goal",
                id: id.to_owned(),
            })
    }

    pub fn list_projects(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<ProjectProjection>, ReadError> {
        let mut rows = self
            .store
            .projects()
            .iter()
            .filter(|row| scope.contains(&row.org_id))
            .collect::<Vec<_>>();
        sort_rows(&mut rows, |row| (&row.created_at, &row.id));
        let (rows, next_cursor, has_more) =
            page_rows_with_key(rows, &page, |row| (&row.created_at, &row.id));
        Ok(Page {
            items: rows.into_iter().map(project_project).collect(),
            next_cursor,
            has_more,
        })
    }

    pub fn get_project(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<ProjectProjection, ReadError> {
        self.store
            .projects()
            .iter()
            .find(|row| row.id == id && scope.contains(&row.org_id))
            .map(project_project)
            .ok_or_else(|| ReadError::NotFound {
                entity: "project",
                id: id.to_owned(),
            })
    }

    pub fn list_agents(
        &self,
        scope: &OrganizationScope,
        options: AgentListOptions,
        page: PageRequest,
    ) -> Result<Page<AgentProjection>, ReadError> {
        let mut rows = self
            .store
            .agents()
            .iter()
            .filter(|row| scope.contains(&row.org_id))
            .filter(|row| options.include_terminated || row.status != "terminated")
            .filter(|row| options.include_hidden || !is_hidden(row.metadata.as_ref()))
            .collect::<Vec<_>>();
        sort_rows(&mut rows, |row| (&row.created_at, &row.id));
        let (rows, next_cursor, has_more) =
            page_rows_with_key(rows, &page, |row| (&row.created_at, &row.id));
        Ok(Page {
            items: rows.into_iter().map(project_agent).collect(),
            next_cursor,
            has_more,
        })
    }

    pub fn get_agent(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<AgentProjection, ReadError> {
        self.store
            .agents()
            .iter()
            .find(|row| row.id == id && scope.contains(&row.org_id))
            .map(project_agent)
            .ok_or_else(|| ReadError::NotFound {
                entity: "agent",
                id: id.to_owned(),
            })
    }
}

fn sort_rows<T>(rows: &mut [&T], key: impl Fn(&T) -> (&str, &str)) {
    rows.sort_by(|left, right| {
        let (left_created, left_id) = key(left);
        let (right_created, right_id) = key(right);
        left_created
            .cmp(right_created)
            .then_with(|| left_id.cmp(right_id))
    });
}

fn page_rows_with_key<'a, T>(
    mut rows: Vec<&'a T>,
    page: &PageRequest,
    key: impl Fn(&T) -> (&str, &str),
) -> (Vec<&'a T>, Option<String>, bool) {
    if let Some(cursor) = &page.cursor {
        rows.retain(|row| {
            let (created_at, id) = key(row);
            (created_at, id) > (cursor.created_at.as_str(), cursor.id.as_str())
        });
    }
    let has_more = rows.len() > page.limit;
    let page_rows = rows.into_iter().take(page.limit).collect::<Vec<_>>();
    let next_cursor = if has_more {
        page_rows.last().map(|row| {
            let (created_at, id) = key(row);
            encode_cursor(&Cursor {
                created_at: created_at.to_owned(),
                id: id.to_owned(),
            })
        })
    } else {
        None
    };
    (page_rows, next_cursor, has_more)
}

fn project_organization(row: &OrganizationRow) -> OrganizationProjection {
    OrganizationProjection {
        id: row.id.clone(),
        url_key: row.url_key.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        status: row.status.clone(),
        issue_prefix: row.issue_prefix.clone(),
        issue_prefix_aliases: row.issue_prefix_aliases.clone(),
        workspace: row.workspace.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

fn project_goal(row: &GoalRow) -> GoalProjection {
    GoalProjection {
        id: row.id.clone(),
        org_id: row.org_id.clone(),
        title: row.title.clone(),
        description: row.description.clone(),
        level: row.level.clone(),
        status: row.status.clone(),
        criteria: row
            .criteria
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| {
                let object = value.as_object()?;
                let id = object.get("id")?.as_str()?.to_owned();
                let label = object.get("label")?.as_str()?.trim();
                (!label.is_empty()).then(|| GoalCriterionProjection {
                    id,
                    label: label.to_owned(),
                })
            })
            .collect(),
        evaluation_result: row.evaluation_result.as_ref().and_then(|value| {
            Some(GoalEvaluationProjection {
                outcome: value.get("outcome")?.as_str()?.to_owned(),
            })
        }),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

fn project_project(row: &ProjectRow) -> ProjectProjection {
    let goals = row
        .goal_refs
        .iter()
        .map(|goal| ProjectGoalProjection {
            id: goal.id.clone(),
            title: goal.title.clone(),
        })
        .collect::<Vec<_>>();
    ProjectProjection {
        id: row.id.clone(),
        org_id: row.org_id.clone(),
        name: row.name.clone(),
        url_key: slug(&row.name),
        description: row.description.clone(),
        status: row.status.clone(),
        goal_ids: goals.iter().map(|goal| goal.id.clone()).collect(),
        goals,
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

fn project_agent(row: &AgentRow) -> AgentProjection {
    AgentProjection {
        id: row.id.clone(),
        org_id: row.org_id.clone(),
        name: row.name.clone(),
        url_key: slug(&row.name),
        role: row.role.clone(),
        title: row.title.clone(),
        status: row.status.clone(),
        readiness_state: row.readiness_state.clone(),
        readiness_result_code: row.readiness_result_code.clone(),
        capabilities: row.capabilities.clone(),
        agent_runtime_type: row.agent_runtime_type.clone(),
        agent_runtime_config: if row.agent_runtime_config.is_object() {
            row.agent_runtime_config.clone()
        } else {
            json!({})
        },
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

fn is_hidden(metadata: Option<&Value>) -> bool {
    let Some(object) = metadata.and_then(Value::as_object) else {
        return false;
    };
    object
        .get("hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || object
            .get("systemManaged")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "rudder_copilot")
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn organization(id: &str, created_at: &str) -> OrganizationRow {
        OrganizationRow {
            id: id.into(),
            url_key: format!("{id}-url"),
            name: format!("Organization {id}"),
            issue_prefix: id.to_uppercase(),
            created_at: created_at.into(),
            updated_at: created_at.into(),
            ..Default::default()
        }
    }

    fn goal(id: &str, org_id: &str, created_at: &str, title: &str) -> GoalRow {
        GoalRow {
            id: id.into(),
            org_id: org_id.into(),
            title: title.into(),
            description: Some(format!("Description for {title}")),
            criteria: json!([
                {"id": "criterion-1", "label": "Ship the read model"},
                {"id": "missing-label"},
            ]),
            evaluation_result: Some(json!({"outcome": "achieved", "internal": "hidden"})),
            created_at: created_at.into(),
            updated_at: created_at.into(),
            ..Default::default()
        }
    }

    fn project(id: &str, org_id: &str, created_at: &str, name: &str) -> ProjectRow {
        ProjectRow {
            id: id.into(),
            org_id: org_id.into(),
            name: name.into(),
            created_at: created_at.into(),
            updated_at: created_at.into(),
            ..Default::default()
        }
    }

    fn agent(id: &str, org_id: &str, created_at: &str, name: &str) -> AgentRow {
        AgentRow {
            id: id.into(),
            org_id: org_id.into(),
            name: name.into(),
            created_at: created_at.into(),
            updated_at: created_at.into(),
            ..Default::default()
        }
    }

    fn model() -> ReadModel<InMemoryReadStore> {
        ReadModel::new(InMemoryReadStore::new(ReadFixtures {
            organizations: vec![
                organization("org-b", "2026-01-02T00:00:00Z"),
                organization("org-a", "2026-01-01T00:00:00Z"),
            ],
            goals: vec![
                goal("goal-b", "org-b", "2026-01-01T00:00:00Z", "Foreign Goal"),
                goal("goal-new", "org-a", "2026-01-03T00:00:00Z", "New Goal"),
                goal("goal-old", "org-a", "2026-01-02T00:00:00Z", "Old Goal"),
            ],
            projects: vec![
                ProjectRow {
                    goal_refs: vec![ProjectGoalRefRow {
                        id: "goal-old".into(),
                        title: "Old Goal".into(),
                    }],
                    ..project(
                        "project-a",
                        "org-a",
                        "2026-01-04T00:00:00Z",
                        "Build Platform",
                    )
                },
                project(
                    "project-b",
                    "org-b",
                    "2026-01-01T00:00:00Z",
                    "Foreign Project",
                ),
            ],
            agents: vec![
                agent(
                    "agent-active",
                    "org-a",
                    "2026-01-02T00:00:00Z",
                    "Read Agent",
                ),
                AgentRow {
                    status: "terminated".into(),
                    ..agent(
                        "agent-terminated",
                        "org-a",
                        "2026-01-03T00:00:00Z",
                        "Terminated",
                    )
                },
                AgentRow {
                    metadata: Some(json!({"hidden": true})),
                    ..agent("agent-hidden", "org-a", "2026-01-04T00:00:00Z", "Hidden")
                },
                AgentRow {
                    metadata: Some(json!({"systemManaged": "rudder_copilot"})),
                    ..agent(
                        "agent-copilot",
                        "org-a",
                        "2026-01-05T00:00:00Z",
                        "Rudder Copilot",
                    )
                },
                agent(
                    "agent-foreign",
                    "org-b",
                    "2026-01-01T00:00:00Z",
                    "Foreign Agent",
                ),
            ],
        }))
    }

    #[test]
    fn organization_list_is_fenced_to_allowed_scope_and_stably_ordered() {
        let model = model();
        let scope = OrganizationScope::many(["org-a", "org-b"]).unwrap();

        let page = model
            .list_organizations(&scope, PageRequest::new(10).unwrap())
            .unwrap();

        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["org-a", "org-b"]
        );
        assert_eq!(page.items[0].issue_prefix_aliases, Vec::<String>::new());
        assert_eq!(page.items[0].workspace, None);
    }

    #[test]
    fn child_lists_are_organization_fenced_and_goals_keep_node_order_and_projection() {
        let model = model();
        let scope = OrganizationScope::single("org-a").unwrap();

        let page = model
            .list_goals(&scope, PageRequest::new(10).unwrap())
            .unwrap();

        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["goal-old", "goal-new"]
        );
        assert!(page.items.iter().all(|item| item.org_id == "org-a"));
        assert_eq!(
            page.items[0].criteria,
            vec![GoalCriterionProjection {
                id: "criterion-1".into(),
                label: "Ship the read model".into(),
            }]
        );
        assert_eq!(
            page.items[0].evaluation_result,
            Some(GoalEvaluationProjection {
                outcome: "achieved".into()
            })
        );
    }

    #[test]
    fn cursor_pages_are_stable_and_not_found_is_used_for_cross_org_gets() {
        let model = model();
        let scope = OrganizationScope::single("org-a").unwrap();

        let first = model
            .list_goals(&scope, PageRequest::new(1).unwrap())
            .unwrap();
        let cursor = first
            .next_cursor
            .clone()
            .expect("first page has a next cursor");
        let second = model
            .list_goals(&scope, PageRequest::with_cursor(1, cursor).unwrap())
            .unwrap();

        assert_eq!(first.items[0].id, "goal-old");
        assert_eq!(second.items[0].id, "goal-new");
        assert!(second.next_cursor.is_none());
        assert!(matches!(
            model.get_goal(&scope, "goal-b"),
            Err(ReadError::NotFound { entity: "goal", .. })
        ));
        assert!(matches!(
            model.get_project(&scope, "project-b"),
            Err(ReadError::NotFound {
                entity: "project",
                ..
            })
        ));
        assert!(matches!(
            model.get_agent(&scope, "agent-foreign"),
            Err(ReadError::NotFound {
                entity: "agent",
                ..
            })
        ));
    }

    #[test]
    fn project_projection_preserves_goal_refs_and_agent_list_filters_hidden_and_terminated_rows() {
        let model = model();
        let scope = OrganizationScope::single("org-a").unwrap();

        let projects = model
            .list_projects(&scope, PageRequest::new(10).unwrap())
            .unwrap();
        assert_eq!(projects.items[0].url_key, "build-platform");
        assert_eq!(projects.items[0].goal_ids, ["goal-old"]);
        assert_eq!(projects.items[0].goals[0].title, "Old Goal");

        let agents = model
            .list_agents(
                &scope,
                AgentListOptions::default(),
                PageRequest::new(10).unwrap(),
            )
            .unwrap();
        assert_eq!(
            agents
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["agent-active"]
        );
    }

    #[test]
    fn agent_get_preserves_terminated_not_found_only_applies_to_missing_or_foreign_rows() {
        let model = model();
        let scope = OrganizationScope::single("org-a").unwrap();

        let terminated = model.get_agent(&scope, "agent-terminated").unwrap();
        assert_eq!(terminated.status, "terminated");
        assert_eq!(terminated.url_key, "terminated");
        assert!(terminated.agent_runtime_config.is_object());
    }

    #[test]
    fn page_bounds_and_invalid_cursors_fail_closed() {
        assert!(matches!(
            PageRequest::new(0),
            Err(ReadError::InvalidPage { .. })
        ));
        assert!(matches!(
            PageRequest::new(MAX_PAGE_SIZE + 1),
            Err(ReadError::InvalidPage { .. })
        ));
        assert!(matches!(
            PageRequest::with_cursor(1, "not-a-cursor"),
            Err(ReadError::InvalidCursor)
        ));
    }

    #[test]
    fn query_plans_keep_scope_as_a_parameterized_predicate() {
        let scope = OrganizationScope::single("org-a").unwrap();
        let plan = query_plan(EntityKind::Goal, &scope, &PageRequest::new(10).unwrap());

        assert!(plan.sql.contains("org_id = $1"));
        assert!(plan.sql.contains("LIMIT $"));
        assert_eq!(plan.binds.first(), Some(&QueryBind::Text("org-a".into())));
        assert!(!plan.sql.contains("org-a"));
    }
}
