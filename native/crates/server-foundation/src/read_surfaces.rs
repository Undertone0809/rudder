use rudder_db_core::{
    AgentListOptions, AgentProjection, GoalProjection, OrganizationProjection, OrganizationScope,
    Page, PageRequest, ProjectProjection, ReadAdapterError, ReadRepository,
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
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ReadSurfaceQueryError {
    #[error("read surface limit must be a positive integer no greater than {MAX_PAGE_SIZE}")]
    Limit,
    #[error("read surface cursor is invalid")]
    Cursor,
    #[error("read surface boolean query parameter is invalid")]
    Boolean,
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

    pub fn agent_options(&self) -> Result<AgentListOptions, ReadSurfaceQueryError> {
        Ok(AgentListOptions {
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
}
