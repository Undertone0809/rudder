use std::{collections::BTreeMap, path::PathBuf};

use rudder_read_surfaces_core::OrganizationScope;
use rudder_run_evidence_core::{EvidenceReadPage, MAX_READ_BYTES, ReadError, read_run_log_range};
use serde::Deserialize;
use thiserror::Error;

pub const EVIDENCE_READ_ROUTE: &str =
    "/internal/read-surfaces/v1/orgs/{org_id}/runs/{run_id}/evidence";
pub const DEFAULT_EVIDENCE_READ_BYTES: u64 = 256 * 1024;
pub const MAX_EVIDENCE_READ_BYTES: u64 = MAX_READ_BYTES;

/// A filesystem capability issued by the trusted host for exactly one run.
///
/// The HTTP request never supplies the path. The host constructs this value
/// after resolving the run's organization and local evidence handle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedRunEvidence {
    organization_id: String,
    run_id: String,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum EvidenceConfigError {
    #[error("evidence capability organization and run ids must be non-empty")]
    EmptyIdentity,
    #[error("evidence capability path must be absolute")]
    RelativePath,
    #[error("evidence capability is outside the trusted organization scope")]
    ForeignOrganization,
    #[error("duplicate evidence capability for the same organization and run")]
    DuplicateIdentity,
}

impl TrustedRunEvidence {
    pub fn from_host(
        organization_id: impl Into<String>,
        run_id: impl Into<String>,
        path: PathBuf,
    ) -> Result<Self, EvidenceConfigError> {
        let organization_id = organization_id.into();
        let run_id = run_id.into();
        if organization_id.trim().is_empty() || run_id.trim().is_empty() {
            return Err(EvidenceConfigError::EmptyIdentity);
        }
        if !path.is_absolute() {
            return Err(EvidenceConfigError::RelativePath);
        }
        Ok(Self {
            organization_id,
            run_id,
            path,
        })
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum EvidenceReadError {
    #[error("evidence run was not found in the trusted organization scope")]
    NotFound,
    #[error("evidence read request is invalid")]
    InvalidRequest,
    #[error("evidence input is invalid")]
    InvalidInput,
    #[error("evidence read failed")]
    Backend,
}

impl From<ReadError> for EvidenceReadError {
    fn from(error: ReadError) -> Self {
        match error.code() {
            "evidence_read_not_found" => Self::NotFound,
            "evidence_read_limit_invalid" => Self::InvalidRequest,
            "evidence_read_input_invalid" | "evidence_read_invalid_utf8" => Self::InvalidInput,
            _ => Self::Backend,
        }
    }
}

/// Private adapter that resolves only host-issued run capabilities.
#[derive(Clone)]
pub struct EvidenceReadAdapter {
    trusted_scope: OrganizationScope,
    capabilities: BTreeMap<(String, String), PathBuf>,
}

impl EvidenceReadAdapter {
    pub fn new(
        trusted_scope: OrganizationScope,
        capabilities: Vec<TrustedRunEvidence>,
    ) -> Result<Self, EvidenceConfigError> {
        let mut indexed = BTreeMap::new();
        for capability in capabilities {
            if !trusted_scope.contains(&capability.organization_id) {
                return Err(EvidenceConfigError::ForeignOrganization);
            }
            if indexed
                .insert(
                    (capability.organization_id, capability.run_id),
                    capability.path,
                )
                .is_some()
            {
                return Err(EvidenceConfigError::DuplicateIdentity);
            }
        }
        Ok(Self {
            trusted_scope,
            capabilities: indexed,
        })
    }

    pub fn path_for(
        &self,
        organization_id: &str,
        run_id: &str,
    ) -> Result<PathBuf, EvidenceReadError> {
        if !self.trusted_scope.contains(organization_id) {
            return Err(EvidenceReadError::NotFound);
        }
        self.capabilities
            .get(&(organization_id.to_owned(), run_id.to_owned()))
            .cloned()
            .ok_or(EvidenceReadError::NotFound)
    }

    pub fn read(
        &self,
        organization_id: &str,
        run_id: &str,
        request: EvidenceReadRequest,
    ) -> Result<EvidenceReadPage, EvidenceReadError> {
        let path = self.path_for(organization_id, run_id)?;
        read_run_log_range(&path, request.offset, request.limit_bytes).map_err(Into::into)
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReadQuery {
    pub offset: Option<String>,
    pub limit_bytes: Option<String>,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum EvidenceReadQueryError {
    #[error("evidence offset must be an unsigned integer")]
    Offset,
    #[error("evidence limitBytes must be between 1 and {MAX_EVIDENCE_READ_BYTES}")]
    Limit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EvidenceReadRequest {
    pub offset: u64,
    pub limit_bytes: u64,
}

impl EvidenceReadQuery {
    pub fn parse(&self) -> Result<EvidenceReadRequest, EvidenceReadQueryError> {
        let offset = match self.offset.as_deref() {
            None => 0,
            Some(value) => value
                .parse::<u64>()
                .map_err(|_| EvidenceReadQueryError::Offset)?,
        };
        let limit_bytes = match self.limit_bytes.as_deref() {
            None => DEFAULT_EVIDENCE_READ_BYTES,
            Some(value) => value
                .parse::<u64>()
                .map_err(|_| EvidenceReadQueryError::Limit)?,
        };
        if !(1..=MAX_EVIDENCE_READ_BYTES).contains(&limit_bytes) {
            return Err(EvidenceReadQueryError::Limit);
        }
        Ok(EvidenceReadRequest {
            offset,
            limit_bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn host_capability_is_bound_to_one_organization_and_run() {
        let root = tempdir().expect("evidence root");
        let path = root.path().join("run.ndjson");
        let capability = TrustedRunEvidence::from_host("org-a", "run-a", path.clone())
            .expect("trusted evidence capability");
        let adapter = EvidenceReadAdapter::new(
            OrganizationScope::single("org-a").expect("trusted organization scope"),
            vec![capability],
        )
        .expect("evidence adapter");

        assert_eq!(adapter.path_for("org-a", "run-a").unwrap(), path);
        assert_eq!(
            adapter.path_for("org-a", "run-b"),
            Err(EvidenceReadError::NotFound)
        );
        assert_eq!(
            adapter.path_for("org-b", "run-a"),
            Err(EvidenceReadError::NotFound)
        );
    }

    #[test]
    fn host_capability_rejects_relative_paths_and_foreign_scope() {
        assert!(
            TrustedRunEvidence::from_host("org-a", "run-a", PathBuf::from("run.ndjson")).is_err()
        );
        assert!(
            TrustedRunEvidence::from_host("", "run-a", PathBuf::from("/tmp/run.ndjson")).is_err()
        );
        assert!(
            TrustedRunEvidence::from_host("org-a", "", PathBuf::from("/tmp/run.ndjson")).is_err()
        );

        let capability =
            TrustedRunEvidence::from_host("org-b", "run-a", PathBuf::from("/tmp/run.ndjson"))
                .expect("capability identity");
        assert!(matches!(
            EvidenceReadAdapter::new(
                OrganizationScope::single("org-a").expect("trusted organization scope"),
                vec![capability],
            ),
            Err(EvidenceConfigError::ForeignOrganization)
        ));
    }

    #[test]
    fn evidence_query_is_bounded_and_defaults_the_offset_and_limit() {
        let default = EvidenceReadQuery::default()
            .parse()
            .expect("default evidence query");
        assert_eq!(default.offset, 0);
        assert_eq!(default.limit_bytes, DEFAULT_EVIDENCE_READ_BYTES);

        let query = EvidenceReadQuery {
            offset: Some("4".into()),
            limit_bytes: Some("1024".into()),
        }
        .parse()
        .expect("bounded evidence query");
        assert_eq!(query.offset, 4);
        assert_eq!(query.limit_bytes, 1024);

        for invalid in [
            EvidenceReadQuery {
                offset: Some("-1".into()),
                ..Default::default()
            },
            EvidenceReadQuery {
                limit_bytes: Some("0".into()),
                ..Default::default()
            },
            EvidenceReadQuery {
                limit_bytes: Some("1000001".into()),
                ..Default::default()
            },
            EvidenceReadQuery {
                offset: Some("not-a-number".into()),
                ..Default::default()
            },
        ] {
            assert!(invalid.parse().is_err());
        }
    }

    #[test]
    fn evidence_reads_only_the_host_resolved_file() {
        let root = tempdir().expect("evidence root");
        let path = root.path().join("run.ndjson");
        std::fs::write(
            &path,
            b"{\"ts\":\"2026-09-11T00:00:00Z\",\"stream\":\"stdout\",\"chunk\":\"hello\"}\n",
        )
        .expect("write evidence");
        let capability = TrustedRunEvidence::from_host("org-a", "run-a", path)
            .expect("trusted evidence capability");
        let adapter = EvidenceReadAdapter::new(
            OrganizationScope::single("org-a").expect("trusted organization scope"),
            vec![capability],
        )
        .expect("evidence adapter");

        let page = adapter
            .read(
                "org-a",
                "run-a",
                EvidenceReadQuery::default().parse().unwrap(),
            )
            .expect("read evidence");
        assert!(page.content.contains("hello"));
        assert!(
            adapter
                .read(
                    "org-b",
                    "run-a",
                    EvidenceReadRequest {
                        offset: 0,
                        limit_bytes: 4
                    }
                )
                .is_err()
        );
    }
}
