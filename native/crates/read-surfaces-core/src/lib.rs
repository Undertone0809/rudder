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
/// Individual approval responses never contain an unbounded target list.
pub const MAX_APPROVAL_TARGETS: usize = 32;
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
pub struct IssueRow {
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
    pub revision: u64,
    pub fencing_token: u64,
    pub checkout_run_id: Option<String>,
    pub execution_run_id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub hidden_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalTargetRow {
    pub kind: String,
    pub id: String,
    pub identifier: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRow {
    pub id: String,
    pub org_id: String,
    pub approval_type: String,
    pub status: String,
    pub revision: u64,
    pub decision: Option<String>,
    pub requested_by_agent_id: Option<String>,
    pub requested_by_user_id: Option<String>,
    pub decision_note: Option<String>,
    pub decided_by_user_id: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub targets: Vec<ApprovalTargetRow>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFixtures {
    pub organizations: Vec<OrganizationRow>,
    pub goals: Vec<GoalRow>,
    pub projects: Vec<ProjectRow>,
    pub agents: Vec<AgentRow>,
    pub issues: Vec<IssueRow>,
    pub approvals: Vec<ApprovalRow>,
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
    fn issues(&self) -> &[IssueRow] {
        &[]
    }
    fn approvals(&self) -> &[ApprovalRow] {
        &[]
    }
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

    fn issues(&self) -> &[IssueRow] {
        &self.fixtures.issues
    }

    fn approvals(&self) -> &[ApprovalRow] {
        &self.fixtures.approvals
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

pub type IssueListOptions = AgentListOptions;
pub type ApprovalListOptions = AgentListOptions;

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueProjection {
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
    pub revision: u64,
    pub fencing_token: u64,
    pub checkout_run_id: Option<String>,
    pub execution_run_id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub hidden_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalTargetProjection {
    pub kind: String,
    pub id: String,
    pub identifier: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalProjection {
    pub id: String,
    pub org_id: String,
    pub approval_type: String,
    pub status: String,
    pub revision: u64,
    pub decision: Option<String>,
    pub requested_by_agent_id: Option<String>,
    pub requested_by_user_id: Option<String>,
    pub decision_note: Option<String>,
    pub decided_by_user_id: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub targets: Vec<ApprovalTargetProjection>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntityKind {
    Organization,
    Goal,
    Project,
    Agent,
    Issue,
    Approval,
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
        EntityKind::Issue => "issues",
        EntityKind::Approval => "approvals",
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

    pub fn list_issues(
        &self,
        scope: &OrganizationScope,
        options: IssueListOptions,
        page: PageRequest,
    ) -> Result<Page<IssueProjection>, ReadError> {
        let mut rows = self
            .store
            .issues()
            .iter()
            .filter(|row| scope.contains(&row.org_id))
            .filter(|row| options.include_hidden || row.hidden_at.is_none())
            .filter(|row| options.include_terminated || row.status != "terminated")
            .collect::<Vec<_>>();
        sort_rows(&mut rows, |row| (&row.created_at, &row.id));
        let (rows, next_cursor, has_more) =
            page_rows_with_key(rows, &page, |row| (&row.created_at, &row.id));
        Ok(Page {
            items: rows.into_iter().map(project_issue).collect(),
            next_cursor,
            has_more,
        })
    }

    pub fn get_issue(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<IssueProjection, ReadError> {
        self.store
            .issues()
            .iter()
            .find(|row| row.id == id && scope.contains(&row.org_id))
            .map(project_issue)
            .ok_or_else(|| ReadError::NotFound {
                entity: "issue",
                id: id.to_owned(),
            })
    }

    pub fn list_approvals(
        &self,
        scope: &OrganizationScope,
        options: ApprovalListOptions,
        page: PageRequest,
    ) -> Result<Page<ApprovalProjection>, ReadError> {
        let mut rows = self
            .store
            .approvals()
            .iter()
            .filter(|row| scope.contains(&row.org_id))
            .filter(|row| options.include_terminated || row.status != "terminated")
            .collect::<Vec<_>>();
        sort_rows(&mut rows, |row| (&row.created_at, &row.id));
        let (rows, next_cursor, has_more) =
            page_rows_with_key(rows, &page, |row| (&row.created_at, &row.id));
        Ok(Page {
            items: rows.into_iter().map(project_approval).collect(),
            next_cursor,
            has_more,
        })
    }

    pub fn get_approval(
        &self,
        scope: &OrganizationScope,
        id: &str,
    ) -> Result<ApprovalProjection, ReadError> {
        self.store
            .approvals()
            .iter()
            .find(|row| row.id == id && scope.contains(&row.org_id))
            .map(project_approval)
            .ok_or_else(|| ReadError::NotFound {
                entity: "approval",
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

fn project_issue(row: &IssueRow) -> IssueProjection {
    IssueProjection {
        id: row.id.clone(),
        org_id: row.org_id.clone(),
        project_id: row.project_id.clone(),
        goal_id: row.goal_id.clone(),
        issue_number: row.issue_number,
        identifier: row.identifier.clone(),
        title: row.title.clone(),
        description: row.description.clone(),
        status: row.status.clone(),
        priority: row.priority.clone(),
        board_order: row.board_order,
        assignee_agent_id: row.assignee_agent_id.clone(),
        assignee_user_id: row.assignee_user_id.clone(),
        reviewer_agent_id: row.reviewer_agent_id.clone(),
        reviewer_user_id: row.reviewer_user_id.clone(),
        revision: row.revision,
        fencing_token: row.fencing_token,
        checkout_run_id: row.checkout_run_id.clone(),
        execution_run_id: row.execution_run_id.clone(),
        started_at: row.started_at.clone(),
        completed_at: row.completed_at.clone(),
        cancelled_at: row.cancelled_at.clone(),
        hidden_at: row.hidden_at.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    }
}

fn project_approval(row: &ApprovalRow) -> ApprovalProjection {
    ApprovalProjection {
        id: row.id.clone(),
        org_id: row.org_id.clone(),
        approval_type: row.approval_type.clone(),
        status: row.status.clone(),
        revision: row.revision,
        decision: row.decision.clone(),
        requested_by_agent_id: row.requested_by_agent_id.clone(),
        requested_by_user_id: row.requested_by_user_id.clone(),
        decision_note: row.decision_note.clone(),
        decided_by_user_id: row.decided_by_user_id.clone(),
        decided_at: row.decided_at.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        targets: row
            .targets
            .iter()
            .map(|target| ApprovalTargetProjection {
                kind: target.kind.clone(),
                id: target.id.clone(),
                identifier: target.identifier.clone(),
                title: target.title.clone(),
            })
            .collect(),
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
            issues: vec![],
            approvals: vec![],
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

    fn issue(id: &str, org_id: &str, created_at: &str, status: &str, title: &str) -> IssueRow {
        IssueRow {
            id: id.into(),
            org_id: org_id.into(),
            created_at: created_at.into(),
            updated_at: created_at.into(),
            status: status.into(),
            title: title.into(),
            ..Default::default()
        }
    }

    fn approval(id: &str, org_id: &str, created_at: &str) -> ApprovalRow {
        ApprovalRow {
            id: id.into(),
            org_id: org_id.into(),
            approval_type: "issue_action".into(),
            status: "pending".into(),
            created_at: created_at.into(),
            updated_at: created_at.into(),
            targets: vec![ApprovalTargetRow {
                kind: "issue".into(),
                id: "issue-a".into(),
                identifier: Some("RUD-1".into()),
                title: Some("Issue A".into()),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn issue_lists_are_fenced_bounded_and_hide_terminated_rows_by_default() {
        let model = ReadModel::new(InMemoryReadStore::new(ReadFixtures {
            issues: vec![
                issue(
                    "issue-hidden",
                    "org-a",
                    "2026-01-01T00:00:00Z",
                    "todo",
                    "Hidden",
                ),
                IssueRow {
                    hidden_at: Some("2026-01-01T00:00:00Z".into()),
                    ..issue(
                        "issue-hidden-2",
                        "org-a",
                        "2026-01-01T00:00:00Z",
                        "todo",
                        "Hidden 2",
                    )
                },
                issue(
                    "issue-active",
                    "org-a",
                    "2026-01-02T00:00:00Z",
                    "in_progress",
                    "Active",
                ),
                issue(
                    "issue-terminated",
                    "org-a",
                    "2026-01-03T00:00:00Z",
                    "terminated",
                    "Terminated",
                ),
                issue(
                    "issue-foreign",
                    "org-b",
                    "2026-01-01T00:00:00Z",
                    "todo",
                    "Foreign",
                ),
            ],
            ..Default::default()
        }));
        let scope = OrganizationScope::single("org-a").unwrap();

        let page = model
            .list_issues(
                &scope,
                IssueListOptions::default(),
                PageRequest::new(10).unwrap(),
            )
            .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["issue-hidden", "issue-active"]
        );
        assert!(page.items.iter().all(|item| item.org_id == "org-a"));

        let all = model
            .list_issues(
                &scope,
                IssueListOptions {
                    include_hidden: true,
                    include_terminated: true,
                },
                PageRequest::new(10).unwrap(),
            )
            .unwrap();
        assert_eq!(all.items.len(), 4);
        assert!(model.get_issue(&scope, "issue-hidden-2").is_ok());
        assert!(model.get_issue(&scope, "issue-terminated").is_ok());
        assert!(matches!(
            model.get_issue(&scope, "issue-foreign"),
            Err(ReadError::NotFound {
                entity: "issue",
                ..
            })
        ));
    }

    #[test]
    fn issue_pages_use_created_at_and_id_keyset_and_preserve_board_fields() {
        let mut row = issue(
            "issue-a",
            "org-a",
            "2026-01-01T00:00:00Z",
            "in_review",
            "Review me",
        );
        row.priority = "urgent".into();
        row.assignee_agent_id = Some("agent-a".into());
        row.reviewer_user_id = Some("user-a".into());
        row.revision = 7;
        row.fencing_token = 11;
        row.started_at = Some("2026-01-02T00:00:00Z".into());
        row.completed_at = Some("2026-01-03T00:00:00Z".into());
        row.updated_at = "2026-01-04T00:00:00Z".into();
        let model = ReadModel::new(InMemoryReadStore::new(ReadFixtures {
            issues: vec![row],
            ..Default::default()
        }));
        let scope = OrganizationScope::single("org-a").unwrap();
        let page = model
            .list_issues(
                &scope,
                IssueListOptions::default(),
                PageRequest::new(1).unwrap(),
            )
            .unwrap();
        let projection = &page.items[0];
        assert_eq!(projection.status, "in_review");
        assert_eq!(projection.priority, "urgent");
        assert_eq!(projection.assignee_agent_id.as_deref(), Some("agent-a"));
        assert_eq!(projection.reviewer_user_id.as_deref(), Some("user-a"));
        assert_eq!(projection.revision, 7);
        assert_eq!(projection.fencing_token, 11);
        assert_eq!(
            projection.started_at.as_deref(),
            Some("2026-01-02T00:00:00Z")
        );
        assert_eq!(
            projection.completed_at.as_deref(),
            Some("2026-01-03T00:00:00Z")
        );
        assert_eq!(projection.updated_at, "2026-01-04T00:00:00Z");
    }

    #[test]
    fn approval_lists_are_fenced_and_targets_are_projected_without_payload() {
        let model = ReadModel::new(InMemoryReadStore::new(ReadFixtures {
            approvals: vec![
                approval("approval-a", "org-a", "2026-01-01T00:00:00Z"),
                approval("approval-b", "org-b", "2026-01-02T00:00:00Z"),
            ],
            ..Default::default()
        }));
        let scope = OrganizationScope::single("org-a").unwrap();
        let page = model
            .list_approvals(
                &scope,
                ApprovalListOptions::default(),
                PageRequest::new(1).unwrap(),
            )
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].targets[0].id, "issue-a");
        let encoded = serde_json::to_string(&page.items[0]).unwrap();
        assert!(!encoded.contains("payload"));
        assert!(matches!(
            model.get_approval(&scope, "approval-b"),
            Err(ReadError::NotFound {
                entity: "approval",
                ..
            })
        ));
    }
}
