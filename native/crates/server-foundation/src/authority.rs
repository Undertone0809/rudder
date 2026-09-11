use rudder_authority_core::{
    AUTHORITY_PROTOCOL_VERSION, AUTHORITY_SCHEMA, AuthorityError, ComponentAuthority,
    MigrationAuthority, OwnerId, RouteClaim, RouteDecision,
};
use serde::Serialize;
use thiserror::Error;

pub const AUTHORITY_RECEIPT_SCHEMA: &str = "rudder.native.server.route-authority.v1";
pub const AUTHORITY_ENDPOINT: &str = "/v1/authority";
pub const AUTHORITY_COMPONENT: &str = "server-foundation";
pub const LEGACY_COMPONENT: &str = "node-product-api";
pub const LEGACY_COMPONENT_VERSION: &str = "node-authoritative";

const FIXED_AUTHORITY_EPOCH: u64 = 1;
const MAX_QUERY_BYTES: usize = 512;
const MAX_SELECTOR_BYTES: usize = 256;

#[derive(Clone, Copy)]
struct RouteSpec {
    route_id: &'static str,
    path: &'static str,
    claim: &'static str,
    scope: &'static str,
    owner: &'static str,
}

// This is an adapter inventory, not a product route registry. The native
// foundation entries are loopback-only, while the two legacy entries explicitly
// record the Node-owned public listener boundaries that this process does not
// replace.
const ROUTE_SPECS: &[RouteSpec] = &[
    RouteSpec {
        route_id: "foundation.health",
        path: "/healthz",
        claim: "/healthz",
        scope: "loopback foundation health",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.readiness",
        path: "/readyz",
        claim: "/readyz",
        scope: "loopback foundation readiness",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.capabilities",
        path: "/v1/capabilities",
        claim: "/v1/capabilities",
        scope: "loopback foundation capabilities",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.authority",
        path: AUTHORITY_ENDPOINT,
        claim: AUTHORITY_ENDPOINT,
        scope: "loopback authority introspection",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.workspace_backup_list",
        path: "/api/orgs/{org_id}/workspace/backups",
        claim: "/api/orgs/{org_id}/workspace/backups",
        scope: "loopback read-only workspace backup list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.workspace_backup_files_list",
        path: "/api/orgs/{org_id}/workspace/backups/{backup_id}/files",
        claim: "/api/orgs/{org_id}/workspace/backups/{backup_id}/files",
        scope: "loopback read-only workspace backup files",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.workspace_backup_file_read",
        path: "/api/orgs/{org_id}/workspace/backups/{backup_id}/file",
        claim: "/api/orgs/{org_id}/workspace/backups/{backup_id}/file",
        scope: "loopback read-only workspace backup file",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.workspace_backup_download",
        path: "/api/orgs/{org_id}/workspace/backups/{backup_id}/download",
        claim: "/api/orgs/{org_id}/workspace/backups/{backup_id}/download",
        scope: "loopback read-only workspace backup download",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.organizations_read_list",
        path: "/internal/read-surfaces/v1/organizations",
        claim: "/internal/read-surfaces/v1/organizations",
        scope: "loopback read-only organization list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.organization_read_get",
        path: "/internal/read-surfaces/v1/organizations/{organization_id}",
        claim: "/internal/read-surfaces/v1/organizations/{organization_id}",
        scope: "loopback read-only organization get",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.goals_read_list",
        path: "/internal/read-surfaces/v1/orgs/{org_id}/goals",
        claim: "/internal/read-surfaces/v1/orgs/{org_id}/goals",
        scope: "loopback read-only goal list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.goal_read_get",
        path: "/internal/read-surfaces/v1/goals/{goal_id}",
        claim: "/internal/read-surfaces/v1/goals/{goal_id}",
        scope: "loopback read-only goal get",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.projects_read_list",
        path: "/internal/read-surfaces/v1/orgs/{org_id}/projects",
        claim: "/internal/read-surfaces/v1/orgs/{org_id}/projects",
        scope: "loopback read-only project list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.project_read_get",
        path: "/internal/read-surfaces/v1/projects/{project_id}",
        claim: "/internal/read-surfaces/v1/projects/{project_id}",
        scope: "loopback read-only project get",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.agents_read_list",
        path: "/internal/read-surfaces/v1/orgs/{org_id}/agents",
        claim: "/internal/read-surfaces/v1/orgs/{org_id}/agents",
        scope: "loopback read-only agent list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.agent_read_get",
        path: "/internal/read-surfaces/v1/agents/{agent_id}",
        claim: "/internal/read-surfaces/v1/agents/{agent_id}",
        scope: "loopback read-only agent get",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.issues_read_list",
        path: "/internal/read-surfaces/v1/orgs/{org_id}/issues",
        claim: "/internal/read-surfaces/v1/orgs/{org_id}/issues",
        scope: "loopback read-only issue list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.issue_read_get",
        path: "/internal/read-surfaces/v1/issues/{issue_id}",
        claim: "/internal/read-surfaces/v1/issues/{issue_id}",
        scope: "loopback read-only issue get",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.approvals_read_list",
        path: "/internal/read-surfaces/v1/orgs/{org_id}/approvals",
        claim: "/internal/read-surfaces/v1/orgs/{org_id}/approvals",
        scope: "loopback read-only approval list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.approval_read_get",
        path: "/internal/read-surfaces/v1/approvals/{approval_id}",
        claim: "/internal/read-surfaces/v1/approvals/{approval_id}",
        scope: "loopback read-only approval get",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.activity_read_list",
        path: "/internal/read-surfaces/v1/orgs/{org_id}/activity",
        claim: "/internal/read-surfaces/v1/orgs/{org_id}/activity",
        scope: "loopback read-only activity list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "foundation.runs_read_list",
        path: "/internal/read-surfaces/v1/orgs/{org_id}/runs",
        claim: "/internal/read-surfaces/v1/orgs/{org_id}/runs",
        scope: "loopback read-only run list",
        owner: "rust",
    },
    RouteSpec {
        route_id: "node.product_http",
        path: "node-public-product-http",
        claim: "node.product_http",
        scope: "Node public product HTTP routes remain authoritative",
        owner: "legacy",
    },
    RouteSpec {
        route_id: "node.product_websocket",
        path: "node-public-product-websocket",
        claim: "node.product_websocket",
        scope: "Node public product WebSocket routes remain authoritative",
        owner: "legacy",
    },
];

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AuthorityAdapterError {
    #[error(transparent)]
    Core(#[from] AuthorityError),
    #[error("authority inventory is invalid")]
    InvalidAuthority,
    #[error("authority route is not registered")]
    UnknownRoute,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityRouteReceipt {
    pub route_id: &'static str,
    pub path: &'static str,
    pub scope: &'static str,
    pub decision: &'static str,
    pub owner: &'static str,
    pub component: String,
    pub component_version: String,
    pub authority_epoch: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReceipt {
    pub schema: &'static str,
    pub authority_schema: &'static str,
    pub protocol_version: u16,
    pub status: &'static str,
    pub component: &'static str,
    pub component_version: &'static str,
    pub public_listener: bool,
    pub product_write_authority: bool,
    pub node_authority_unchanged: bool,
    pub routes: Vec<AuthorityRouteReceipt>,
    pub selected_route: Option<AuthorityRouteReceipt>,
}

#[derive(Clone)]
pub struct AuthorityRegistry {
    inventory: MigrationAuthority,
}

impl AuthorityRegistry {
    pub fn fixed() -> Result<Self, AuthorityAdapterError> {
        let rust_owner = OwnerId::rust();
        let legacy_owner = OwnerId::legacy();
        let rust_authority = ComponentAuthority::at_epoch(
            AUTHORITY_COMPONENT,
            env!("CARGO_PKG_VERSION"),
            rust_owner.clone(),
            FIXED_AUTHORITY_EPOCH,
        )?;
        let legacy_authority = ComponentAuthority::at_epoch(
            LEGACY_COMPONENT,
            LEGACY_COMPONENT_VERSION,
            legacy_owner.clone(),
            FIXED_AUTHORITY_EPOCH,
        )?;
        let routes = ROUTE_SPECS
            .iter()
            .map(|spec| {
                RouteClaim::new(
                    spec.claim,
                    if spec.owner == "rust" {
                        AUTHORITY_COMPONENT
                    } else {
                        LEGACY_COMPONENT
                    },
                    if spec.owner == "rust" {
                        rust_owner.clone()
                    } else {
                        legacy_owner.clone()
                    },
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        Self::from_inventory(MigrationAuthority::from_parts(
            vec![rust_authority, legacy_authority],
            routes,
        ))
    }

    pub fn from_inventory(inventory: MigrationAuthority) -> Result<Self, AuthorityAdapterError> {
        let registry = Self { inventory };
        registry.validate()?;
        Ok(registry)
    }

    pub fn receipt(
        &self,
        selected_route: Option<&str>,
    ) -> Result<AuthorityReceipt, AuthorityAdapterError> {
        self.validate()?;
        let routes = ROUTE_SPECS
            .iter()
            .map(|spec| self.route_receipt(spec))
            .collect::<Result<Vec<_>, _>>()?;
        let selected_route = selected_route
            .map(|selector| {
                let spec = ROUTE_SPECS
                    .iter()
                    .find(|spec| {
                        spec.route_id == selector || spec.path == selector || spec.claim == selector
                    })
                    .ok_or(AuthorityAdapterError::UnknownRoute)?;
                self.route_receipt(spec)
            })
            .transpose()?;
        Ok(AuthorityReceipt {
            schema: AUTHORITY_RECEIPT_SCHEMA,
            authority_schema: AUTHORITY_SCHEMA,
            protocol_version: AUTHORITY_PROTOCOL_VERSION,
            status: "ready",
            component: AUTHORITY_COMPONENT,
            component_version: env!("CARGO_PKG_VERSION"),
            public_listener: false,
            product_write_authority: false,
            node_authority_unchanged: true,
            routes,
            selected_route,
        })
    }

    fn validate(&self) -> Result<(), AuthorityAdapterError> {
        self.inventory.validate()?;
        for authority in &self.inventory.authorities {
            if authority.epoch != FIXED_AUTHORITY_EPOCH {
                return Err(AuthorityAdapterError::InvalidAuthority);
            }
            let expected = ComponentAuthority::at_epoch(
                authority.component.clone(),
                authority.component_version.clone(),
                authority.owner.clone(),
                authority.epoch,
            )?;
            if expected.fencing_token != authority.fencing_token {
                return Err(AuthorityAdapterError::InvalidAuthority);
            }
        }
        Ok(())
    }

    fn route_receipt(
        &self,
        spec: &RouteSpec,
    ) -> Result<AuthorityRouteReceipt, AuthorityAdapterError> {
        let decision = self.inventory.route_decision(spec.claim);
        let (decision, authority) = match decision {
            RouteDecision::Rust { authority } => ("rust", authority),
            RouteDecision::PrivateLegacyBridge { authority } => ("legacy", authority),
            RouteDecision::Reject { .. } => return Err(AuthorityAdapterError::InvalidAuthority),
        };
        Ok(AuthorityRouteReceipt {
            route_id: spec.route_id,
            path: spec.path,
            scope: spec.scope,
            decision,
            owner: spec.owner,
            component: authority.component,
            component_version: authority.component_version,
            authority_epoch: authority.epoch,
        })
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("malformed authority query")]
pub struct AuthorityQueryError;

pub fn parse_route_selector(query: &str) -> Result<Option<String>, AuthorityQueryError> {
    if query.is_empty() {
        return Ok(None);
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(AuthorityQueryError);
    }
    let mut selector = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(AuthorityQueryError);
        };
        if key != "route" || selector.is_some() {
            return Err(AuthorityQueryError);
        }
        let value = percent_decode(value)?;
        if value.is_empty() || value.len() > MAX_SELECTOR_BYTES {
            return Err(AuthorityQueryError);
        }
        if value.chars().any(|character| character.is_ascii_control()) {
            return Err(AuthorityQueryError);
        }
        selector = Some(value);
    }
    Ok(selector)
}

fn percent_decode(value: &str) -> Result<String, AuthorityQueryError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1]).ok_or(AuthorityQueryError)?;
                let low = hex_value(bytes[index + 2]).ok_or(AuthorityQueryError)?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            b'%' => return Err(AuthorityQueryError),
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| AuthorityQueryError)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_inventory_has_both_rust_and_legacy_decisions_without_fences() {
        let registry = AuthorityRegistry::fixed().expect("fixed authority inventory");
        let receipt = registry.receipt(None).expect("authority receipt");
        assert_eq!(receipt.routes.len(), 24);
        assert!(receipt.routes.iter().any(|route| route.decision == "rust"));
        assert!(
            receipt
                .routes
                .iter()
                .any(|route| route.decision == "legacy")
        );
        assert!(
            !serde_json::to_string(&receipt)
                .expect("serialize authority receipt")
                .contains("fencingToken")
        );
    }

    #[test]
    fn malformed_and_unknown_selectors_fail_closed() {
        assert!(parse_route_selector("route=").is_err());
        assert!(parse_route_selector("route=%2Fhealthz&route=%2Freadyz").is_err());
        assert!(parse_route_selector("owner=legacy").is_err());
        let registry = AuthorityRegistry::fixed().expect("fixed authority inventory");
        assert!(matches!(
            registry.receipt(Some("/not-registered")),
            Err(AuthorityAdapterError::UnknownRoute)
        ));
    }

    #[test]
    fn invalid_fence_and_stale_epoch_are_not_introspectable() {
        let mut inventory = AuthorityRegistry::fixed()
            .expect("fixed authority inventory")
            .inventory;
        inventory.authorities[0].fencing_token = "0".repeat(64);
        assert!(matches!(
            AuthorityRegistry::from_inventory(inventory),
            Err(AuthorityAdapterError::InvalidAuthority)
        ));

        let mut inventory = AuthorityRegistry::fixed()
            .expect("fixed authority inventory")
            .inventory;
        inventory.authorities[0].epoch = 2;
        assert!(matches!(
            AuthorityRegistry::from_inventory(inventory),
            Err(AuthorityAdapterError::InvalidAuthority)
        ));

        let mut inventory = AuthorityRegistry::fixed()
            .expect("fixed authority inventory")
            .inventory;
        inventory.routes.push(inventory.routes[0].clone());
        assert!(AuthorityRegistry::from_inventory(inventory).is_err());

        let mut inventory = AuthorityRegistry::fixed()
            .expect("fixed authority inventory")
            .inventory;
        inventory.authorities[0].owner = OwnerId::new("unknown").expect("valid owner text");
        assert!(AuthorityRegistry::from_inventory(inventory).is_err());
    }
}
