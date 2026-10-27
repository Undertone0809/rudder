use super::*;
use rudder_d1_persistence::{
    StoreError,
    overview_reads::{OverviewReadError, OverviewReadInput, OverviewReadOperation, read_overview},
};
use time::{Date, OffsetDateTime};

pub(super) async fn read(pool: &sqlx::PgPool, org: &str, budget: bool) -> HttpResponse {
    let now = OffsetDateTime::now_utc();
    let Some(input) = read_input(now, budget, |now| calendar::start(now, true)) else {
        return internal_error();
    };
    match read_overview(pool, org, &input).await {
        Ok(body) => success(body),
        Err(OverviewReadError::MissingScope(scope)) => {
            error(StatusCode::NOT_FOUND, &format!("{scope} not found"))
        }
        Err(OverviewReadError::Store(StoreError::InvalidInput)) => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid Overview read request",
        ),
        Err(_) => internal_error(),
    }
}

fn read_input(
    now: OffsetDateTime,
    budget: bool,
    local_month_start: impl FnOnce(OffsetDateTime) -> Option<OffsetDateTime>,
) -> Option<OverviewReadInput> {
    let month_start = if budget {
        // Budget uses UTC windows and must not depend on host offset support.
        // Its validated, otherwise unused local-month field can use UTC too.
        Date::from_calendar_date(now.year(), now.month(), 1)
            .ok()?
            .midnight()
            .assume_utc()
    } else {
        // Dashboard preserves the existing Node host-local month constructor.
        local_month_start(now)?
    };
    Some(OverviewReadInput {
        operation: if budget {
            OverviewReadOperation::BudgetOverview
        } else {
            OverviewReadOperation::DashboardSummary
        },
        now_ms: (now.unix_timestamp_nanos() / 1_000_000) as i64,
        host_local_month_start_ms: month_start.unix_timestamp() * 1000,
        legacy_date_timezone: Some("UTC".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::format_description::well_known::Rfc3339;

    #[test]
    fn budget_overview_uses_utc_month_without_consulting_host_offset() {
        let now = OffsetDateTime::parse("2026-02-28T17:00:00Z", &Rfc3339).unwrap();
        let input =
            read_input(now, true, |_| panic!("Budget must not query local offset")).unwrap();
        let start = OffsetDateTime::parse("2026-02-01T00:00:00Z", &Rfc3339).unwrap();
        assert_eq!(input.operation, OverviewReadOperation::BudgetOverview);
        assert_eq!(
            input.host_local_month_start_ms,
            start.unix_timestamp() * 1000
        );
        assert!(input.validate().is_ok());
    }

    #[test]
    fn dashboard_preserves_local_month_and_requires_available_offset() {
        let now = OffsetDateTime::parse("2026-02-28T17:00:00Z", &Rfc3339).unwrap();
        assert!(read_input(now, false, |_| None).is_none());
        let start = OffsetDateTime::parse("2026-02-28T16:00:00Z", &Rfc3339).unwrap();
        let input = read_input(now, false, |_| Some(start)).unwrap();
        assert_eq!(input.operation, OverviewReadOperation::DashboardSummary);
        assert_eq!(
            input.host_local_month_start_ms,
            start.unix_timestamp() * 1000
        );
        assert!(input.validate().is_ok());
    }
}
