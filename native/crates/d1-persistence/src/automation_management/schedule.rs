//! Literal five-field cron contract shared by Automation management and
//! execution. IANA rules come from chrono-tz, never process-local TZ or a
//! parallel scheduler implementation.
use super::*;
use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};
use std::collections::BTreeSet;
const SPECS: [(i64, i64, &str); 5] = [
    (0, 59, "minute"),
    (0, 23, "hour"),
    (1, 31, "day of month"),
    (1, 12, "month"),
    (0, 6, "day of week"),
];
fn space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}
pub(super) fn trim(s: &str) -> &str {
    s.trim_matches(space)
}
fn integer(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(space);
    let bytes = s.as_bytes();
    let sign = if bytes.first() == Some(&b'-') { -1 } else { 1 };
    let start = usize::from(matches!(bytes.first().copied(), Some(b'-' | b'+')));
    let end = bytes[start..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count()
        + start;
    (end > start).then(|| {
        s[start..end]
            .parse::<i64>()
            .unwrap_or(i64::MAX)
            .saturating_mul(sign)
    })
}
fn fail(message: impl Into<String>) -> Error {
    http(422, message)
}
fn bounds(value: i64, min: i64, max: i64, name: &str) -> Result<()> {
    if value < min || value > max {
        Err(fail(format!(
            "Value {value} out of range [{min}–{max}] for cron {name} field"
        )))
    } else {
        Ok(())
    }
}
fn field(token: &str, spec: (i64, i64, &str)) -> Result<BTreeSet<i64>> {
    let (min, max, name) = spec;
    let mut values = BTreeSet::new();
    for raw in token.split(',') {
        let part = trim(raw);
        if part.is_empty() {
            return Err(fail(format!("Empty element in cron {name} field")));
        }
        if let Some((base, step)) = part.split_once('/') {
            let step = integer(step)
                .filter(|n| *n > 0)
                .ok_or_else(|| fail(format!("Invalid step \"{step}\" in cron {name} field")))?;
            let (start, end) = if base == "*" {
                (min, max)
            } else if base.contains('-') {
                let mut range = base.split('-');
                let a = range.next().and_then(integer);
                let b = range.next().and_then(integer);
                match (a, b) {
                    (Some(a), Some(b)) => (a, b),
                    _ => {
                        return Err(fail(format!(
                            "Invalid range \"{base}\" in cron {name} field"
                        )));
                    }
                }
            } else {
                (
                    integer(base).ok_or_else(|| {
                        fail(format!("Invalid start \"{base}\" in cron {name} field"))
                    })?,
                    max,
                )
            };
            bounds(start, min, max, name)?;
            bounds(end, min, max, name)?;
            let mut n = start;
            while n <= end {
                values.insert(n);
                let Some(next) = n.checked_add(step) else {
                    break;
                };
                n = next;
            }
        } else if part.contains('-') {
            let mut range = part.split('-');
            let a = range.next().and_then(integer);
            let b = range.next().and_then(integer);
            let (a, b) = match (a, b) {
                (Some(a), Some(b)) => (a, b),
                _ => {
                    return Err(fail(format!(
                        "Invalid range \"{part}\" in cron {name} field"
                    )));
                }
            };
            bounds(a, min, max, name)?;
            bounds(b, min, max, name)?;
            if a > b {
                return Err(fail(format!(
                    "Invalid range {a}-{b} in cron {name} field (start > end)"
                )));
            }
            values.extend(a..=b);
        } else if part == "*" {
            values.extend(min..=max);
        } else {
            let n = integer(part)
                .ok_or_else(|| fail(format!("Invalid value \"{part}\" in cron {name} field")))?;
            bounds(n, min, max, name)?;
            values.insert(n);
        }
    }
    if values.is_empty() {
        return Err(fail(format!("Empty result for cron {name} field")));
    }
    Ok(values)
}
fn parse(expression: &str) -> Result<Vec<BTreeSet<i64>>> {
    let expression = trim(expression);
    if expression.is_empty() {
        return Err(fail("Cron expression must not be empty"));
    }
    let tokens = expression
        .split(space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if tokens.len() != 5 {
        return Err(fail(format!(
            "Cron expression must have exactly 5 fields, got {}: \"{expression}\"",
            tokens.len()
        )));
    }
    tokens
        .iter()
        .zip(SPECS)
        .map(|(token, spec)| field(token, spec))
        .collect()
}
#[derive(Clone, Copy)]
enum Zone {
    Iana(chrono_tz::Tz),
    Fixed(FixedOffset),
}
fn zone(raw: &str) -> Result<Zone> {
    let invalid = || fail(format!("Invalid timezone: {raw}"));
    if !raw.is_ascii() {
        return Err(invalid());
    }
    if raw.starts_with('+') || raw.starts_with('-') {
        let sign = if raw.starts_with('-') { -1 } else { 1 };
        let value = &raw[1..];
        let parts = value.split(':').collect::<Vec<_>>();
        let (hour, minute) = match parts.as_slice() {
            [v] if v.len() == 2 => (*v, "00"),
            [v] if v.len() == 4 => (&v[..2], &v[2..]),
            [h, m] if h.len() == 2 && m.len() == 2 => (*h, *m),
            _ => return Err(invalid()),
        };
        if !hour.bytes().all(|c| c.is_ascii_digit()) || !minute.bytes().all(|c| c.is_ascii_digit())
        {
            return Err(invalid());
        }
        let hour: i32 = hour.parse().map_err(|_| invalid())?;
        let minute: i32 = minute.parse().map_err(|_| invalid())?;
        if hour > 23 || minute > 59 {
            return Err(invalid());
        }
        return FixedOffset::east_opt(sign * (hour * 3600 + minute * 60))
            .map(Zone::Fixed)
            .ok_or_else(invalid);
    }
    raw.parse::<chrono_tz::Tz>()
        .ok()
        .or_else(|| {
            chrono_tz::TZ_VARIANTS
                .iter()
                .copied()
                .find(|z| z.name().eq_ignore_ascii_case(raw))
        })
        .map(Zone::Iana)
        .ok_or_else(invalid)
}
pub(crate) fn stamp(ms: i64) -> Result<String> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| http(500, "Internal server error"))
}
pub(crate) fn next_tick(expression: &str, time_zone: &str, after: i64) -> Result<Option<i64>> {
    // Legacy validates timezone before cron, even when both are invalid.
    let zone = zone(time_zone)?;
    let cron = parse(expression)?;
    let mut cursor = after
        .div_euclid(60_000)
        .checked_add(1)
        .and_then(|v| v.checked_mul(60_000))
        .ok_or_else(|| http(500, "Internal server error"))?;
    for _ in 0..366 * 24 * 60 * 5 {
        let date = DateTime::<Utc>::from_timestamp_millis(cursor)
            .ok_or_else(|| http(500, "Internal server error"))?;
        let parts = match zone {
            Zone::Iana(z) => {
                let d = date.with_timezone(&z);
                [
                    d.minute() as i64,
                    d.hour() as i64,
                    d.day() as i64,
                    d.month() as i64,
                    d.weekday().num_days_from_sunday() as i64,
                ]
            }
            Zone::Fixed(z) => {
                let d = date.with_timezone(&z);
                [
                    d.minute() as i64,
                    d.hour() as i64,
                    d.day() as i64,
                    d.month() as i64,
                    d.weekday().num_days_from_sunday() as i64,
                ]
            }
        };
        if cron
            .iter()
            .zip(parts)
            .all(|(set, part)| set.contains(&part))
        {
            return Ok(Some(cursor));
        }
        cursor = cursor
            .checked_add(60_000)
            .ok_or_else(|| http(500, "Internal server error"))?;
    }
    Ok(None)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }
    #[test]
    fn preserves_iana_boundaries_dst_and_numeric_offsets() {
        for (cron, zone, start, end) in [
            (
                "0 0 * * *",
                "Asia/Shanghai",
                "2026-10-27T15:59:00Z",
                "2026-10-27T16:00:00Z",
            ),
            (
                "30 2 * * *",
                "America/New_York",
                "2026-03-08T06:00:00Z",
                "2026-03-09T06:30:00Z",
            ),
            (
                "30 1 * * *",
                "US/Eastern",
                "2026-11-01T05:30:00Z",
                "2026-11-01T06:30:00Z",
            ),
            (
                "0 0 * * *",
                "+08:00",
                "2026-10-27T15:59:00Z",
                "2026-10-27T16:00:00Z",
            ),
        ] {
            assert_eq!(next_tick(cron, zone, ms(start)).unwrap(), Some(ms(end)));
        }
    }
    #[test]
    fn preserves_node_decimal_prefix_and_dom_and_dow() {
        assert_eq!(parse("0x10 1 * * *").unwrap()[0], BTreeSet::from([0]));
        assert_eq!(
            parse("1suffix 2/3ignored * * *").unwrap()[0],
            BTreeSet::from([1])
        );
        assert!(
            next_tick("0 1 1 * 1", "UTC", ms("2026-10-01T00:00:00Z"))
                .unwrap()
                .is_some_and(|m| DateTime::<Utc>::from_timestamp_millis(m).unwrap().day() == 1)
        );
        assert_eq!(
            stamp(ms("0044-01-01T00:00:00Z")).unwrap(),
            "0044-01-01T00:00:00.000Z"
        );
    }
    #[test]
    fn matches_current_node_calendar_oracle() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("schedule-cases.json")).unwrap();
        for case in cases {
            let start = DateTime::parse_from_rfc3339(case["after"].as_str().unwrap())
                .unwrap()
                .timestamp_millis();
            let result = next_tick(
                case["expression"].as_str().unwrap(),
                case["timezone"].as_str().unwrap(),
                start,
            )
            .unwrap()
            .map(stamp)
            .transpose()
            .unwrap();
            assert_eq!(json!(result), case["next"], "{case}");
        }
    }
}
