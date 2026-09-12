use rudder_db_core::activity_read::{
    ActivityListFilter, ActivityPageRequest, ActivityProjection, ActivityRunReadRepository,
    MAX_ACTIVITY_PAGE_SIZE, RunListFilter, RunSummaryProjection, TrustedOrganizationScope,
};
use rudder_db_core::{
    AgentListOptions, AgentProjection, ApprovalListOptions, ApprovalProjection, GoalProjection,
    IssueListOptions, IssueProjection, OrganizationProjection, OrganizationScope, Page,
    PageRequest, ProjectProjection, ReadAdapterError, ReadRepository,
};
use rudder_read_surfaces_core::MAX_PAGE_SIZE;
use serde::Deserialize;
use thiserror::Error;

pub const ORGANIZATIONS_LIST_ROUTE: &str = "/internal/read-surfaces/v1/organizations";
pub const ORGANIZATIONS_GET_ROUTE: &str =
    "/internal/read-surfaces/v1/organizations/{organization_id}";
pub const GOALS_LIST_ROUTE: &str = "/internal/read-surfaces/v1/orgs/{org_id}/goals";
pub const GOAL_GET_ROUTE: &str = "/internal/read-surfaces/v1/goals/{goal_id}";
pub const PROJECTS_LIST_ROUTE: &str = "/internal/read-surfaces/v1/orgs/{org_id}/projects";
pub const PROJECT_GET_ROUTE: &str = "/internal/read-surfaces/v1/projects/{project_id}";
pub const AGENTS_LIST_ROUTE: &str = "/internal/read-surfaces/v1/orgs/{org_id}/agents";
pub const AGENT_GET_ROUTE: &str = "/internal/read-surfaces/v1/agents/{agent_id}";
pub const ISSUES_LIST_ROUTE: &str = "/internal/read-surfaces/v1/orgs/{org_id}/issues";
pub const ISSUE_GET_ROUTE: &str = "/internal/read-surfaces/v1/issues/{issue_id}";
pub const APPROVALS_LIST_ROUTE: &str = "/internal/read-surfaces/v1/orgs/{org_id}/approvals";
pub const APPROVAL_GET_ROUTE: &str = "/internal/read-surfaces/v1/approvals/{approval_id}";
pub const ACTIVITY_LIST_ROUTE: &str = "/internal/read-surfaces/v1/orgs/{org_id}/activity";
pub const RUNS_LIST_ROUTE: &str = "/internal/read-surfaces/v1/orgs/{org_id}/runs";

#[derive(Clone)]
pub struct ReadSurfaceAdapter {
    repository: ReadRepository,
    trusted_scope: OrganizationScope,
}

impl ReadSurfaceAdapter {
    pub fn new(repository: ReadRepository, trusted_scope: OrganizationScope) -> Self {
        Self {
            repository,
            trusted_scope,
        }
    }

    /// Narrow a requested organization path without allowing it to expand the
    /// organization set supplied by the authenticated host/runtime.
    pub fn scope_for_org(
        &self,
        organization_id: &str,
    ) -> Result<OrganizationScope, ReadAdapterError> {
        scope_for_requested_org(&self.trusted_scope, organization_id)
    }

    pub async fn list_organizations(
        &self,
        page: PageRequest,
    ) -> Result<Page<OrganizationProjection>, ReadAdapterError> {
        self.repository
            .list_organizations(&self.trusted_scope, page)
            .await
    }

    pub async fn get_organization(
        &self,
        organization_id: &str,
    ) -> Result<OrganizationProjection, ReadAdapterError> {
        self.repository
            .get_organization(&self.trusted_scope, organization_id)
            .await
    }

    pub async fn list_goals(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<GoalProjection>, ReadAdapterError> {
        self.repository.list_goals(scope, page).await
    }

    pub async fn get_goal(&self, goal_id: &str) -> Result<GoalProjection, ReadAdapterError> {
        self.repository.get_goal(&self.trusted_scope, goal_id).await
    }

    pub async fn list_projects(
        &self,
        scope: &OrganizationScope,
        page: PageRequest,
    ) -> Result<Page<ProjectProjection>, ReadAdapterError> {
        self.repository.list_projects(scope, page).await
    }

    pub async fn get_project(
        &self,
        project_id: &str,
    ) -> Result<ProjectProjection, ReadAdapterError> {
        self.repository
            .get_project(&self.trusted_scope, project_id)
            .await
    }

    pub async fn list_agents(
        &self,
        scope: &OrganizationScope,
        options: AgentListOptions,
        page: PageRequest,
    ) -> Result<Page<AgentProjection>, ReadAdapterError> {
        self.repository.list_agents(scope, options, page).await
    }

    pub async fn get_agent(&self, agent_id: &str) -> Result<AgentProjection, ReadAdapterError> {
        self.repository
            .get_agent(&self.trusted_scope, agent_id)
            .await
    }

    pub async fn list_issues(
        &self,
        scope: &OrganizationScope,
        options: IssueListOptions,
        page: PageRequest,
    ) -> Result<Page<IssueProjection>, ReadAdapterError> {
        self.repository.list_issues(scope, options, page).await
    }

    pub async fn get_issue(&self, issue_id: &str) -> Result<IssueProjection, ReadAdapterError> {
        self.repository
            .get_issue(&self.trusted_scope, issue_id)
            .await
    }

    pub async fn list_approvals(
        &self,
        scope: &OrganizationScope,
        options: ApprovalListOptions,
        page: PageRequest,
    ) -> Result<Page<ApprovalProjection>, ReadAdapterError> {
        self.repository.list_approvals(scope, options, page).await
    }

    pub async fn get_approval(
        &self,
        approval_id: &str,
    ) -> Result<ApprovalProjection, ReadAdapterError> {
        self.repository
            .get_approval(&self.trusted_scope, approval_id)
            .await
    }
}

#[derive(Clone)]
pub struct ActivityRunReadAdapter {
    repository: ActivityRunReadRepository,
    trusted_scope: TrustedOrganizationScope,
}

impl ActivityRunReadAdapter {
    pub fn new(repository: ActivityRunReadRepository, trusted_scope: OrganizationScope) -> Self {
        Self {
            repository,
            trusted_scope: TrustedOrganizationScope::from_host(trusted_scope),
        }
    }

    pub async fn list_activity(
        &self,
        organization_id: &str,
        filter: ActivityListFilter,
        page: ActivityPageRequest,
    ) -> Result<Page<ActivityProjection>, ReadAdapterError> {
        let scope = self.scope_for_org(organization_id)?;
        self.repository.list_activity(&scope, filter, page).await
    }

    pub async fn list_runs(
        &self,
        organization_id: &str,
        filter: RunListFilter,
        page: ActivityPageRequest,
    ) -> Result<Page<RunSummaryProjection>, ReadAdapterError> {
        let scope = self.scope_for_org(organization_id)?;
        self.repository.list_runs(&scope, filter, page).await
    }

    fn scope_for_org(
        &self,
        organization_id: &str,
    ) -> Result<TrustedOrganizationScope, ReadAdapterError> {
        scope_for_requested_org(self.trusted_scope.as_scope(), organization_id)
            .map(TrustedOrganizationScope::from_host)
    }
}

pub fn scope_for_requested_org(
    trusted_scope: &OrganizationScope,
    organization_id: &str,
) -> Result<OrganizationScope, ReadAdapterError> {
    if !trusted_scope.contains(organization_id) {
        return Err(ReadAdapterError::NotFound {
            entity: "organization",
            id: organization_id.to_owned(),
        });
    }
    OrganizationScope::single(organization_id).map_err(ReadAdapterError::Contract)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSurfaceQuery {
    pub limit: Option<String>,
    pub cursor: Option<String>,
    pub include_terminated: Option<String>,
    pub include_hidden: Option<String>,
    pub agent_id: Option<String>,
    pub actor_type: Option<String>,
    pub actor_id: Option<String>,
    pub action: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub run_id: Option<String>,
    pub status: Option<String>,
    pub invocation_source: Option<String>,
    pub issue_id: Option<String>,
    pub goal_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ReadSurfaceQueryError {
    #[error("read surface limit must be a positive integer no greater than {MAX_PAGE_SIZE}")]
    Limit,
    #[error("read surface cursor is invalid")]
    Cursor,
    #[error("read surface boolean query parameter is invalid")]
    Boolean,
    #[error("read surface filter is invalid")]
    Filter,
}

impl ReadSurfaceQuery {
    pub fn page(&self) -> Result<PageRequest, ReadSurfaceQueryError> {
        let limit = match self.limit.as_deref() {
            None => MAX_PAGE_SIZE,
            Some(value) => value
                .parse::<usize>()
                .map_err(|_| ReadSurfaceQueryError::Limit)?,
        };
        match self.cursor.as_deref() {
            Some(cursor) => PageRequest::with_cursor(limit, cursor.to_owned())
                .map_err(|_| ReadSurfaceQueryError::Cursor),
            None => PageRequest::new(limit).map_err(|_| ReadSurfaceQueryError::Limit),
        }
    }

    pub fn activity_page(&self) -> Result<ActivityPageRequest, ReadSurfaceQueryError> {
        self.activity_or_run_page()
    }

    pub fn run_page(&self) -> Result<ActivityPageRequest, ReadSurfaceQueryError> {
        self.activity_or_run_page()
    }

    fn activity_or_run_page(&self) -> Result<ActivityPageRequest, ReadSurfaceQueryError> {
        let limit = match self.limit.as_deref() {
            None => MAX_ACTIVITY_PAGE_SIZE,
            Some(value) => value
                .parse::<usize>()
                .map_err(|_| ReadSurfaceQueryError::Limit)?,
        };
        if !(1..=MAX_ACTIVITY_PAGE_SIZE).contains(&limit) {
            return Err(ReadSurfaceQueryError::Limit);
        }
        match self.cursor.as_deref() {
            Some(cursor) => ActivityPageRequest::with_cursor(limit, cursor.to_owned())
                .map_err(|_| ReadSurfaceQueryError::Cursor),
            None => ActivityPageRequest::new(limit).map_err(|_| ReadSurfaceQueryError::Limit),
        }
    }

    pub fn activity_filter(&self) -> Result<ActivityListFilter, ReadSurfaceQueryError> {
        let actor_type = match self.actor_type.as_deref() {
            None => None,
            Some(value @ ("agent" | "user" | "system")) => Some(value.to_owned()),
            Some(_) => return Err(ReadSurfaceQueryError::Filter),
        };
        Ok(ActivityListFilter {
            agent_id: self.agent_id.clone(),
            actor_type,
            actor_id: self.actor_id.clone(),
            action: self.action.clone(),
            entity_type: self.entity_type.clone(),
            entity_id: self.entity_id.clone(),
            run_id: self.run_id.clone(),
        })
    }

    pub fn run_filter(&self) -> Result<RunListFilter, ReadSurfaceQueryError> {
        Ok(RunListFilter {
            agent_id: self.agent_id.clone(),
            status: self.status.clone(),
            invocation_source: self.invocation_source.clone(),
            issue_id: self.issue_id.clone(),
            goal_id: self.goal_id.clone(),
        })
    }

    pub fn agent_options(&self) -> Result<AgentListOptions, ReadSurfaceQueryError> {
        Ok(AgentListOptions {
            include_terminated: optional_bool(self.include_terminated.as_deref())?,
            include_hidden: optional_bool(self.include_hidden.as_deref())?,
        })
    }

    pub fn issue_options(&self) -> Result<IssueListOptions, ReadSurfaceQueryError> {
        Ok(IssueListOptions {
            include_terminated: optional_bool(self.include_terminated.as_deref())?,
            include_hidden: optional_bool(self.include_hidden.as_deref())?,
        })
    }

    pub fn approval_options(&self) -> Result<ApprovalListOptions, ReadSurfaceQueryError> {
        Ok(ApprovalListOptions {
            include_terminated: optional_bool(self.include_terminated.as_deref())?,
            include_hidden: optional_bool(self.include_hidden.as_deref())?,
        })
    }
}

fn optional_bool(value: Option<&str>) -> Result<bool, ReadSurfaceQueryError> {
    match value {
        None => Ok(false),
        Some("1" | "true" | "TRUE" | "yes" | "YES") => Ok(true),
        Some("0" | "false" | "FALSE" | "no" | "NO") => Ok(false),
        Some(_) => Err(ReadSurfaceQueryError::Boolean),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_scope_is_narrowed_to_the_trusted_organization() {
        let trusted = OrganizationScope::many(["org-a", "org-b"]).expect("trusted scope");
        let narrowed = scope_for_requested_org(&trusted, "org-a").expect("narrowed scope");

        assert!(narrowed.contains("org-a"));
        assert!(!narrowed.contains("org-b"));
    }

    #[test]
    fn requested_scope_rejects_a_foreign_organization() {
        let trusted = OrganizationScope::single("org-a").expect("trusted scope");

        assert!(matches!(
            scope_for_requested_org(&trusted, "org-b"),
            Err(ReadAdapterError::NotFound {
                entity: "organization",
                ..
            })
        ));
    }

    #[test]
    fn query_defaults_to_the_bounded_page_and_rejects_invalid_cursor() {
        let query = ReadSurfaceQuery::default();
        assert_eq!(query.page().expect("default page").limit(), MAX_PAGE_SIZE);

        let invalid = ReadSurfaceQuery {
            cursor: Some("not-a-cursor".into()),
            ..Default::default()
        };
        assert_eq!(invalid.page(), Err(ReadSurfaceQueryError::Cursor));
    }

    #[test]
    fn agent_options_are_explicit_and_fail_closed() {
        let query = ReadSurfaceQuery {
            include_terminated: Some("true".into()),
            include_hidden: Some("1".into()),
            ..Default::default()
        };
        assert_eq!(
            query.agent_options().expect("agent options"),
            AgentListOptions {
                include_terminated: true,
                include_hidden: true,
            }
        );

        let invalid = ReadSurfaceQuery {
            include_hidden: Some("maybe".into()),
            ..Default::default()
        };
        assert_eq!(invalid.agent_options(), Err(ReadSurfaceQueryError::Boolean));
    }

    #[test]
    fn activity_and_run_queries_are_bounded_and_map_only_supported_filters() {
        let query = ReadSurfaceQuery {
            limit: Some("100".into()),
            agent_id: Some("agent-1".into()),
            actor_type: Some("agent".into()),
            actor_id: Some("actor-1".into()),
            action: Some("issue.updated".into()),
            entity_type: Some("issue".into()),
            entity_id: Some("issue-1".into()),
            run_id: Some("run-1".into()),
            status: Some("succeeded".into()),
            invocation_source: Some("heartbeat".into()),
            issue_id: Some("issue-1".into()),
            goal_id: Some("goal-1".into()),
            ..Default::default()
        };

        assert_eq!(query.activity_page().expect("activity page").limit(), 100);
        assert_eq!(query.run_page().expect("run page").limit(), 100);
        assert_eq!(
            query.activity_filter().expect("activity filter"),
            ActivityListFilter {
                agent_id: Some("agent-1".into()),
                actor_type: Some("agent".into()),
                actor_id: Some("actor-1".into()),
                action: Some("issue.updated".into()),
                entity_type: Some("issue".into()),
                entity_id: Some("issue-1".into()),
                run_id: Some("run-1".into()),
            }
        );
        assert_eq!(
            query.run_filter().expect("run filter"),
            RunListFilter {
                agent_id: Some("agent-1".into()),
                status: Some("succeeded".into()),
                invocation_source: Some("heartbeat".into()),
                issue_id: Some("issue-1".into()),
                goal_id: Some("goal-1".into()),
            }
        );

        let too_large = ReadSurfaceQuery {
            limit: Some("101".into()),
            ..Default::default()
        };
        assert_eq!(too_large.activity_page(), Err(ReadSurfaceQueryError::Limit));
        assert_eq!(too_large.run_page(), Err(ReadSurfaceQueryError::Limit));
    }

    #[test]
    fn activity_actor_type_rejects_unknown_values() {
        let query = ReadSurfaceQuery {
            actor_type: Some("admin".into()),
            ..Default::default()
        };
        assert_eq!(query.activity_filter(), Err(ReadSurfaceQueryError::Filter));
    }
}
