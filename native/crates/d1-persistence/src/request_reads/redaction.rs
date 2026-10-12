//! Request payload compatibility at the public JSON boundary. The arena walk
//! follows the existing Run sanitizer without importing its username masking or
//! imposing a recursive Value/depth limit on persisted JSON.
use crate::legacy_read_json::normalize_legacy_read_json;
use serde::de::Error as _;
use std::{collections::HashMap, ops::Range};
type NodeId = usize;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct JsString(Vec<u16>);

impl JsString {
    fn eq_str(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.encode_utf16())
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

// postgres-js decodes JSONB and Drizzle parses a string-valued column once more.
fn column(raw: &str) -> String {
    match serde_json::from_str::<String>(raw) {
        Ok(decoded) if serde_json::from_str::<serde::de::IgnoredAny>(&decoded).is_ok() => decoded,
        _ => raw.to_owned(),
    }
}
fn encode(raw: &str, sanitize_payload: bool) -> Result<String, serde_json::Error> {
    // Decide JS truthiness before JSON.stringify changes Infinity to null.
    let raw = column(raw);
    let trimmed = raw.trim();
    if sanitize_payload
        && (matches!(trimmed, "null" | "false" | "\"\"")
            || trimmed.parse::<f64>().is_ok_and(|n| n == 0.0))
    {
        return Ok("{}".into());
    }
    let normalized = normalize_legacy_read_json(&raw)?;
    let nodes = parse_validated(&normalized)?;
    let mut actions = vec![Action::Keep; nodes.len()];
    let mut rebuilt = vec![false; nodes.len()];
    if sanitize_payload && matches!(nodes[0].kind, Kind::Object(_)) {
        sanitize(&nodes, &mut actions, &mut rebuilt, 0);
    }
    Ok(render(&normalized, &nodes, &actions, &rebuilt))
}
/// The row projection is shallow; opaque column values remain raw until their
/// own Drizzle/redaction boundary. No result is parsed again by Node.
pub(crate) fn row(raw: &str, approval: bool) -> Result<String, serde_json::Error> {
    serde_json::from_str::<serde::de::IgnoredAny>(raw)?;
    let nodes = parse_validated(raw)?;
    let Kind::Object(fields) = &nodes[0].kind else {
        return Err(serde_json::Error::custom("request row must be an object"));
    };
    let mut output = String::from("{");
    let mut has_payload = false;
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        write_string(&mut output, &field.name.0);
        output.push(':');
        let value = &raw[nodes[field.value].span.clone()];
        let payload = field.name.eq_str("payload");
        has_payload |= payload;
        if payload || field.name.eq_str("metadata") {
            output.push_str(&encode(value, approval && payload)?);
        } else {
            output.push_str(&normalize_legacy_read_json(value)?);
        }
    }
    if approval && !has_payload {
        output.push_str(",\"payload\":{}");
    }
    output.push('}');
    Ok(output)
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

fn sanitize(nodes: &[Node], actions: &mut [Action], rebuilt: &mut [bool], root: NodeId) {
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

#[derive(Clone, Copy)]
enum Action {
    Keep,
    Redacted,
    RedactedPlain,
    Plain(NodeId),
}
fn write_string(output: &mut String, units: &[u16]) {
    use std::fmt::Write as _;
    output.push('"');
    for character in char::decode_utf16(units.iter().copied()) {
        match character {
            Ok('"') => output.push_str("\\\""),
            Ok('\\') => output.push_str("\\\\"),
            Ok(c) if c <= '\u{001f}' => {
                write!(output, "\\u{:04x}", c as u32).unwrap();
            }
            Ok(c) => output.push(c),
            Err(e) => {
                write!(output, "\\u{:04x}", e.unpaired_surrogate()).unwrap();
            }
        }
    }
    output.push('"');
}
enum Emit<'a> {
    Node(NodeId),
    Literal(&'static str),
    Key(&'a JsString),
}
fn render(raw: &str, nodes: &[Node], actions: &[Action], rebuilt: &[bool]) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut pending = vec![Emit::Node(0)];
    while let Some(task) = pending.pop() {
        let id = match task {
            Emit::Literal(text) => {
                output.push_str(text);
                continue;
            }
            Emit::Key(key) => {
                write_string(&mut output, &key.0);
                continue;
            }
            Emit::Node(id) => id,
        };
        match actions[id] {
            Action::Redacted => output.push_str("\"***REDACTED***\""),
            Action::RedactedPlain => {
                output.push_str("{\"type\":\"plain\",\"value\":\"***REDACTED***\"}")
            }
            Action::Plain(value) => {
                output.push_str("{\"type\":\"plain\",\"value\":");
                pending.push(Emit::Literal("}"));
                pending.push(Emit::Node(value));
            }
            Action::Keep => match &nodes[id].kind {
                Kind::String(text) => write_string(&mut output, &text.0),
                Kind::Scalar => output.push_str(&raw[nodes[id].span.clone()]),
                Kind::Object(fields) => {
                    output.push('{');
                    pending.push(Emit::Literal("}"));
                    let fields: Vec<_> = fields
                        .iter()
                        .filter(|f| !rebuilt[id] || !f.name.eq_str("__proto__"))
                        .collect();
                    for (index, field) in fields.iter().enumerate().rev() {
                        pending.push(Emit::Node(field.value));
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
                    for (index, value) in values.iter().enumerate().rev() {
                        pending.push(Emit::Node(*value));
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
