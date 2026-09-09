#![cfg(feature = "test-support")]

use rudder_db_core::issue_mutation::{
    ApprovalQueryPlans, ApprovalResubmissionOptions, CheckoutOptions, HostApprovalCapability,
    IssueMutationError, MutationBind, MutationQueryPlan, ReviewQueryPlans,
    TrustedApprovalAuthorization, TrustedOrganizationId, approval_decision_query_plans,
    approval_resubmission_query_plans, checkout_query_plans, command_fingerprint,
    review_decision_query_plans,
};
use rudder_issue_core::{
    ActorRef, AgentId, ApprovalDecision, ApprovalDecisionCommand, ApprovalId, ApprovalRef,
    CheckoutCommand, IdempotencyKey, IssueId, IssueRef, IssueStatus, OrganizationId,
    ReviewDecision, ReviewDecisionCommand, RunId,
};
use serde_json::Value;
use time::{Duration, OffsetDateTime};

fn scope(value: &str) -> TrustedOrganizationId {
    TrustedOrganizationId::from_host(OrganizationId::new(value))
}

fn issue_ref(org: &str, issue: &str) -> IssueRef {
    IssueRef::new(OrganizationId::new(org), IssueId::new(issue))
}

fn checkout_command() -> CheckoutCommand {
    let org = OrganizationId::new("org-client");
    let agent = AgentId::new("00000000-0000-0000-0000-000000000002");
    let run = RunId::new("00000000-0000-0000-0000-000000000003");
    CheckoutCommand::new(
        issue_ref("org-client", "00000000-0000-0000-0000-000000000001"),
        ActorRef::agent(org, agent.clone(), Some(run.clone())),
        agent,
        Some(run),
        [IssueStatus::Todo],
        7,
        11,
        IdempotencyKey::new("checkout-key"),
    )
}

fn assert_parameterized(plan: &MutationQueryPlan, values: &[&str]) {
    for value in values {
        assert!(
            !plan.sql.contains(value),
            "query leaked bound value {value:?}: {}",
            plan.sql
        );
    }
    assert!(
        plan.sql.contains('$'),
        "query has no bind placeholders: {}",
        plan.sql
    );
}

#[test]
fn checkout_query_plans_use_the_trusted_host_scope_and_fence_every_write() {
    let command = checkout_command();
    let options =
        CheckoutOptions::with_lease(12, Some(OffsetDateTime::UNIX_EPOCH + Duration::hours(1)));
    let plans = checkout_query_plans(&scope("org-client"), &command, &options).unwrap();

    for plan in [
        &plans.reserve_ledger,
        &plans.load_issue,
        &plans.update_issue,
        &plans.insert_activity,
        &plans.finalize_ledger,
    ] {
        assert_parameterized(
            plan,
            &[
                "org-client",
                "00000000-0000-0000-0000-000000000001",
                "00000000-0000-0000-0000-000000000002",
                "00000000-0000-0000-0000-000000000003",
                "checkout-key",
            ],
        );
        assert!(
            matches!(plan.binds.first(), Some(MutationBind::Uuid(value)) if value == "org-client"),
            "the first bind must be the host organization: {:?}",
            plan.binds
        );
    }

    assert!(
        plans
            .reserve_ledger
            .sql
            .contains("ON CONFLICT (org_id, idempotency_key) DO NOTHING")
    );
    assert!(plans.reserve_ledger.sql.contains("$5::jsonb"));
    assert!(matches!(
        plans.reserve_ledger.binds.get(4),
        Some(MutationBind::Json(value)) if value.get("state").and_then(Value::as_str) == Some("pending")
    ));
    assert!(plans.load_issue.sql.contains("i.org_id = $1::uuid"));
    assert!(plans.load_issue.sql.contains("i.id = $2::uuid"));
    assert_parameterized(
        &plans.validate_run,
        &[
            "org-client",
            "00000000-0000-0000-0000-000000000002",
            "00000000-0000-0000-0000-000000000003",
        ],
    );
    assert!(plans.validate_run.sql.contains("FROM heartbeat_runs"));
    assert!(plans.validate_run.sql.contains("r.agent_id = $3::uuid"));
    assert!(plans.validate_run.sql.contains("JOIN agents AS a"));
    assert!(plans.validate_run.sql.contains("a.org_id = r.org_id"));
    assert!(plans.validate_run.sql.contains("FOR SHARE"));
    assert!(plans.load_issue.sql.contains("FOR UPDATE"));
    assert!(plans.update_issue.sql.contains("i.revision = $3::int8"));
    assert!(
        plans
            .update_issue
            .sql
            .contains("i.fencing_token = $4::int8")
    );
    assert!(plans.update_issue.sql.contains("i.checkout_run_id IS NULL"));
    assert!(
        plans
            .update_issue
            .sql
            .contains("i.execution_run_id IS NULL")
    );
    assert!(
        plans
            .update_issue
            .sql
            .contains("i.checkout_lease_owner IS NULL")
    );
    assert!(
        plans
            .update_issue
            .sql
            .contains("i.checkout_lease_expires_at IS NULL")
    );
    assert!(plans.update_issue.sql.contains("fencing_token = $5::int8"));
    assert!(matches!(
        plans.update_issue.binds.get(5),
        Some(MutationBind::Uuid(value)) if value == "00000000-0000-0000-0000-000000000003"
    ));
    assert!(matches!(
        plans.update_issue.binds.get(6),
        Some(MutationBind::Text(value)) if value == "00000000-0000-0000-0000-000000000002"
    ));
    assert!(plans.insert_activity.sql.contains("idempotency_key"));
    assert!(plans.finalize_ledger.sql.contains("issue_id = $3::uuid"));
    assert!(plans.finalize_ledger.sql.contains("activity_id = $5::uuid"));
}

#[test]
fn checkout_query_plans_require_a_run_before_any_execution() {
    let mut command = checkout_command();
    command.run_id = None;
    let error = checkout_query_plans(&scope("org-client"), &command, &CheckoutOptions::new(12))
        .unwrap_err();
    assert!(matches!(
        error,
        IssueMutationError::Domain(rudder_issue_core::DomainError::CheckoutRunRequired)
    ));
}

#[test]
fn client_supplied_organization_cannot_choose_the_scope() {
    let command = checkout_command();
    let error =
        checkout_query_plans(&scope("org-host"), &command, &CheckoutOptions::new(12)).unwrap_err();
    assert!(matches!(
        error,
        IssueMutationError::Domain(rudder_issue_core::DomainError::CrossOrganization { .. })
    ));
}

#[test]
fn command_fingerprints_are_stable_and_change_when_the_command_changes() {
    let command = checkout_command();
    let scope = scope("org-client");
    let first = command_fingerprint(
        "issue.checkout",
        &scope,
        &command,
        &CheckoutOptions::new(12),
    )
    .unwrap();
    let same = command_fingerprint(
        "issue.checkout",
        &scope,
        &command,
        &CheckoutOptions::new(12),
    )
    .unwrap();
    let changed = command_fingerprint(
        "issue.checkout",
        &scope,
        &command,
        &CheckoutOptions::new(13),
    )
    .unwrap();

    assert_eq!(first, same);
    assert_ne!(first, changed);
    assert_eq!(first.len(), 64);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

fn review_command() -> ReviewDecisionCommand {
    ReviewDecisionCommand::new(
        issue_ref("org-client", "00000000-0000-0000-0000-000000000001"),
        ActorRef::user(
            OrganizationId::new("org-client"),
            rudder_issue_core::UserId::new("user-1"),
        ),
        ReviewDecision::Approve,
        "verified",
        8,
        12,
        IdempotencyKey::new("review-key"),
    )
}

#[test]
fn review_query_plans_bind_revision_and_fencing_preconditions() {
    let plans: ReviewQueryPlans =
        review_decision_query_plans(&scope("org-client"), &review_command()).unwrap();
    assert!(plans.update_issue.sql.contains("i.revision = $3::int8"));
    assert!(
        plans
            .update_issue
            .sql
            .contains("i.fencing_token = $4::int8")
    );
    assert!(plans.update_issue.sql.contains("status = $5::text"));
    assert!(
        plans
            .update_issue
            .sql
            .contains("i.status IN ('in_review', 'blocked')")
    );
    assert!(plans.update_issue.sql.contains("started_at = CASE"));
    assert!(plans.update_issue.sql.contains("completed_at = CASE"));
    assert!(
        plans
            .update_issue
            .sql
            .contains("COALESCE(i.started_at, now())")
    );
    assert!(plans.update_issue.sql.contains("completed_at = CASE"));
    assert!(plans.update_issue.sql.contains("cancelled_at = CASE"));
    assert!(plans.update_issue.sql.contains("ELSE NULL END"));
    assert!(plans.update_issue.sql.contains("execution_run_id = NULL"));
    assert!(
        plans
            .update_issue
            .sql
            .contains("execution_agent_name_key = NULL")
    );
    assert!(
        plans
            .update_issue
            .sql
            .contains("execution_locked_at = NULL")
    );
    assert!(
        plans
            .update_issue
            .sql
            .contains("checkout_lease_owner = NULL")
    );
    assert!(
        plans
            .update_issue
            .sql
            .contains("checkout_lease_expires_at = NULL")
    );
    assert!(plans.finalize_ledger.sql.contains("issue_id = $3::uuid"));
    assert!(matches!(
        plans.load_issue.binds.first(),
        Some(MutationBind::Uuid(value)) if value == "org-client"
    ));
    assert!(
        plans
            .insert_comment
            .sql
            .contains("INSERT INTO issue_comments")
    );
    assert!(plans.insert_comment.sql.contains("author_agent_id"));
    assert!(plans.insert_comment.sql.contains("author_user_id"));
    assert!(plans.insert_comment.sql.contains("$5::text"));
}

fn approval_command() -> ApprovalDecisionCommand {
    ApprovalDecisionCommand::new(
        ApprovalRef::new(
            OrganizationId::new("org-client"),
            ApprovalId::new("00000000-0000-0000-0000-000000000004"),
        ),
        ActorRef::user(
            OrganizationId::new("org-client"),
            rudder_issue_core::UserId::new("user-1"),
        ),
        ApprovalDecision::Approve,
        Some("ship it".into()),
        3,
        IdempotencyKey::new("approval-key"),
    )
}

#[test]
fn approval_query_plans_fence_revision_and_persist_decision_idempotency() {
    let command = approval_command();
    let authorization = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope("org-client"),
        command.approval.approval_id.clone(),
        command.actor.clone(),
    )
    .unwrap();
    let plans: ApprovalQueryPlans =
        approval_decision_query_plans(&authorization, &command).unwrap();
    assert!(plans.load_approval.sql.contains("a.org_id = $1::uuid"));
    assert!(plans.load_approval.sql.contains("a.id = $2::uuid"));
    assert!(plans.load_approval.sql.contains("FOR UPDATE"));
    assert!(plans.update_approval.sql.contains("a.revision = $3::int8"));
    assert!(plans.update_approval.sql.contains("a.status = 'pending'"));
    assert!(plans.update_approval.sql.contains("status = $4::text"));
    assert!(
        plans
            .update_approval
            .sql
            .contains("decision_idempotency_key = $6::text")
    );
    assert!(
        plans
            .update_approval
            .sql
            .contains("decision_note = $7::text")
    );
    assert!(
        plans
            .update_approval
            .sql
            .contains("revision = a.revision + 1")
    );
    assert!(plans.finalize_ledger.sql.contains("approval_id = $3::uuid"));
    assert!(
        !plans
            .insert_activity
            .sql
            .contains("approval.decision_recorded")
    );
    assert!(matches!(
        plans.insert_activity.binds.get(3),
        Some(MutationBind::Text(value)) if value == "approval.decision_recorded"
    ));
}

#[test]
fn approval_command_cannot_cross_the_trusted_organization_fence() {
    let command = approval_command();
    let error = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope("org-host"),
        command.approval.approval_id,
        command.actor,
    )
    .unwrap_err();
    assert!(matches!(
        error,
        IssueMutationError::ApprovalAuthorizationMismatch
    ));
}

#[test]
fn approval_decisions_require_host_trusted_approval_authorization() {
    let command = approval_command();
    let authorization = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope("org-client"),
        ApprovalId::new("different-approval"),
        command.actor.clone(),
    )
    .unwrap();

    let error = approval_decision_query_plans(&authorization, &command).unwrap_err();

    assert!(matches!(
        error,
        IssueMutationError::ApprovalAuthorizationMismatch
    ));
}

#[test]
fn approval_resubmission_plans_return_revision_requested_approvals_to_pending() {
    let command = rudder_issue_core::ApprovalResubmissionCommand::new(
        ApprovalRef::new(
            OrganizationId::new("org-client"),
            ApprovalId::new("00000000-0000-0000-0000-000000000004"),
        ),
        ActorRef::user(
            OrganizationId::new("org-client"),
            rudder_issue_core::UserId::new("user-1"),
        ),
        4,
        IdempotencyKey::new("approval-resubmit-key"),
    );
    let authorization = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope("org-client"),
        command.approval.approval_id.clone(),
        command.actor.clone(),
    )
    .unwrap();
    let plans = approval_resubmission_query_plans(
        &authorization,
        &command,
        &ApprovalResubmissionOptions::new(None),
    )
    .unwrap();

    assert!(
        plans
            .update_approval
            .sql
            .contains("a.status = 'revision_requested'")
    );
    assert!(plans.update_approval.sql.contains("status = 'pending'"));
    assert!(
        plans
            .update_approval
            .sql
            .contains("decision_idempotency_key = NULL")
    );
    assert!(plans.update_approval.sql.contains("decision = NULL"));
    assert!(plans.update_approval.sql.contains("payload"));

    let invalid = approval_resubmission_query_plans(
        &authorization,
        &command,
        &ApprovalResubmissionOptions::new(Some(serde_json::json!({
            "issueIds": ["issue-a", "issue-b"]
        }))),
    );
    assert!(matches!(
        invalid,
        Err(IssueMutationError::InvalidStoredState { .. })
    ));
}

#[test]
fn approval_authorization_requires_an_opaque_host_capability_and_user_actor() {
    let command = approval_command();
    let authorization = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope("org-client"),
        command.approval.approval_id.clone(),
        command.actor.clone(),
    )
    .unwrap();
    assert!(approval_decision_query_plans(&authorization, &command).is_ok());

    let agent_authorization = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope("org-client"),
        command.approval.approval_id,
        ActorRef::agent(
            OrganizationId::new("org-client"),
            AgentId::new("00000000-0000-0000-0000-000000000002"),
            Some(RunId::new("00000000-0000-0000-0000-000000000003")),
        ),
    );
    assert!(matches!(
        agent_authorization,
        Err(IssueMutationError::ApprovalAuthorizationMismatch)
    ));
}

#[test]
fn receipts_carry_both_audit_and_ledger_evidence() {
    let receipt = rudder_db_core::issue_mutation::MutationReceipt {
        command_type: "issue.checkout".into(),
        idempotency_key: IdempotencyKey::new("key"),
        ledger_id: "ledger".into(),
        activity_id: "activity".into(),
        outcome: Value::Object(Default::default()),
        replayed: false,
    };
    assert_eq!(receipt.ledger_id, "ledger");
    assert_eq!(receipt.activity_id, "activity");
    assert!(!receipt.replayed);
}
