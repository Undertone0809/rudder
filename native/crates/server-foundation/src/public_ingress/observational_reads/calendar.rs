//! Host-local business calendar boundaries, independent of UTC wire dates.
use time::{Date, OffsetDateTime, UtcOffset};

pub(super) fn start(now: OffsetDateTime, month: bool) -> Option<OffsetDateTime> {
    start_with_offset(now, month, |instant| {
        UtcOffset::local_offset_at(instant).ok()
    })
}

fn start_with_offset(
    now: OffsetDateTime,
    month: bool,
    offset_at: impl Fn(OffsetDateTime) -> Option<UtcOffset>,
) -> Option<OffsetDateTime> {
    let local = now.to_offset(offset_at(now)?);
    let date = if month {
        Date::from_calendar_date(local.year(), local.month(), 1).ok()?
    } else {
        local.date()
    };
    let midnight = date.midnight();
    // Resolve the offset at the boundary rather than reusing today's offset:
    // a month can contain a daylight-saving transition.
    let provisional = midnight.assume_offset(local.offset());
    let boundary = midnight.assume_offset(offset_at(provisional)?);
    Some(boundary.to_offset(UtcOffset::UTC))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::format_description::well_known::Rfc3339;

    #[test]
    fn local_day_and_month_follow_shanghai_calendar_at_utc_rollover() {
        let now = OffsetDateTime::parse("2026-02-28T17:00:00Z", &Rfc3339).unwrap();
        let offset = UtcOffset::from_hms(8, 0, 0).unwrap();
        for month in [false, true] {
            let start = start_with_offset(now, month, |_| Some(offset)).unwrap();
            assert_eq!(start.format(&Rfc3339).unwrap(), "2026-02-28T16:00:00Z");
        }
    }

    #[test]
    fn month_boundary_uses_its_own_offset_when_current_offset_changed() {
        let now = OffsetDateTime::parse("2026-03-20T12:00:00Z", &Rfc3339).unwrap();
        let transition = OffsetDateTime::parse("2026-03-08T07:00:00Z", &Rfc3339).unwrap();
        let start = start_with_offset(now, true, |instant| {
            UtcOffset::from_hms(if instant < transition { -5 } else { -4 }, 0, 0).ok()
        })
        .unwrap();
        assert_eq!(start.format(&Rfc3339).unwrap(), "2026-03-01T05:00:00Z");
    }
}
