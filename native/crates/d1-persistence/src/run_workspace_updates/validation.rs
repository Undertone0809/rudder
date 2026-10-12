use super::{Error, Result};
use serde_json::{Value, json};

fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn wrong(expected: &str, value: Option<&Value>, path: Value) -> Value {
    let received = kind(value);
    json!({"code":"invalid_type","expected":expected,"received":received,"path":path,"message":if received=="undefined"{"Required".to_owned()}else{format!("Expected {expected}, received {received}")}})
}
pub(super) fn validate(input: Option<&Value>) -> Result<Value> {
    let fail =
        |issues: Vec<Value>| Error::Http(400, "Validation error".into(), Some(json!(issues)));
    let Some(Value::Object(object)) = input else {
        return Err(fail(vec![wrong("object", input, json!([]))]));
    };
    let mut issues = Vec::new();
    let statuses = ["active", "idle", "in_review", "archived", "cleanup_failed"];
    if let Some(value) = object.get("status") {
        match value.as_str() {
            Some(status) if statuses.contains(&status) => (),
            Some(status) => issues.push(json!({"received":status,"code":"invalid_enum_value","options":statuses,"path":["status"],"message":format!("Invalid enum value. Expected 'active' | 'idle' | 'in_review' | 'archived' | 'cleanup_failed', received '{status}'")})),
            None => issues.push(wrong("'active' | 'idle' | 'in_review' | 'archived' | 'cleanup_failed'",Some(value),json!(["status"]))),
        }
    }
    for key in ["cleanupEligibleAt", "cleanupReason", "metadata"] {
        if let Some(value) = object.get(key) {
            if value.is_null() {
                continue;
            }
            let expected = if key == "metadata" {
                "object"
            } else {
                "string"
            };
            if (key == "metadata" && !value.is_object())
                || (key != "metadata" && !value.is_string())
            {
                issues.push(wrong(expected, Some(value), json!([key])));
            } else if key == "cleanupEligibleAt" {
                let date = value.as_str().unwrap();
                if !valid_datetime(date) {
                    issues.push(json!({"code":"invalid_string","validation":"datetime","message":"Invalid datetime","path":[key]}));
                }
            }
        }
    }
    let unknown = object
        .keys()
        .filter(|key| {
            !["status", "cleanupEligibleAt", "cleanupReason", "metadata"].contains(&key.as_str())
        })
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        issues.push(json!({"code":"unrecognized_keys","keys":unknown,"path":[],"message":format!("Unrecognized key(s) in object: {}",unknown.iter().map(|key|format!("'{key}'")).collect::<Vec<_>>().join(", "))}));
    }
    if issues.is_empty() {
        Ok(Value::Object(object.clone()))
    } else {
        Err(fail(issues))
    }
}

// Matches the installed shared Zod 3.25 datetime() oracle: UTC Z only,
// optional seconds, arbitrary fractional precision, Gregorian leap dates.
fn valid_datetime(value: &str) -> bool {
    regex_lite::Regex::new(r"^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?Z$")
        .expect("constant datetime regex").is_match(value)
}

pub(super) fn database_datetime(value: &str) -> String {
    let without_z = value.strip_suffix('Z').expect("validated UTC date");
    let (whole, fraction) = without_z.split_once('.').unwrap_or((without_z, ""));
    let whole = if whole.len() == 16 {
        format!("{whole}:00")
    } else {
        whole.to_owned()
    };
    let millis: String = fraction
        .chars()
        .chain(std::iter::repeat('0'))
        .take(3)
        .collect();
    format!("{whole}.{millis}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datetime_grammar_and_precision_match_shared_zod_and_date() {
        for value in [
            "2024-02-29T12:34Z",
            "2024-02-29T12:34:56Z",
            "2024-02-29T12:34:56.123456789123456789Z",
            "2000-02-29T00:00:00Z",
        ] {
            assert!(validate(Some(&json!({"cleanupEligibleAt":value}))).is_ok());
        }
        for value in [
            "1900-02-29T00:00:00Z",
            "2023-02-29T00:00:00Z",
            "2024-04-31T00:00:00Z",
            "2024-02-29T12:34:56+00:00",
            "2024-02-29T12:34:60Z",
        ] {
            assert!(validate(Some(&json!({"cleanupEligibleAt":value}))).is_err());
        }
        assert_eq!(
            database_datetime("2024-02-29T12:34Z"),
            "2024-02-29T12:34:00.000Z"
        );
        assert_eq!(
            database_datetime("2024-02-29T12:34:56.1239999Z"),
            "2024-02-29T12:34:56.123Z"
        );
    }

    #[test]
    fn strict_ordinary_fields_allow_empty_and_nullable_metadata() {
        for input in [
            json!({}),
            json!({"metadata":null,"cleanupReason":null,"cleanupEligibleAt":null}),
            json!({"metadata":{"nested":[null,true,"雪"]}}),
        ] {
            assert!(validate(Some(&input)).is_ok());
        }
        for input in [
            json!({"metadata":[]}),
            json!({"metadata":"text"}),
            json!({"closedAt":null}),
            json!({"archiveRecovery":"abandon"}),
            json!({"status":"invalid"}),
            Value::Null,
        ] {
            assert!(validate(Some(&input)).is_err());
        }
        assert!(validate(None).is_err());
    }
}
