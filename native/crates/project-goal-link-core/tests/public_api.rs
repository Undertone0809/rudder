use rudder_project_goal_link_core::{ActorBinding, SHA256_HEX_LENGTH};
use serde_json::json;
use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn run_external_consumer_probe() {
    let package_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_nanos();
    let probe_root = std::env::temp_dir().join(format!(
        "rudder-project-goal-link-public-probe-{}-{nonce}",
        std::process::id()
    ));
    let source_root = probe_root.join("src");
    fs::create_dir_all(&source_root).expect("create external probe source directory");

    let package_path = package_root.to_string_lossy().replace('\\', "\\\\");
    fs::write(
        probe_root.join("Cargo.toml"),
        format!(
            "[package]\nname = \"project-goal-link-public-probe\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[dependencies]\nrudder-project-goal-link-core = {{ path = \"{package_path}\" }}\nserde_json = \"1.0\"\n"
        ),
    )
    .expect("write external probe manifest");
    fs::write(
        source_root.join("main.rs"),
        r#"
use rudder_project_goal_link_core::{
    Actor, ActorBinding, ActorAuthority, Operation, ProjectGoalLinkCommand,
    ProjectGoalLinkState, TargetVerifier, ValidatedLinkContext,
};

struct ExistingTarget;

impl TargetVerifier for ExistingTarget {
    fn target_exists_in_organization(
        &self,
        _organization_id: &str,
        _project_org_id: &str,
        _goal_org_id: &str,
        _project_id: &str,
        _goal_id: &str,
    ) -> bool {
        true
    }
}

fn main() {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let _minted = authority
        .issue(Actor::Board {
            organization_id: "org-a".to_owned(),
            principal_id: "board-a".to_owned(),
        })
        .unwrap();
    let forged = ActorBinding {
        actor: Actor::CeoAgent {
            organization_id: "org-a".to_owned(),
            principal_id: "ceo-a".to_owned(),
        },
        proof: "0".repeat(64),
    };
    let state = ProjectGoalLinkState::new(
        "org-a", "org-a", "org-a", "project-a", "goal-a", 2, 4, false,
    );
    let context = state
        .validated_context(&forged, &authority, &ExistingTarget)
        .unwrap();
    let _command = ProjectGoalLinkCommand::from_validated_context(
        context,
        Operation::Attach,
        2,
        4,
        "known-target",
    );
    let _unvalidated: ValidatedLinkContext = serde_json::from_str("{}").unwrap();
}
"#,
    )
    .expect("write external probe source");

    let output = Command::new("cargo")
        .args([
            "check",
            "--offline",
            "--manifest-path",
            probe_root.join("Cargo.toml").to_str().unwrap(),
        ])
        .env("CARGO_TARGET_DIR", probe_root.join("target"))
        .output()
        .expect("run external consumer probe");
    let stderr = String::from_utf8_lossy(&output.stderr);
    fs::remove_dir_all(&probe_root).expect("remove external probe directory");

    assert!(
        !output.status.success(),
        "forged external consumer unexpectedly compiled:\n{stderr}"
    );
    assert!(
        stderr.contains("private")
            || stderr.contains("E0603")
            || stderr.contains("E0616")
            || stderr.contains("E0624")
            || stderr.contains("Deserialize"),
        "external probe failed for an unrelated reason:\n{stderr}"
    );
}

fn run_external_positive_consumer_probe() {
    let package_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_nanos();
    let probe_root = std::env::temp_dir().join(format!(
        "rudder-project-goal-link-positive-probe-{}-{nonce}",
        std::process::id()
    ));
    let source_root = probe_root.join("src");
    fs::create_dir_all(&source_root).expect("create positive probe source directory");

    let package_path = package_root.to_string_lossy().replace('\\', "\\\\");
    fs::write(
        probe_root.join("Cargo.toml"),
        format!(
            "[package]\nname = \"project-goal-link-positive-probe\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[dependencies]\nrudder-project-goal-link-core = {{ path = \"{package_path}\" }}\nserde_json = \"1.0\"\n"
        ),
    )
    .expect("write positive probe manifest");
    fs::write(
        source_root.join("lib.rs"),
        r#"
use rudder_project_goal_link_core::{
    ActorBinding, ActorAuthority, LinkMutationError, Operation,
    ProjectGoalLinkCommand, ProjectGoalLinkState, TargetVerifier,
};

struct ExistingTarget;

impl TargetVerifier for ExistingTarget {
    fn target_exists_in_organization(
        &self,
        organization_id: &str,
        project_org_id: &str,
        goal_org_id: &str,
        project_id: &str,
        goal_id: &str,
    ) -> bool {
        organization_id == "org-a"
            && project_org_id == "org-a"
            && goal_org_id == "org-a"
            && project_id == "project-a"
            && goal_id == "goal-a"
    }
}

fn persist_project_goal(command: &ProjectGoalLinkCommand) -> Result<String, LinkMutationError> {
    let view = command.as_integration_view()?;
    let context = view.context();
    let _sql_bindings = (
        context.organization_id(),
        context.project_organization_id(),
        context.goal_organization_id(),
        context.project_id(),
        context.goal_id(),
        context.actor().organization_id(),
        context.actor().principal_id(),
        context.actor().kind(),
        context.version(),
        context.fence_epoch(),
        context.linked(),
        context.cancelled(),
        context.state_integrity(),
        view.operation(),
        view.expected_version(),
        view.fence_epoch(),
        view.idempotency_key(),
    );
    view.fingerprint()
}

#[test]
fn trusted_sqlx_consumer_can_verify_and_consume_a_real_command() {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(serde_json::json!({
        "actor": {
            "ceo_agent": {
                "organization_id": "org-a",
                "principal_id": "ceo-a"
            }
        },
        "proof": "d1bcc853463bfbf2911573e8bb5d8b201f8f07f33b589d346b10f91af38e8bed"
    }))
    .unwrap();
    let state = ProjectGoalLinkState::new(
        "org-a", "org-a", "org-a", "project-a", "goal-a", 2, 4, false,
    );
    let context = state
        .validated_context(&binding, &authority, &ExistingTarget)
        .unwrap();
    let command = ProjectGoalLinkCommand::from_validated_context(
        context,
        Operation::Attach,
        2,
        4,
        "known-target",
    );
    let fingerprint = persist_project_goal(&command).unwrap();

    assert_eq!(fingerprint.len(), 64);
    assert_eq!(
        command.as_integration_view().unwrap().operation(),
        Operation::Attach
    );
}
"#,
    )
    .expect("write positive probe source");

    let output = Command::new("cargo")
        .args([
            "test",
            "--offline",
            "--manifest-path",
            probe_root.join("Cargo.toml").to_str().unwrap(),
        ])
        .env("CARGO_TARGET_DIR", probe_root.join("target"))
        .output()
        .expect("run positive external consumer probe");
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    fs::remove_dir_all(&probe_root).expect("remove positive probe directory");

    assert!(
        output.status.success(),
        "trusted external consumer failed to compile/test:\nstdout={stdout}\nstderr={stderr}"
    );
}

#[test]
fn forged_actor_json_cannot_cross_the_public_authority_boundary() {
    let forged_json = json!({
        "actor": {
            "ceo_agent": {
                "organization_id": "org-a",
                "principal_id": "ceo-a"
            }
        },
        "proof": "0".repeat(SHA256_HEX_LENGTH),
    });
    let binding: ActorBinding = serde_json::from_value(forged_json.clone()).unwrap();
    assert_eq!(serde_json::to_value(binding).unwrap(), forged_json);

    run_external_consumer_probe();
}

#[test]
fn trusted_external_consumer_can_verify_and_consume_a_real_command() {
    run_external_positive_consumer_probe();
}
