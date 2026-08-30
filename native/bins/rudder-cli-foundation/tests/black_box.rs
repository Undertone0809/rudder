use serde_json::Value;
use std::process::Command;

#[test]
fn reports_binary_identity_and_contract_manifest() {
    let identity = Command::new(env!("CARGO_BIN_EXE_rudder-cli-foundation"))
        .arg("identity")
        .output()
        .unwrap();
    assert!(identity.status.success());
    let identity: Value = serde_json::from_slice(&identity.stdout).unwrap();
    assert_eq!(identity["productAuthority"], "node");
    assert_eq!(identity["compatibilityBoundary"], "RUDDER_NODE_CLI_BIN");
    assert_eq!(identity["manifestHash"].as_str().unwrap().len(), 64);

    let manifest = Command::new(env!("CARGO_BIN_EXE_rudder-cli-foundation"))
        .arg("capabilities")
        .output()
        .unwrap();
    assert!(manifest.status.success());
    let manifest: Value = serde_json::from_slice(&manifest.stdout).unwrap();
    assert_eq!(manifest["schema"], "rudder.agent-capabilities/v1");
    assert_eq!(manifest["contract"], "agent-v1");
    assert_eq!(manifest["defaults"]["orgIdEnvVar"], "RUDDER_ORG_ID");
    assert_eq!(manifest["capabilities"].as_array().unwrap().len(), 107);
    assert_eq!(manifest["mcp"]["tools"].as_array().unwrap().len(), 82);
}
