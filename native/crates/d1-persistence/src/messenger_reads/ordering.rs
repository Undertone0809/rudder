use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::cmp::Ordering;
pub(super) fn compare(
    c: &Context<'_>,
    a: &Value,
    b: &Value,
    pinned: bool,
    chronological: bool,
) -> Ordering {
    let pin = if pinned {
        truth(b, "isPinned").cmp(&truth(a, "isPinned"))
    } else {
        Ordering::Equal
    };
    let at = millis(&a["latestActivityAt"]).unwrap_or(i128::MIN);
    let bt = millis(&b["latestActivityAt"]).unwrap_or(i128::MIN);
    pin.then_with(|| {
        if chronological {
            at.cmp(&bt)
        } else {
            bt.cmp(&at)
        }
    })
    .then_with(|| c.collator.compare(text(a, "title"), text(b, "title")))
    .then_with(|| {
        if chronological {
            Ordering::Equal
        } else {
            c.collator
                .compare(text(a, "threadKey"), text(b, "threadKey"))
        }
    })
}
pub(super) fn encode_thread(item: &Value) -> String {
    URL_SAFE_NO_PAD.encode(json!({"activityAt":item["latestActivityAt"].as_str().unwrap_or("1970-01-01T00:00:00.000Z"),"title":item["title"],"threadKey":item["threadKey"],"isPinned":truth(item,"isPinned")}).to_string())
}
pub(super) fn decode(raw: &str) -> Option<Value> {
    use base64::{
        alphabet,
        engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    };
    let mut data = raw
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(|b| match b {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(b),
            _ => None,
        })
        .collect::<Vec<_>>();
    if data.len() % 4 == 1 {
        data.pop();
    }
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    serde_json::from_slice(&decoder.decode(data).ok()?).ok()
}
pub(super) fn decode_thread(raw: Option<&str>) -> Option<Value> {
    let v = decode(raw?)?;
    millis(&v["activityAt"])?;
    if !v["title"].is_string() || text(&v, "threadKey").is_empty() {
        return None;
    }
    Some(
        json!({"latestActivityAt":v["activityAt"],"title":v["title"],"threadKey":v["threadKey"],"isPinned":truth(&v,"isPinned")}),
    )
}
