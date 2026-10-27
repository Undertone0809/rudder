use super::*;
use rudder_d1_persistence::{
    StoreError,
    overview_reads::{OverviewReadError, OverviewReadInput, OverviewReadOperation, read_overview},
};
use time::{Date, OffsetDateTime};

pub(super) async fn read(pool: &sqlx::PgPool, org: &str, budget: bool) -> HttpResponse {
    let now = OffsetDateTime::now_utc();
    let Ok(month) = Date::from_calendar_date(now.year(), now.month(), 1) else {
        return internal_error();
    };
    // One Rust clock supplies both the instant and UTC calendar month boundary.
    let input = OverviewReadInput {
        operation: if budget {
            OverviewReadOperation::BudgetOverview
        } else {
            OverviewReadOperation::DashboardSummary
        },
        now_ms: (now.unix_timestamp_nanos() / 1_000_000) as i64,
        host_local_month_start_ms: month.midnight().assume_utc().unix_timestamp() * 1000,
        legacy_date_timezone: Some("UTC".into()),
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
