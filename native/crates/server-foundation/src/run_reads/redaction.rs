//! Legacy run-read redaction without recursively decoding or dropping deep JSON.
use rudder_d1_persistence::legacy_read_json::normalize_legacy_read_json;
use serde::Deserialize;
use serde::de::Error as _;
use std::collections::HashMap;
use std::ops::Range;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Redaction {
    #[serde(skip)]
    pub enabled: bool,
    pub user_names: Vec<String>,
    pub home_dirs: Vec<String>,
    pub replacement: String,
}

const REDACTED: &str = "***REDACTED***";

type NodeId = usize;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct JsString(Vec<u16>);

impl JsString {
    pub(super) fn eq_str(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.encode_utf16())
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}

struct Field {
    name: JsString,
    value: NodeId,
}

enum Kind {
    Object(Vec<Field>),
    Array(Vec<NodeId>),
    String(JsString),
    Scalar,
}

struct Node {
    span: Range<usize>,
    kind: Kind,
}

struct Frame {
    node: NodeId,
    key: Option<JsString>,
}

/// `raw` is a complete public projection, not a database row. Event sanitizing
/// applies only to its top-level `payload` object, before masking every string
/// value. Arena indices and an explicit work stack preserve arbitrarily deep
/// PostgreSQL JSON without recursive serde_json::Value decoding or destruction.
pub fn redact_json(
    raw: &str,
    opts: &Redaction,
    event_payload: bool,
) -> Result<String, serde_json::Error> {
    let normalized = normalize_legacy_read_json(raw)?;
    let nodes = parse_validated(&normalized)?;
    let mut actions = vec![Action::Keep; nodes.len()];
    let mut rebuilt = vec![false; nodes.len()];
    let mut opaque = vec![false; nodes.len()];
    if event_payload && let Kind::Object(fields) = &nodes[0].kind {
        for field in fields.iter().filter(|field| field.name.eq_str("payload")) {
            let value = &nodes[field.value];
            // redactEventPayload applies JavaScript truthiness at the payload
            // root before its object-only sanitizer. Numeric normalization has
            // already turned underflow and negative zero into the token 0.
            let falsy = match &value.kind {
                Kind::String(text) => text.is_empty(),
                Kind::Scalar => matches!(&normalized[value.span.clone()], "null" | "false" | "0"),
                _ => false,
            };
            if falsy {
                actions[field.value] = Action::Null;
            } else if matches!(value.kind, Kind::Object(_)) {
                sanitize(&nodes, &mut actions, &mut rebuilt, &mut opaque, field.value);
            }
        }
    }
    let masker = Masker::new(opts);
    Ok(render(
        &normalized,
        &nodes,
        &actions,
        &rebuilt,
        &opaque,
        &masker,
    ))
}

/// postgres-js already decodes JSONB, then Drizzle's PgJsonb adapter attempts
/// JSON.parse once more when the column itself is a string. Keep that column
/// boundary separate from redactEventPayload's ordinary string truthiness.
/// Only the top-level payload column is decoded, never nested value strings.
pub(super) fn decode_event_payload_column(raw: &str) -> Result<String, serde_json::Error> {
    let fields = object_fields(raw)?;
    let Some((_, value)) = fields.iter().find(|(key, _)| key.eq_str("payload")) else {
        return Ok(raw.to_owned());
    };
    if let Ok(decoded) = serde_json::from_str::<String>(value)
        && serde_json::from_str::<serde::de::IgnoredAny>(&decoded).is_ok()
    {
        let start = value.as_ptr() as usize - raw.as_ptr() as usize;
        let mut result = String::with_capacity(raw.len() + decoded.len());
        result.push_str(&raw[..start]);
        result.push_str(&decoded);
        result.push_str(&raw[start + value.len()..]);
        Ok(result)
    } else {
        Ok(raw.to_owned())
    }
}

/// Inspect shallow fields while retaining raw, arbitrarily deep child values.
/// Numeric tokens are deliberately untouched here; read-response callers use
/// `redact_json` (or normalize_legacy_read_json) at their final boundary.
pub fn object_fields(raw: &str) -> Result<Vec<(JsString, &str)>, serde_json::Error> {
    serde_json::from_str::<serde::de::IgnoredAny>(raw)?;
    let nodes = parse_validated(raw)?;
    let Kind::Object(fields) = &nodes[0].kind else {
        return Err(serde_json::Error::custom("expected a JSON object"));
    };
    Ok(fields
        .iter()
        .map(|field| (field.name.clone(), &raw[nodes[field.value].span.clone()]))
        .collect())
}

/// Inspect array members without decoding nested object values.
pub fn array_values(raw: &str) -> Result<Vec<&str>, serde_json::Error> {
    serde_json::from_str::<serde::de::IgnoredAny>(raw)?;
    let nodes = parse_validated(raw)?;
    let Kind::Array(values) = &nodes[0].kind else {
        return Err(serde_json::Error::custom("expected a JSON array"));
    };
    Ok(values
        .iter()
        .map(|id| &raw[nodes[*id].span.clone()])
        .collect())
}

/// Decode only a JSON string token into JavaScript UTF-16 code units. The
/// enclosing document is already validated by IgnoredAny. Keeping each \u
/// escape as its original unit preserves both pairs and lone surrogates.
fn decode_string_token(token: &str) -> Result<JsString, serde_json::Error> {
    let fail = || serde_json::Error::custom("invalid JSON string token");
    if token.len() < 2 || !token.starts_with('"') || !token.ends_with('"') {
        return Err(fail());
    }
    let mut units = Vec::new();
    let mut chars = token[1..token.len() - 1].chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            let escaped = chars.next().ok_or_else(fail)?;
            let unit = match escaped {
                '"' => 0x22,
                '\\' => 0x5c,
                '/' => 0x2f,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                'u' => {
                    let mut unit = 0;
                    for _ in 0..4 {
                        unit = unit * 16
                            + chars
                                .next()
                                .and_then(|value| value.to_digit(16))
                                .ok_or_else(fail)? as u16;
                    }
                    unit
                }
                _ => return Err(fail()),
            };
            units.push(unit);
        } else {
            if character == '"' || character <= '\u{001f}' {
                return Err(fail());
            }
            units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
        }
    }
    Ok(JsString(units))
}

// Input is validated iteratively by IgnoredAny, including the normalizer's
// validation. String tokens preserve JS code units; containers remain iterative.
fn parse_validated(raw: &str) -> Result<Vec<Node>, serde_json::Error> {
    let bytes = raw.as_bytes();
    let mut nodes = Vec::<Node>::new();
    let mut stack = Vec::<Frame>::new();
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        let kind = match bytes[index] {
            b' ' | b'\r' | b'\n' | b'\t' | b',' | b':' => {
                index += 1;
                continue;
            }
            b'}' | b']' => {
                let frame = stack.pop().expect("validated closing container");
                index += 1;
                nodes[frame.node].span.end = index;
                continue;
            }
            b'{' => {
                index += 1;
                Kind::Object(Vec::new())
            }
            b'[' => {
                index += 1;
                Kind::Array(Vec::new())
            }
            b'"' => {
                index += 1;
                while bytes[index] != b'"' {
                    index += if bytes[index] == b'\\' { 2 } else { 1 };
                }
                index += 1;
                let text = decode_string_token(&raw[start..index])?;
                let mut next = index;
                while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                    next += 1;
                }
                if bytes.get(next) == Some(&b':') {
                    stack.last_mut().expect("validated object key").key = Some(text);
                    continue;
                }
                Kind::String(text)
            }
            _ => {
                while index < bytes.len()
                    && !matches!(
                        bytes[index],
                        b',' | b'}' | b']' | b' ' | b'\r' | b'\n' | b'\t'
                    )
                {
                    index += 1;
                }
                Kind::Scalar
            }
        };
        let id = nodes.len();
        let container = matches!(kind, Kind::Object(_) | Kind::Array(_));
        nodes.push(Node {
            span: start..index,
            kind,
        });
        if let Some(frame) = stack.last_mut() {
            match &mut nodes[frame.node].kind {
                Kind::Object(fields) => {
                    let name = frame.key.take().expect("validated object field");
                    fields.push(Field { name, value: id });
                }
                Kind::Array(values) => values.push(id),
                _ => unreachable!("only containers have frames"),
            }
        }
        if container {
            stack.push(Frame {
                node: id,
                key: None,
            });
        }
    }
    // JSON.parse creates one own property per decoded key: the last value
    // wins while the property's first insertion position remains unchanged.
    // Resolve this before binding, sanitizer and prototype/opaque decisions;
    // discarded duplicate values must never influence those decisions.
    for node in &mut nodes {
        if let Kind::Object(fields) = &mut node.kind {
            let mut positions = HashMap::<JsString, usize>::new();
            let mut effective: Vec<Field> = Vec::with_capacity(fields.len());
            for field in std::mem::take(fields) {
                if let Some(&index) = positions.get(&field.name) {
                    effective[index].value = field.value;
                } else {
                    positions.insert(field.name.clone(), effective.len());
                    effective.push(field);
                }
            }
            *fields = effective;
        }
    }
    Ok(nodes)
}

#[derive(Clone, Copy)]
enum Action {
    Keep,
    Null,
    Redacted,
    RedactedPlain,
    Plain(NodeId),
}

fn field_value(nodes: &[Node], id: NodeId, key: &str) -> Option<NodeId> {
    let Kind::Object(fields) = &nodes[id].kind else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|field| field.name.eq_str(key))
        .map(|field| field.value)
}

fn string_is(nodes: &[Node], id: NodeId, key: &str, expected: &str) -> bool {
    field_value(nodes, id, key).is_some_and(
        |value| matches!(&nodes[value].kind, Kind::String(text) if text.eq_str(expected)),
    )
}

fn secret_ref(nodes: &[Node], id: NodeId) -> bool {
    string_is(nodes, id, "type", "secret_ref")
        && field_value(nodes, id, "secretId")
            .is_some_and(|value| matches!(nodes[value].kind, Kind::String(_)))
}

fn plain_value(nodes: &[Node], id: NodeId) -> Option<NodeId> {
    string_is(nodes, id, "type", "plain")
        .then(|| field_value(nodes, id, "value"))
        .flatten()
}

fn secret_key(key: &JsString) -> bool {
    let key: Vec<u16> = key
        .0
        .iter()
        .map(|&unit| {
            if (65..=90).contains(&unit) {
                unit + 32
            } else {
                unit
            }
        })
        .collect();
    [
        "apikey",
        "api-key",
        "api_key",
        "accesstoken",
        "access-token",
        "access_token",
        "auth",
        "bearer",
        "secret",
        "passwd",
        "password",
        "credential",
        "jwt",
        "privatekey",
        "private-key",
        "private_key",
        "cookie",
        "connectionstring",
    ]
    .iter()
    .any(|pattern| {
        key.windows(pattern.len())
            .any(|part| part.iter().copied().eq(pattern.bytes().map(u16::from)))
    })
}

fn jwt(value: &JsString) -> bool {
    let mut count = 0;
    for segment in value.0.split(|&unit| unit == u16::from(b'.')) {
        if segment.is_empty()
            || !segment
                .iter()
                .all(|unit| matches!(unit, 48..=57 | 65..=90 | 97..=122 | 95 | 45))
        {
            return false;
        }
        count += 1;
    }
    matches!(count, 3 | 4)
}

fn sanitize(
    nodes: &[Node],
    actions: &mut [Action],
    rebuilt: &mut [bool],
    opaque: &mut [bool],
    root: NodeId,
) {
    // The payload root goes directly through sanitizeRecord, even if its own
    // fields resemble a binding. Nested bindings instead use sanitizeValue.
    let mut pending = vec![(root, true)];
    while let Some((id, record_root)) = pending.pop() {
        match &nodes[id].kind {
            Kind::Object(fields) => {
                if !record_root {
                    if secret_ref(nodes, id) {
                        continue;
                    }
                    if let Some(value) = plain_value(nodes, id) {
                        actions[id] = Action::Plain(value);
                        pending.push((value, false));
                        continue;
                    }
                }
                rebuilt[id] = true;
                // sanitizeRecord assigns to an ordinary object. A legacy
                // __proto__ object/array changes its prototype, so the later
                // current-user pass treats that rebuilt record as opaque.
                opaque[id] = fields.iter().any(|field| {
                    field.name.eq_str("__proto__")
                        && matches!(nodes[field.value].kind, Kind::Object(_) | Kind::Array(_))
                });
                for field in fields {
                    let value = field.value;
                    if secret_key(&field.name) {
                        if secret_ref(nodes, value) {
                            continue;
                        }
                        actions[value] = if plain_value(nodes, value).is_some() {
                            Action::RedactedPlain
                        } else {
                            Action::Redacted
                        };
                    } else if matches!(&nodes[value].kind, Kind::String(text) if jwt(text)) {
                        actions[value] = Action::Redacted;
                    } else {
                        pending.push((value, false));
                    }
                }
            }
            Kind::Array(values) => pending.extend(values.iter().map(|&value| (value, false))),
            _ => (),
        }
    }
}

struct Replacement {
    needle: Vec<u16>,
    value: Vec<u16>,
    boundary: bool,
}

struct Masker {
    replacements: Vec<Replacement>,
}

pub(super) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

fn mask_name(value: &str, fallback: &str) -> Vec<u16> {
    let value = js_trim(value);
    let Some(first) = value.encode_utf16().next() else {
        return fallback.encode_utf16().collect();
    };
    let mut result = vec![first];
    result.extend(std::iter::repeat_n(
        b'*' as u16,
        value.chars().count().saturating_sub(1).max(1),
    ));
    result
}

fn candidates(values: &[String]) -> Vec<&str> {
    let mut result = Vec::new();
    for value in values {
        let value = js_trim(value);
        if !value.is_empty() && !result.contains(&value) {
            result.push(value);
        }
    }
    // JS stable sort compares UTF-16 length, not UTF-8 bytes or scalar count.
    result.sort_by_key(|value| std::cmp::Reverse(value.encode_utf16().count()));
    result
}

fn username_boundary(unit: u16) -> bool {
    matches!(unit, 48..=57 | 65..=90 | 97..=122 | 46 | 95 | 45)
}

impl Masker {
    fn new(opts: &Redaction) -> Self {
        let mut replacements = Vec::new();
        if opts.enabled {
            let replacement = js_trim(&opts.replacement);
            let replacement = if replacement.is_empty() {
                "*"
            } else {
                replacement
            };
            for home in candidates(&opts.home_dirs) {
                let normalized = home.trim_end_matches(['/', '\\']);
                let (prefix, last) = normalized
                    .rfind(['/', '\\'])
                    .map(|index| (&normalized[..=index], &normalized[index + 1..]))
                    .unwrap_or(("", normalized));
                let mut value: Vec<u16> = prefix.encode_utf16().collect();
                value.extend(mask_name(last, replacement));
                replacements.push(Replacement {
                    needle: home.encode_utf16().collect(),
                    value,
                    boundary: false,
                });
            }
            for name in candidates(&opts.user_names) {
                replacements.push(Replacement {
                    needle: name.encode_utf16().collect(),
                    value: mask_name(name, replacement),
                    boundary: true,
                });
            }
        }
        Self { replacements }
    }

    fn write_string(&self, output: &mut String, value: &str) {
        self.write_units(output, &value.encode_utf16().collect::<Vec<_>>());
    }

    fn write_units(&self, output: &mut String, value: &[u16]) {
        let mut units = value.to_vec();
        for replacement in &self.replacements {
            let mut replaced = Vec::with_capacity(units.len());
            let mut index = 0;
            while index < units.len() {
                let end = index + replacement.needle.len();
                let matches = units.get(index..end) == Some(replacement.needle.as_slice())
                    && (!replacement.boundary
                        || ((index == 0 || !username_boundary(units[index - 1]))
                            && (end == units.len() || !username_boundary(units[end]))));
                if matches {
                    replaced.extend_from_slice(&replacement.value);
                    index = end;
                } else {
                    replaced.push(units[index]);
                    index += 1;
                }
            }
            units = replaced;
        }
        output.push('"');
        for character in char::decode_utf16(units) {
            match character {
                Ok('"') => output.push_str("\\\""),
                Ok('\\') => output.push_str("\\\\"),
                Ok('\n') => output.push_str("\\n"),
                Ok('\r') => output.push_str("\\r"),
                Ok('\t') => output.push_str("\\t"),
                Ok('\u{0008}') => output.push_str("\\b"),
                Ok('\u{000c}') => output.push_str("\\f"),
                Ok(character) if character <= '\u{001f}' => {
                    use std::fmt::Write as _;
                    write!(output, "\\u{:04x}", character as u32).expect("write to String");
                }
                Ok(character) => output.push(character),
                Err(error) => {
                    // JS trimmed[0] preserves just the first UTF-16 code unit,
                    // including a lone high surrogate for an astral username.
                    use std::fmt::Write as _;
                    write!(output, "\\u{:04x}", error.unpaired_surrogate())
                        .expect("write to String");
                }
            }
        }
        output.push('"');
    }
}

enum Emit<'a> {
    Node(NodeId, bool),
    Literal(&'static str),
    Key(&'a JsString),
}

fn render(
    raw: &str,
    nodes: &[Node],
    actions: &[Action],
    rebuilt: &[bool],
    opaque: &[bool],
    masker: &Masker,
) -> String {
    let mut output = String::with_capacity(raw.len());
    let unmasked = Masker {
        replacements: vec![],
    };
    let mut pending = vec![Emit::Node(0, false)];
    while let Some(task) = pending.pop() {
        let (id, inherited_opaque) = match task {
            Emit::Literal(text) => {
                output.push_str(text);
                continue;
            }
            Emit::Key(key) => {
                unmasked.write_units(&mut output, &key.0);
                continue;
            }
            Emit::Node(id, inherited) => (id, inherited),
        };
        let skip_mask = inherited_opaque || opaque[id];
        let masker = if skip_mask { &unmasked } else { masker };
        match actions[id] {
            Action::Null => output.push_str("null"),
            Action::Redacted => masker.write_string(&mut output, REDACTED),
            Action::RedactedPlain | Action::Plain(_) => {
                output.push_str("{\"type\":");
                masker.write_string(&mut output, "plain");
                output.push_str(",\"value\":");
                if let Action::Plain(value) = actions[id] {
                    pending.push(Emit::Literal("}"));
                    pending.push(Emit::Node(value, skip_mask));
                } else {
                    masker.write_string(&mut output, REDACTED);
                    output.push('}');
                }
            }
            Action::Keep => match &nodes[id].kind {
                Kind::String(text) => masker.write_units(&mut output, &text.0),
                Kind::Scalar => output.push_str(&raw[nodes[id].span.clone()]),
                Kind::Object(fields) => {
                    output.push('{');
                    pending.push(Emit::Literal("}"));
                    // Legacy object rebuilding uses assignment to an ordinary
                    // JS object. The __proto__ setter never creates an own key.
                    let fields: Vec<_> = fields
                        .iter()
                        .filter(|field| {
                            !field.name.eq_str("__proto__") || (skip_mask && !rebuilt[id])
                        })
                        .collect();
                    for (index, field) in fields.iter().enumerate().rev() {
                        pending.push(Emit::Node(field.value, skip_mask));
                        pending.push(Emit::Literal(":"));
                        pending.push(Emit::Key(&field.name));
                        if index > 0 {
                            pending.push(Emit::Literal(","));
                        }
                    }
                }
                Kind::Array(values) => {
                    output.push('[');
                    pending.push(Emit::Literal("]"));
                    for (index, &value) in values.iter().enumerate().rev() {
                        pending.push(Emit::Node(value, skip_mask));
                        if index > 0 {
                            pending.push(Emit::Literal(","));
                        }
                    }
                }
            },
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn options(enabled: bool) -> Redaction {
        Redaction {
            enabled,
            user_names: vec!["alice".into()],
            home_dirs: vec![
                "/Users/alice".into(),
                "/home/alice".into(),
                "C:\\Users\\alice".into(),
            ],
            replacement: "*".into(),
        }
    }

    fn redact(value: Value, event: bool) -> Value {
        serde_json::from_str(&redact_json(&value.to_string(), &options(true), event).unwrap())
            .unwrap()
    }

    #[test]
    fn preserves_legacy_own_property_shape_without_materializing_prototypes() {
        for enabled in [false, true] {
            let value:Value=serde_json::from_str(&redact_json(r#"{"__proto__":{"private":"lost"},"nested":{"__proto__":1,"constructor":"alice"},"$serde_json::private::Number":"123"}"#,&options(enabled),false).unwrap()).unwrap();
            assert!(value.get("__proto__").is_none());
            assert!(value["nested"].get("__proto__").is_none());
            assert_eq!(
                value["nested"]["constructor"],
                if enabled { "a****" } else { "alice" }
            );
            assert_eq!(value["$serde_json::private::Number"], "123");
        }
    }

    #[test]
    fn event_records_keep_legacy_prototype_and_current_user_pass_order() {
        let raw = r#"{"payload":{"__proto__":{},"safe":"alice","password":"hidden","binding":{"type":"secret_ref","secretId":"alice","__proto__":{}}}}"#;
        let value: Value =
            serde_json::from_str(&redact_json(raw, &options(true), true).unwrap()).unwrap();
        assert!(value["payload"].get("__proto__").is_none());
        assert_eq!(value["payload"]["safe"], "alice");
        assert_eq!(value["payload"]["password"], REDACTED);
        assert_eq!(value["payload"]["binding"]["secretId"], "alice");
        assert_eq!(value["payload"]["binding"]["__proto__"], json!({}));
    }

    #[test]
    fn event_payload_root_truthiness_follows_js_after_numeric_normalization() {
        for enabled in [false, true] {
            for (raw, expected) in [
                ("null", "null"),
                ("false", "null"),
                ("0", "null"),
                ("-0", "null"),
                ("1e-400", "null"),
                ("-1e-400", "null"),
                (r#""""#, "null"),
                ("true", "true"),
                ("1", "1"),
                ("-1", "-1"),
                ("5e-324", "5e-324"),
                ("1e400", "null"),
                ("-1e400", "null"),
                (r#""0""#, r#""0""#),
                (
                    r#""alice""#,
                    if enabled { r#""a****""# } else { r#""alice""# },
                ),
                ("[]", "[]"),
                ("{}", "{}"),
                (r#"[false,0,""]"#, r#"[false,0,""]"#),
                (
                    r#"{"zero":0,"false":false,"empty":""}"#,
                    r#"{"zero":0,"false":false,"empty":""}"#,
                ),
            ] {
                let input = format!("{{\"payload\":{raw},\"sibling\":false}}");
                let actual: Value =
                    serde_json::from_str(&redact_json(&input, &options(enabled), true).unwrap())
                        .unwrap();
                assert_eq!(
                    actual["payload"],
                    serde_json::from_str::<Value>(expected).unwrap(),
                    "enabled={enabled}, payload={raw}"
                );
                assert_eq!(actual["sibling"], false);
            }
        }
    }

    #[test]
    fn event_jsonb_column_strings_are_decoded_once_before_redaction() {
        for enabled in [false, true] {
            for (input, expected) in [
                (r#"{"payload":"0"}"#, "null"),
                (r#"{"payload":"false"}"#, "null"),
                (r#"{"payload":"null"}"#, "null"),
                (r#"{"payload":"1e-400"}"#, "null"),
                (r#"{"payload":"1"}"#, "1"),
                (r#"{"payload":"[]"}"#, "[]"),
                (r#"{"payload":"\"0\""}"#, r#""0""#),
                (r#"{"payload":{"nested":"0"}}"#, r#"{"nested":"0"}"#),
                (
                    r#"{"payload":"alice"}"#,
                    if enabled { r#""a****""# } else { r#""alice""# },
                ),
            ] {
                let decoded = decode_event_payload_column(input).unwrap();
                let actual: Value =
                    serde_json::from_str(&redact_json(&decoded, &options(enabled), true).unwrap())
                        .unwrap();
                assert_eq!(
                    actual["payload"],
                    serde_json::from_str::<Value>(expected).unwrap(),
                    "enabled={enabled}, {input}"
                );
            }
        }
    }

    #[test]
    fn decoded_duplicate_properties_use_last_values_before_opaque_decisions() {
        for enabled in [false, true] {
            let masked = if enabled { "a****" } else { "alice" };
            for (column, expected) in [
                (
                    r#"{"__proto__":{},"__proto__":null,"safe":"alice"}"#,
                    json!({"safe":masked}),
                ),
                (
                    r#"{"__proto__":null,"__proto__":{},"safe":"alice"}"#,
                    json!({"safe":"alice"}),
                ),
                (
                    r#"{"nested":{"__proto__":{},"__proto__":null,"safe":"alice"},"safe":"alice"}"#,
                    json!({"nested":{"safe":masked},"safe":masked}),
                ),
                (
                    r#"{"nested":{"__proto__":null,"__proto__":{},"safe":"alice"},"safe":"alice"}"#,
                    json!({"nested":{"safe":"alice"},"safe":masked}),
                ),
                (
                    r#"{"__pro\u0074o__":{},"__proto__":null,"safe":"alice"}"#,
                    json!({"safe":masked}),
                ),
            ] {
                let input = json!({"payload":column}).to_string();
                let decoded = decode_event_payload_column(&input).unwrap();
                let actual: Value =
                    serde_json::from_str(&redact_json(&decoded, &options(enabled), true).unwrap())
                        .unwrap();
                assert_eq!(
                    actual["payload"], expected,
                    "enabled={enabled}, column={column}"
                );
            }
        }
    }

    #[test]
    fn last_wins_dedup_is_iterative_and_preserves_numeric_normalization() {
        let fields = object_fields(r#"{"first":0,"second":1,"first":9007199254740993}"#).unwrap();
        assert_eq!(
            fields,
            vec![("first".into(), "9007199254740993"), ("second".into(), "1")]
        );
        let column = format!(
            r#"{{"deep":{}{{"__proto__":{{}},"__proto__":null,"safe":"discarded","safe":"alice","n":0,"n":9007199254740993}}{}}}"#,
            "[".repeat(700),
            "]".repeat(700)
        );
        let input = json!({"payload":column}).to_string();
        for enabled in [false, true] {
            let decoded = decode_event_payload_column(&input).unwrap();
            let actual = redact_json(&decoded, &options(enabled), true).unwrap();
            assert!(!actual.contains("__proto__"));
            assert!(!actual.contains("discarded"));
            assert!(actual.contains("9007199254740992"));
            assert!(actual.contains(if enabled {
                r#""safe":"a****""#
            } else {
                r#""safe":"alice""#
            }));
        }
    }

    #[test]
    fn string_tokens_preserve_utf16_units_and_reject_invalid_escapes() {
        for raw in [
            r#""plain UTF8 中文 ☃ 😀""#,
            r#""escaped \" \\ \/ \b \f \n \r \t""#,
            r#""\ud83d\ude00""#,
        ] {
            let expected = serde_json::from_str::<String>(raw).unwrap();
            assert_eq!(
                decode_string_token(raw).unwrap().0,
                expected.encode_utf16().collect::<Vec<_>>()
            );
        }
        assert_eq!(
            decode_string_token(r#""\ud800a\uDC00""#).unwrap().0,
            vec![0xd800, 97, 0xdc00]
        );
        assert_eq!(
            decode_string_token(r#""😀""#).unwrap(),
            decode_string_token(r#""\uD83D\uDE00""#).unwrap()
        );
        for raw in [r#""\x""#, r#""\uZZZZ""#, r#""\u123""#, "not a token"] {
            assert!(decode_string_token(raw).is_err(), "{raw}");
        }
        assert!(secret_key(
            &decode_string_token(r#""pass\u0077ord\ud800""#).unwrap()
        ));
        assert!(jwt(
            &decode_string_token(r#""\u0061.\u0062.\u0063""#).unwrap()
        ));
        assert!(!jwt(&decode_string_token(r#""a.b.c\ud800""#).unwrap()));
    }

    #[test]
    fn lone_surrogates_never_bypass_decoded_secret_keys_or_username_masking() {
        let column = r#"{"pass\u0077ord\ud800":"TOP_SECRET","safe":"alice\ud800","before":"\udc00alice","pair":"\ud83d\ude00alice\ud800","nested":{"api\u004bey\ud800":"NESTED_SECRET","safe":"\ud800alice\udc00"}}"#;
        let input = json!({"payload":column}).to_string();
        for enabled in [false, true] {
            let decoded = decode_event_payload_column(&input).unwrap();
            let actual = redact_json(&decoded, &options(enabled), true).unwrap();
            let name = if enabled { "a****" } else { "alice" };
            assert_eq!(
                actual,
                format!(
                    r#"{{"payload":{{"password\ud800":"***REDACTED***","safe":"{name}\ud800","before":"\udc00{name}","pair":"😀{name}\ud800","nested":{{"apiKey\ud800":"***REDACTED***","safe":"\ud800{name}\udc00"}}}}}}"#
                )
            );
            assert!(!actual.contains("TOP_SECRET"));
            assert!(!actual.contains("NESTED_SECRET"));
        }
    }

    #[test]
    fn unpaired_key_duplicates_use_decoded_units_and_column_parse_stays_once() {
        let column = r#"{"pass\u0077ord\uD800":"DISCARDED","password\ud800":"TOP_SECRET","safe\uD800":"discarded","safe\ud800":"alice\ud800"}"#;
        let input = json!({"payload":column}).to_string();
        for enabled in [false, true] {
            let decoded = decode_event_payload_column(&input).unwrap();
            let actual = redact_json(&decoded, &options(enabled), true).unwrap();
            let name = if enabled { "a****" } else { "alice" };
            assert_eq!(
                actual,
                format!(
                    r#"{{"payload":{{"password\ud800":"***REDACTED***","safe\ud800":"{name}\ud800"}}}}"#
                )
            );
            for invalid in [r#"{"safe":"alice\x"}"#, r#"{"safe":"alice\uZZZZ"}"#] {
                let input = json!({"payload":invalid}).to_string();
                let decoded = decode_event_payload_column(&input).unwrap();
                assert_eq!(decoded, input);
                let actual: Value =
                    serde_json::from_str(&redact_json(&decoded, &options(enabled), true).unwrap())
                        .unwrap();
                assert_eq!(actual["payload"], invalid.replace("alice", name));
            }
        }
    }

    #[test]
    fn strict_options_require_camel_case_and_all_fields() {
        assert!(
            serde_json::from_str::<Redaction>(
                r#"{"userNames":[],"homeDirs":[],"replacement":"*"}"#
            )
            .is_ok()
        );
        for raw in [
            r#"{"enabled":true,"user_names":[],"homeDirs":[],"replacement":"*"}"#,
            r#"{"enabled":true,"userNames":[],"homeDirs":[],"replacement":"*","extra":0}"#,
            r#"{"enabled":true,"userNames":[],"homeDirs":[]}"#,
        ] {
            assert!(serde_json::from_str::<Redaction>(raw).is_err());
        }
    }

    #[test]
    fn masks_only_values_and_exact_ascii_username_boundaries() {
        let result = redact(
            json!({"alice": "alice/alice;alice", "nested": ["alice", {"path": "/Users/alice/project"}],
            "safe": "malice alice.app alice-test alice_name alice9", "unicode": "中alice文"}),
            false,
        );
        assert_eq!(
            result,
            json!({"alice":"a****/a****;a****", "nested":["a****",{"path":"/Users/a****/project"}],
            "safe":"malice alice.app alice-test alice_name alice9", "unicode":"中a****文"})
        );
    }

    #[test]
    fn masks_unix_windows_trailing_separators_and_longest_homes_first() {
        let mut opts = options(true);
        opts.home_dirs.extend([
            "/home/alice/work/".into(),
            " /home/alice ".into(),
            "////".into(),
        ]);
        opts.replacement = " fallback ".into();
        let raw = serde_json::to_string(&"/home/alice/work/file /home/alice/file C:\\Users\\alice\\file //// /Users/alice-extra").unwrap();
        assert_eq!(
            serde_json::from_str::<String>(&redact_json(&raw, &opts, false).unwrap()).unwrap(),
            "/home/a****/w***file /home/a****/file C:\\Users\\a****\\file fallback /Users/a****-extra"
        );
    }

    #[test]
    fn disabled_masking_still_normalizes_numbers_and_sanitizes_events() {
        let raw = r#"{"alice":"alice","payload":{"password":"alice","safe":"alice"},"n":[9007199254740993,1e400,-0,1.0790143258645723e-180],"$serde_json::private::Number":"123","$serde_json::private::RawValue":"alice"}"#;
        let result = redact_json(raw, &options(false), false).unwrap();
        assert!(result.contains("1.0790143258645723e-180"));
        let value: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["alice"], "alice");
        assert_eq!(value["payload"]["password"], "alice");
        assert_eq!(value["n"][0], 9_007_199_254_740_992_i64);
        assert_eq!(value["n"][1], Value::Null);
        assert_eq!(value["n"][2], 0);
        assert_eq!(value["$serde_json::private::Number"], "123");
        assert_eq!(value["$serde_json::private::RawValue"], "alice");
        let sanitized: Value =
            serde_json::from_str(&redact_json(raw, &options(false), true).unwrap()).unwrap();
        assert_eq!(sanitized["payload"]["password"], REDACTED);
        assert_eq!(sanitized["payload"]["safe"], "alice");
    }

    #[test]
    fn sanitizes_only_payload_and_preserves_binding_semantics() {
        let input = json!({
            "password": "outside", "message": "aaa.bbb.ccc alice",
            "payload": {
                "apiKey": 1, "AUTH_TOKEN": null, "safe": "aaa.bbb.ccc", "four": "a.b.c.d",
                "five": "a.b.c.d.e", "sentence": "JWT aaa.bbb.ccc alice", "author": "alice",
                "secret": {"type":"secret_ref", "secretId":"alice", "password":"keep", "extra":{"apiKey":"keep"}},
                "password": {"type":"plain", "value":{"safe":"alice"}, "extra":true},
                "invalidSecret": {"type":"secret_ref", "secretId":1},
                "plain": {"type":"plain", "value":"aaa.bbb.ccc", "extra":true},
                "nestedPlain": {"type":"plain", "value":{"password":"remove", "safe":"alice"}, "extra":true},
                "array": ["aaa.bbb.ccc", {"safe":"aaa.bbb.ccc"}, {"type":"plain", "value":"alice", "extra":true}]
            }, "other": {"payload":{"password":"outside"}}
        });
        let result = redact(input, true);
        assert_eq!(result["password"], "outside");
        assert_eq!(result["message"], "aaa.bbb.ccc a****");
        assert_eq!(result["other"]["payload"]["password"], "outside");
        let payload = &result["payload"];
        for key in [
            "apiKey",
            "AUTH_TOKEN",
            "safe",
            "four",
            "invalidSecret",
            "author",
        ] {
            assert_eq!(payload[key], REDACTED, "{key}");
        }
        assert_eq!(payload["five"], "a.b.c.d.e");
        assert_eq!(payload["sentence"], "JWT aaa.bbb.ccc a****");
        assert_eq!(
            payload["secret"],
            json!({"type":"secret_ref","secretId":"a****","password":"keep","extra":{"apiKey":"keep"}})
        );
        assert_eq!(
            payload["password"],
            json!({"type":"plain","value":REDACTED})
        );
        assert_eq!(
            payload["plain"],
            json!({"type":"plain","value":"aaa.bbb.ccc"})
        );
        assert_eq!(
            payload["nestedPlain"],
            json!({"type":"plain","value":{"password":REDACTED,"safe":"a****"}})
        );
        assert_eq!(
            payload["array"],
            json!(["aaa.bbb.ccc",{"safe":REDACTED},{"type":"plain","value":"a****"}])
        );
    }

    #[test]
    fn payload_root_binding_and_non_object_payloads_follow_legacy_behavior() {
        assert_eq!(
            redact(
                json!({"payload":{"type":"secret_ref","secretId":"id","password":"x"}}),
                true
            ),
            json!({"payload":{"type":"secret_ref","secretId":REDACTED,"password":REDACTED}})
        );
        assert_eq!(
            redact(
                json!({"payload":{"type":"plain","value":"a.b.c","extra":true}}),
                true
            ),
            json!({"payload":{"type":"plain","value":REDACTED,"extra":true}})
        );
        for payload in [
            Value::Null,
            json!("alice"),
            json!([{"password":"alice"}]),
            json!(42),
        ] {
            assert_eq!(
                redact(json!({"payload":payload}), true),
                redact(json!({"payload":payload}), false)
            );
        }
    }

    #[test]
    fn escapes_strings_and_preserves_first_utf16_unit_for_astral_names() {
        let mut opts = options(true);
        opts.user_names = vec![
            " 阿明 ".into(),
            "😀ab".into(),
            " x ".into(),
            "\u{feff}alice\u{feff}".into(),
        ];
        let result = redact_json(
            r#"{"q":"\"阿明\" \\ 😀ab x alice\n\t\u0000","阿明":"safe"}"#,
            &opts,
            false,
        )
        .unwrap();
        assert_eq!(
            result,
            "{\"q\":\"\\\"阿*\\\" \\\\ \\ud83d** x* a****\\n\\t\\u0000\",\"阿明\":\"safe\"}"
        );
    }

    #[test]
    fn preserves_very_deep_values_without_recursive_decode_or_drop() {
        let depth = 4096;
        let nested = format!(
            "{}{{\"safe\":\"alice\",\"password\":\"hidden\",\"n\":9007199254740993}}{}",
            "[".repeat(depth),
            "]".repeat(depth)
        );
        let raw = format!("{{\"payload\":{{\"data\":{nested}}}}}");
        let result = redact_json(&raw, &options(true), true).unwrap();
        assert!(
            result.contains(r#"{"safe":"a****","password":"***REDACTED***","n":9007199254740992}"#)
        );
        assert_eq!(result.matches('[').count(), depth);
        assert!(serde_json::from_str::<serde::de::IgnoredAny>(&result).is_ok());
        let fields = object_fields(&format!("{{\"type\":\"result\",\"data\":{nested}}}"))
            .unwrap()
            .into_iter()
            .map(|(key, value)| (key, value.to_owned()))
            .collect::<Vec<_>>();
        assert_eq!(fields[0], ("type".into(), "\"result\"".into()));
        assert_eq!(fields[1], ("data".into(), nested));
    }

    #[test]
    fn rejects_malformed_json_without_panicking() {
        for raw in [
            "",
            "NaN",
            "01",
            "[1,]",
            "{\"x\":1} trailing",
            "{\"x\"}",
            "[\"oops]",
        ] {
            assert!(redact_json(raw, &options(true), true).is_err(), "{raw}");
            assert!(object_fields(raw).is_err(), "{raw}");
        }
        assert!(object_fields("[]").is_err());
    }
}
