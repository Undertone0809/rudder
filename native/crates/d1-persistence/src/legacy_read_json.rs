//! JavaScript-compatible JSON at read-response boundaries only.
use serde::Deserialize;
use serde::de::Error as _;
use serde_json::{Number, Value};

fn legacy_number(number: f64) -> Value {
    if number == 0.0 {
        Value::Number(Number::from(0))
    } else if number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_992.0
    {
        Value::Number(Number::from(number as i64))
    } else {
        Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// Preserve validated JSON structure and strings, normalizing only number
/// tokens to JSON.parse + JSON.stringify semantics. No recursive Value decode
/// or serialization is needed when PostgreSQL already produced a projection.
pub fn normalize_legacy_read_json(raw: &str) -> Result<String, serde_json::Error> {
    replace_numbers(raw, None, |number| legacy_number(number).to_string())
}

/// Read callers that must inspect object fields use numeric indices as an
/// intermediate representation, then restore the exact rounded f64 values.
/// This avoids serde's ordinary float decoder rounding a decimal twice. Only
/// this decoder lifts the standard 128-level limit, with a 512-level guard to
/// prevent user-provided metadata from exhausting the native stack. Callers
/// needing opaque deeper payloads should use normalize_legacy_read_json.
pub fn parse_legacy_read_json(raw: &str) -> Result<Value, serde_json::Error> {
    parse_numeric_json(raw, 512)
}

/// Agent command callers execute parsing, cloning and dropping on a grown stack.
pub(crate) fn parse_legacy_command_json(raw: &str) -> Result<Value, serde_json::Error> {
    parse_numeric_json(raw, 8192)
}

fn parse_numeric_json(raw: &str, maximum_depth: usize) -> Result<Value, serde_json::Error> {
    let mut numbers = Vec::new();
    let indexed = replace_numbers(raw, Some(maximum_depth), |number| {
        let index = numbers.len();
        numbers.push(legacy_number(number));
        index.to_string()
    })?;
    let mut deserializer = serde_json::Deserializer::from_str(&indexed);
    deserializer.disable_recursion_limit();
    let mut value = LiteralJson::deserialize(&mut deserializer)?.0;
    deserializer.end()?;
    let mut pending = vec![&mut value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Number(index) => {
                *value = numbers[index.as_u64().expect("numeric index") as usize].clone()
            }
            Value::Array(values) => pending.extend(values.iter_mut()),
            Value::Object(values) => pending.extend(values.values_mut()),
            _ => (),
        }
    }
    Ok(value)
}

// Value's visitor recognizes serde-private sentinel keys when transitive
// dependencies enable raw_value. At a product JSON boundary those keys are
// ordinary user data, including when they are the only key in an object.
struct LiteralJson(Value);
impl<'de> Deserialize<'de> for LiteralJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = LiteralJson;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(LiteralJson(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(LiteralJson(Value::Bool(value)))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(LiteralJson(Value::Number(value.into())))
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(LiteralJson(Value::Number(value.into())))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(LiteralJson(Value::String(value.into())))
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(LiteralJson(Value::String(value)))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<LiteralJson>()? {
                    values.push(value.0);
                }
                Ok(LiteralJson(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, LiteralJson>()? {
                    values.insert(key, value.0);
                }
                Ok(LiteralJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

fn replace_numbers(
    raw: &str,
    depth_limit: Option<usize>,
    mut replacement: impl FnMut(f64) -> String,
) -> Result<String, serde_json::Error> {
    // IgnoredAny validates huge numeric tokens and deep JSON iteratively,
    // without raw_value/arbitrary_precision private-key side effects.
    serde_json::from_str::<serde::de::IgnoredAny>(raw)?;
    let bytes = raw.as_bytes();
    let mut normalized = String::with_capacity(raw.len());
    let mut index = 0;
    let mut copied = 0;
    let mut depth = 0;
    let mut quoted = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if quoted {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == b'"' {
                quoted = false;
            }
            index += 1;
        } else if byte == b'"' {
            quoted = true;
            index += 1;
        } else if byte == b'-' || byte.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < bytes.len()
                && matches!(bytes[index], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
            {
                index += 1;
            }
            normalized.push_str(&raw[copied..start]);
            let number = raw[start..index]
                .parse::<f64>()
                .map_err(serde_json::Error::custom)?;
            normalized.push_str(&replacement(number));
            copied = index;
        } else {
            if byte == b'{' || byte == b'[' {
                depth += 1;
                if depth_limit.is_some_and(|limit| depth > limit) {
                    return Err(serde_json::Error::custom(
                        "legacy read JSON exceeds safe structural depth",
                    ));
                }
            } else if byte == b'}' || byte == b']' {
                depth -= 1;
            }
            index += 1;
        }
    }
    normalized.push_str(&raw[copied..]);
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_nested_json_and_private_sentinel_object_keys() {
        let value = parse_legacy_read_json(r#"{"$serde_json::private::Number":"123","$serde_json::private::RawValue":"[1]","nested":[true,false,null,"snowman ☃",{"empty":{}}]}"#).unwrap();
        assert_eq!(value["$serde_json::private::Number"], "123");
        assert_eq!(value["$serde_json::private::RawValue"], "[1]");
        let sentinels = parse_legacy_read_json(r#"[{"$serde_json::private::RawValue":"not parsed"},{"$serde_json::private::Number":"literal"}]"#).unwrap();
        assert_eq!(sentinels[0]["$serde_json::private::RawValue"], "not parsed");
        assert_eq!(sentinels[1]["$serde_json::private::Number"], "literal");
        assert_eq!(value["nested"][3], "snowman ☃");
        assert!(value["nested"][4]["empty"].as_object().unwrap().is_empty());
    }

    #[test]
    fn normalizes_numbers_like_json_parse_then_stringify() {
        let value = parse_legacy_read_json(r#"[9007199254740993,-9007199254740993,1e400,-1e400,1e-400,-1e-400,-0,0.100000000000000005,1.7976931348623157e308,18446744073709551615]"#).unwrap();
        assert_eq!(value[0].as_f64(), Some(9007199254740992.0));
        assert_eq!(value[1].as_f64(), Some(-9007199254740992.0));
        assert_eq!(value[2], Value::Null);
        assert_eq!(value[3], Value::Null);
        for index in [4, 5, 6] {
            assert_eq!(value[index].to_string(), "0");
        }
        assert_eq!(value[7].as_f64(), Some(0.1));
        assert_eq!(value[8].as_f64(), Some(f64::MAX));
        assert_eq!(value[9].as_f64(), Some(18446744073709551616.0));
    }

    #[test]
    fn preserves_deeply_nested_existing_summaries() {
        let raw = format!(
            "{}{{\"value\":9007199254740993}}{}",
            "[".repeat(192),
            "]".repeat(192)
        );
        let value = parse_legacy_read_json(&raw).unwrap();
        let mut inner = &value;
        for _ in 0..192 {
            inner = &inner[0];
        }
        assert_eq!(inner["value"].as_f64(), Some(9007199254740992.0));
    }

    #[test]
    fn rejects_invalid_json_instead_of_coercing_it() {
        for raw in ["", "NaN", "01", "[1,]", "{\"x\":1} trailing"] {
            assert!(parse_legacy_read_json(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn never_reparses_rounded_floats_with_a_lossy_decoder() {
        for token in [
            "1.0790143258645723e-180",
            "0.84551240822557006",
            "1.7976931348623157e308",
            "5e-324",
            "2.2250738585072014e-308",
        ] {
            assert_eq!(
                parse_legacy_read_json(token)
                    .unwrap()
                    .as_f64()
                    .unwrap()
                    .to_bits(),
                token.parse::<f64>().unwrap().to_bits(),
                "{token}"
            );
        }
        let mut bits = 0x9e3779b97f4a7c15_u64;
        for _ in 0..10_000 {
            bits ^= bits << 13;
            bits ^= bits >> 7;
            bits ^= bits << 17;
            let number = f64::from_bits(bits);
            if !number.is_finite() || number == 0.0 {
                continue;
            }
            let token = Number::from_f64(number).unwrap().to_string();
            assert_eq!(
                parse_legacy_read_json(&token)
                    .unwrap()
                    .as_f64()
                    .unwrap()
                    .to_bits(),
                number.to_bits(),
                "{token}"
            );
        }
    }

    #[test]
    fn keeps_numbers_in_escaped_strings_and_duplicate_keys_intact() {
        let raw = r#"{"quote":"escaped \"1e400\" and \\0","unicode":"\u0031e400 ☃","same":9e400,"same":9007199254740993}"#;
        let value = parse_legacy_read_json(raw).unwrap();
        assert_eq!(value["quote"], "escaped \"1e400\" and \\0");
        assert_eq!(value["unicode"], "1e400 ☃");
        assert_eq!(value["same"].as_f64(), Some(9007199254740992.0));
    }

    #[test]
    fn bounds_structural_decoding_without_limiting_opaque_projection_depth() {
        let at_limit = format!("{}0{}", "[".repeat(512), "]".repeat(512));
        assert!(parse_legacy_read_json(&at_limit).is_ok());
        let over_limit = format!("{}0{}", "[".repeat(513), "]".repeat(513));
        assert!(parse_legacy_read_json(&over_limit).is_err());
        let raw = format!("{}1e400{}", "[".repeat(1024), "]".repeat(1024));
        assert!(parse_legacy_read_json(&raw).is_err());
        assert_eq!(
            normalize_legacy_read_json(&raw).unwrap(),
            format!("{}null{}", "[".repeat(1024), "]".repeat(1024))
        );
    }
}
