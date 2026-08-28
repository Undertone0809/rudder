use serde_json::Value;

const CONTRACT_JSON: &str = include_str!("contract.generated.json");
const NON_SEMANTIC_SENTINEL: &str = "<non-semantic>";

pub fn contract() -> Value {
    serde_json::from_str(CONTRACT_JSON).expect("generated Rudder agent contract must be valid JSON")
}

pub fn artifact_hash() -> String {
    contract()
        .get("artifactHash")
        .and_then(Value::as_str)
        .expect("generated Rudder agent contract must include artifactHash")
        .to_owned()
}

pub fn normalize(value: &Value, profile: &str) -> Result<Value, &'static str> {
    let source = contract();
    let pointers = source
        .get("normalizationProfiles")
        .and_then(|profiles| profiles.get(profile))
        .and_then(Value::as_array)
        .ok_or("unknown_normalization_profile")?;
    let mut normalized = value.clone();
    for pointer in pointers {
        let pointer = pointer.as_str().ok_or("invalid_normalization_pointer")?;
        replace_existing_pointer(&mut normalized, pointer)?;
    }
    Ok(normalized)
}

fn replace_existing_pointer(value: &mut Value, pointer: &str) -> Result<(), &'static str> {
    if !pointer.starts_with('/') {
        return Err("invalid_normalization_pointer");
    }
    if value.pointer(pointer).is_none() {
        return Ok(());
    }
    let target = value
        .pointer_mut(pointer)
        .ok_or("invalid_normalization_pointer")?;
    *target = Value::String(NON_SEMANTIC_SENTINEL.to_owned());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_contract_is_versioned_and_hashable() {
        let source = contract();
        assert_eq!(source["contractVersion"], "rudder.agent-contract/v1");
        assert_eq!(artifact_hash().len(), 64);
        assert_eq!(source["capabilities"].as_array().map(Vec::len), Some(117));
    }

    #[test]
    fn differential_fixtures_converge_without_hiding_semantic_fields() {
        let source = contract();
        let fixtures = source["differentialFixtures"]
            .as_array()
            .expect("fixtures must be an array")
            .iter()
            .chain(
                source["g0DifferentialFixtures"]
                    .as_array()
                    .expect("G0 fixtures must be an array"),
            );
        for fixture in fixtures {
            let profile = fixture["profile"].as_str().expect("fixture profile");
            let expected = &fixture["expected"];
            assert_eq!(&normalize(&fixture["left"], profile).unwrap(), expected);
            assert_eq!(&normalize(&fixture["right"], profile).unwrap(), expected);
        }

        let forbidden = serde_json::json!({
            "status": "error",
            "error": { "code": "forbidden" },
            "meta": { "requestId": "node" }
        });
        let unauthorized = serde_json::json!({
            "status": "error",
            "error": { "code": "unauthorized" },
            "meta": { "requestId": "rust" }
        });
        assert_ne!(
            normalize(&forbidden, "authorization").unwrap(),
            normalize(&unauthorized, "authorization").unwrap()
        );
    }
}
