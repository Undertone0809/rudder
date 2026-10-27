//! Literal public Messenger schemas. Group schemas strip unknown fields; Saved
//! View schemas are strict, including discriminated target/placement objects.
use serde_json::{Map, Value, json};
#[derive(Default)]
struct Check {
    issues: Vec<Value>,
}
impl Check {
    fn issue(&mut self, v: Value) {
        self.issues.push(v);
    }
    fn object(
        &mut self,
        v: Option<&Value>,
        path: &[Value],
        allowed: &[&str],
        strict: bool,
    ) -> Map<String, Value> {
        let Some(Value::Object(map)) = v else {
            self.issue(json!({"code":"invalid_type","expected":"object","received":received(v),"path":path,"message":if v.is_none(){"Required".to_owned()}else{format!("Expected object, received {}",received(v))}}));
            return Map::new();
        };
        if strict {
            let unknown = map
                .keys()
                .filter(|k| !allowed.contains(&k.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            if !unknown.is_empty() {
                self.issue(json!({"code":"unrecognized_keys","keys":unknown,"path":path,"message":format!("Unrecognized key(s) in object: {}",unknown.iter().map(|k|format!("'{k}'")).collect::<Vec<_>>().join(", "))}));
            }
        }
        map.iter()
            .filter(|(k, _)| allowed.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
    #[allow(clippy::too_many_arguments)]
    fn string(
        &mut self,
        map: &mut Map<String, Value>,
        key: &str,
        path: &[Value],
        min: usize,
        max: usize,
        optional: bool,
        nullable: bool,
        trim: bool,
        uuid: bool,
    ) {
        let mut at = path.to_vec();
        at.push(json!(key));
        let v = map.get(key);
        if optional && v.is_none() {
            return;
        }
        if nullable && v == Some(&Value::Null) {
            return;
        }
        let Some(Value::String(s)) = v else {
            self.issue(json!({"code":"invalid_type","expected":"string","received":received(v),"path":at,"message":if v.is_none(){"Required".to_owned()}else{format!("Expected string, received {}",received(v))}}));
            return;
        };
        let s = if trim { s.trim() } else { s }.to_owned();
        let len = s.encode_utf16().count();
        if len < min {
            self.issue(json!({"code":"too_small","minimum":min,"type":"string","inclusive":true,"exact":false,"message":format!("String must contain at least {min} character(s)"),"path":at}));
        }
        if len > max {
            self.issue(json!({"code":"too_big","maximum":max,"type":"string","inclusive":true,"exact":false,"message":format!("String must contain at most {max} character(s)"),"path":at}));
        }
        if uuid && (s.len() != 36 || uuid::Uuid::parse_str(&s).is_err()) {
            self.issue(json!({"validation":"uuid","code":"invalid_string","message":"Invalid uuid","path":at}));
        }
        map.insert(key.into(), json!(s));
    }
    fn boolean(
        &mut self,
        map: &Map<String, Value>,
        key: &str,
        path: &[Value],
        literal: Option<bool>,
    ) {
        let Some(v) = map.get(key) else {
            return;
        };
        let mut at = path.to_vec();
        at.push(json!(key));
        if let Some(expected) = literal {
            if v != &json!(expected) {
                self.issue(json!({"received":v,"code":"invalid_literal","expected":expected,"path":at,"message":format!("Invalid literal value, expected {expected}")}));
            }
        } else if !v.is_boolean() {
            self.issue(json!({"code":"invalid_type","expected":"boolean","received":received(Some(v)),"path":at,"message":format!("Expected boolean, received {}",received(Some(v)))}));
        }
    }
    fn custom(&mut self, path: Vec<Value>, message: &str) {
        self.issue(json!({"code":"custom","message":message,"path":path}));
    }
    fn array(
        &mut self,
        map: &mut Map<String, Value>,
        key: &str,
        min: usize,
        max: usize,
        uuid: bool,
        optional: bool,
    ) {
        let Some(v) = map.get(key) else {
            if !optional {
                self.issue(json!({"code":"invalid_type","expected":"array","received":"undefined","path":[key],"message":"Required"}));
            }
            return;
        };
        let Some(values) = v.as_array() else {
            self.issue(json!({"code":"invalid_type","expected":"array","received":received(Some(v)),"path":[key],"message":format!("Expected array, received {}",received(Some(v)))}));
            return;
        };
        let mut out = Vec::new();
        if values.len() < min {
            self.issue(json!({"code":"too_small","minimum":min,"type":"array","inclusive":true,"exact":false,"message":format!("Array must contain at least {min} element(s)"),"path":[key]}));
        }
        if values.len() > max {
            self.issue(json!({"code":"too_big","maximum":max,"type":"array","inclusive":true,"exact":false,"message":format!("Array must contain at most {max} element(s)"),"path":[key]}));
        }
        for (index, v) in values.iter().enumerate() {
            let mut entry = Map::from_iter([("value".into(), v.clone())]);
            let start = self.issues.len();
            self.string(
                &mut entry,
                "value",
                &[],
                if uuid { 0 } else { 1 },
                if uuid { usize::MAX } else { 240 },
                false,
                false,
                !uuid,
                uuid,
            );
            for issue in &mut self.issues[start..] {
                issue["path"] = json!([key, index]);
            }
            let value = entry.remove("value").unwrap();
            if !uuid
                && value.as_str().is_some_and(|s| {
                    s.starts_with("saved-view:")
                        && (s.len() != 47 || uuid::Uuid::parse_str(&s[11..]).is_err())
                })
            {
                self.custom(
                    vec![json!(key), json!(index)],
                    "Saved View item keys must contain a valid UUID",
                );
            }
            out.push(value);
        }
        map.insert(key.into(), json!(out));
    }
}
fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(_) => "object",
    }
}
fn target(c: &mut Check, v: Option<&Value>, path: &[Value]) -> Value {
    let kinds = [
        "browser",
        "automation",
        "library_document",
        "library_entry",
        "library_file",
        "library_directory",
        "local_app",
    ];
    let Some(kind) = v
        .and_then(|v| v["kind"].as_str())
        .filter(|k| kinds.contains(k))
    else {
        let mut at = path.to_vec();
        at.push(json!("kind"));
        c.issue(json!({"code":"invalid_union_discriminator","options":kinds,"path":at,"message":"Invalid discriminator value. Expected 'browser' | 'automation' | 'library_document' | 'library_entry' | 'library_file' | 'library_directory' | 'local_app'"}));
        return Value::Null;
    };
    let extra: &[&str] = match kind {
        "browser" => &["tabId", "url"],
        "automation" => &["automationId"],
        "library_document" => &["documentId"],
        "library_entry" => &["entryId", "path"],
        "library_file" => &["filePath"],
        "library_directory" => &["directoryPath"],
        _ => &["desktopInstallationId", "appPublicId", "localBindingId"],
    };
    let mut allowed = vec!["kind", "viewInstanceId"];
    allowed.extend(extra);
    let mut map = c.object(v, path, &allowed, true);
    c.string(
        &mut map,
        "viewInstanceId",
        path,
        1,
        1000,
        false,
        false,
        true,
        false,
    );
    for key in extra {
        let id = matches!(*key, "automationId" | "documentId" | "entryId");
        let portable = matches!(*key, "path" | "filePath" | "directoryPath");
        c.string(
            &mut map,
            key,
            path,
            if portable || id { 0 } else { 1 },
            if *key == "url" {
                8192
            } else if portable {
                4096
            } else {
                240
            },
            false,
            false,
            !portable,
            id,
        );
        if let Some(s) = map.get(*key).and_then(Value::as_str) {
            let mut at = path.to_vec();
            at.push(json!(key));
            if *key == "url"
                && !url::Url::parse(s)
                    .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
            {
                c.custom(at, "Browser URL must be an absolute HTTP(S) URL");
            } else if portable && !portable_path(s, *key == "directoryPath") {
                c.custom(
                    at,
                    if *key == "directoryPath" {
                        "Library directory path must be canonical and relative"
                    } else {
                        "Library path must be canonical and relative"
                    },
                );
            }
        }
    }
    Value::Object(map)
}
fn item_key(c: &mut Check, map: &Map<String, Value>, key: &str) {
    if map.get(key).and_then(Value::as_str).is_some_and(|s| {
        s.starts_with("saved-view:") && (s.len() != 47 || uuid::Uuid::parse_str(&s[11..]).is_err())
    }) {
        c.custom(
            vec![json!(key)],
            "Saved View item keys must contain a valid UUID",
        );
    }
}
fn portable_path(s: &str, root: bool) -> bool {
    (root && s.is_empty())
        || (!s.is_empty()
            && s.trim() == s
            && !s.starts_with('/')
            && !s.contains('\\')
            && !s
                .split('/')
                .any(|v| v.is_empty() || v == "." || v == ".." || v.starts_with('~'))
            && !s.split_once(':').is_some_and(|(v, _)| {
                v.starts_with(|c: char| c.is_ascii_alphabetic())
                    && v.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
            }))
}
/// The normalized object is the existing private command's input shape.
pub(super) fn normalize(operation: &str, raw: Option<&Value>) -> Result<Value, Value> {
    let mut c = Check::default();
    let strict = operation.starts_with("savedView");
    let allowed: &[&str] = match operation {
        "savedViewKeep" => &[
            "target",
            "title",
            "subtitle",
            "favicon",
            "clientMutationId",
            "primaryRailPinned",
            "placement",
        ],
        "savedViewUpdate" => &[
            "target",
            "title",
            "subtitle",
            "favicon",
            "primaryRailPinned",
            "hidden",
        ],
        "savedViewReorder" => &["ids"],
        "groupCreate" => &["name", "icon"],
        "groupUpdate" => &["name", "icon", "collapsed", "pinned", "sortOrder"],
        "groupMerge" => &[
            "name",
            "icon",
            "itemKeys",
            "threadKeys",
            "anchorItemKey",
            "autoGenerateName",
        ],
        "groupReorder" => &["groupIds"],
        "groupEntryAssign" => &["itemKey", "threadKey"],
        "groupEntryReorder" => &["itemKeys", "threadKeys"],
        "threadUserState" => &["pinned"],
        _ => &[],
    };
    let mut map = c.object(raw, &[], allowed, strict);
    if !raw.is_some_and(Value::is_object) {
        return Err(json!(c.issues));
    }
    if strict {
        if operation == "savedViewReorder" {
            c.array(&mut map, "ids", 0, 500, true, false);
            if let Some(ids) = map.get("ids").and_then(Value::as_array) {
                let mut seen = Vec::new();
                for (i, id) in ids.iter().enumerate() {
                    if seen.contains(id) {
                        c.custom(
                            vec![json!("ids"), json!(i)],
                            "Saved View ids must be unique",
                        );
                    }
                    seen.push(id.clone());
                }
            }
        } else {
            if operation == "savedViewKeep" || map.contains_key("target") {
                let value = target(&mut c, map.get("target"), &[json!("target")]);
                map.insert("target".into(), value);
            }
            c.string(
                &mut map,
                "title",
                &[],
                1,
                240,
                operation != "savedViewKeep",
                false,
                true,
                false,
            );
            c.string(&mut map, "subtitle", &[], 0, 1000, true, true, true, false);
            c.string(&mut map, "favicon", &[], 0, 65536, true, true, true, false);
            c.boolean(
                &map,
                "primaryRailPinned",
                &[],
                (operation == "savedViewKeep").then_some(true),
            );
            c.boolean(&map, "hidden", &[], Some(false));
            if operation == "savedViewKeep" {
                c.string(
                    &mut map,
                    "clientMutationId",
                    &[],
                    0,
                    usize::MAX,
                    false,
                    false,
                    false,
                    true,
                );
                let p = map.get("placement");
                let kind = p.and_then(|v| v["kind"].as_str()).unwrap_or("").to_owned();
                let allowed = match kind.as_str() {
                    "loose" => vec!["kind"],
                    "group" => vec!["kind", "groupId"],
                    "anchor" => vec!["kind", "anchor"],
                    _ => vec!["kind"],
                };
                let mut placement = c.object(p, &[json!("placement")], &allowed, true);
                match kind.as_str() {
                    "group" => c.string(
                        &mut placement,
                        "groupId",
                        &[json!("placement")],
                        0,
                        usize::MAX,
                        false,
                        false,
                        false,
                        true,
                    ),
                    "anchor" => {
                        let a = placement.get("anchor");
                        let k = a.and_then(|v| v["kind"].as_str()).unwrap_or("");
                        let key = if k == "chat" {
                            "conversationId"
                        } else {
                            "issueId"
                        };
                        let mut anchor = c.object(
                            a,
                            &[json!("placement"), json!("anchor")],
                            &["kind", key],
                            true,
                        );
                        if !["chat", "issue"].contains(&k) {
                            c.custom(
                                vec![json!("placement"), json!("anchor"), json!("kind")],
                                "Invalid discriminator value",
                            );
                        }
                        c.string(
                            &mut anchor,
                            key,
                            &[json!("placement"), json!("anchor")],
                            0,
                            usize::MAX,
                            false,
                            false,
                            false,
                            true,
                        );
                        placement.insert("anchor".into(), json!(anchor));
                    }
                    "loose" => (),
                    _ => c.custom(
                        vec![json!("placement"), json!("kind")],
                        "Invalid discriminator value",
                    ),
                }
                map.insert("placement".into(), json!(placement));
                if map.get("primaryRailPinned") == Some(&json!(true)) {
                    if map["target"]["kind"] != "local_app" {
                        c.custom(
                            vec![json!("primaryRailPinned")],
                            "Only Local App Saved Views can be pinned to the Primary Rail",
                        );
                    }
                    if kind != "loose" {
                        c.custom(
                            vec![json!("placement")],
                            "Local App Primary Rail pins must use loose placement",
                        );
                    }
                }
            } else if map.is_empty() {
                c.custom(vec![], "At least one field is required");
            }
        }
    } else {
        if matches!(operation, "groupCreate" | "groupMerge" | "groupUpdate") {
            c.string(
                &mut map,
                "name",
                &[],
                1,
                80,
                operation == "groupUpdate",
                false,
                true,
                false,
            );
            c.string(&mut map, "icon", &[], 1, 24, true, true, true, false);
        }
        for key in ["pinned", "collapsed", "autoGenerateName"] {
            c.boolean(&map, key, &[], None);
        }
        if let Some(v) = map.get("sortOrder") {
            if let Some(number) = v.as_f64() {
                if number.fract() != 0.0 {
                    c.issue(json!({"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["sortOrder"]}));
                }
                if number < 0.0 {
                    c.issue(json!({"code":"too_small","minimum":0,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 0","path":["sortOrder"]}));
                }
            } else {
                c.issue(json!({"code":"invalid_type","expected":"number","received":received(Some(v)),"message":format!("Expected number, received {}",received(Some(v))),"path":["sortOrder"]}));
            }
        }
        if operation == "groupReorder" {
            c.array(&mut map, "groupIds", 0, 200, true, false);
        }
        if matches!(operation, "groupMerge" | "groupEntryReorder") {
            let min = usize::from(operation == "groupMerge");
            let max = if operation == "groupMerge" { 50 } else { 500 };
            c.array(&mut map, "itemKeys", min, max, false, true);
            c.array(&mut map, "threadKeys", min, max, false, true);
            if !map.contains_key("itemKeys") && !map.contains_key("threadKeys") {
                c.custom(
                    vec![json!("itemKeys")],
                    "itemKeys or threadKeys is required",
                );
            }
            if map.contains_key("itemKeys")
                && map.contains_key("threadKeys")
                && map["itemKeys"] != map["threadKeys"]
            {
                c.custom(
                    vec![json!("itemKeys")],
                    "itemKeys and threadKeys must match",
                );
            }
            if !map.contains_key("itemKeys") {
                if let Some(v) = map.get("threadKeys").cloned() {
                    map.insert("itemKeys".into(), v);
                }
            }
            c.string(
                &mut map,
                "anchorItemKey",
                &[],
                1,
                240,
                true,
                false,
                true,
                false,
            );
            item_key(&mut c, &map, "anchorItemKey");
            if let Some(anchor) = map.get("anchorItemKey") {
                if map
                    .get("itemKeys")
                    .and_then(Value::as_array)
                    .is_some_and(|keys| !keys.contains(anchor))
                {
                    c.custom(
                        vec![json!("anchorItemKey")],
                        "anchorItemKey must be included in itemKeys",
                    );
                }
            }
            if operation == "groupEntryReorder" {
                if let Some(keys) = map.get("itemKeys").and_then(Value::as_array) {
                    let mut seen = Vec::new();
                    for key in keys {
                        if seen.contains(key) {
                            c.custom(
                                vec![json!(if raw.and_then(|v| v.get("itemKeys")).is_none() {
                                    "threadKeys"
                                } else {
                                    "itemKeys"
                                })],
                                "Messenger custom group reorder keys must be unique",
                            );
                            break;
                        }
                        seen.push(key.clone());
                    }
                }
            }
        }
        if operation == "groupEntryAssign" {
            for key in ["itemKey", "threadKey"] {
                c.string(&mut map, key, &[], 1, 240, true, false, true, false);
                item_key(&mut c, &map, key);
            }
            if !map.contains_key("itemKey") && !map.contains_key("threadKey") {
                c.custom(vec![json!("itemKey")], "itemKey or threadKey is required");
            }
            if map.contains_key("itemKey")
                && map.contains_key("threadKey")
                && map["itemKey"] != map["threadKey"]
            {
                c.custom(vec![json!("itemKey")], "itemKey and threadKey must match");
            }
            if !map.contains_key("itemKey") {
                if let Some(v) = map.get("threadKey").cloned() {
                    map.insert("itemKey".into(), v);
                }
            }
        }
    }
    if c.issues.is_empty() {
        Ok(json!(map))
    } else {
        Err(json!(c.issues))
    }
}
