use super::*;
use rudder_d1_persistence::{
    StoreError,
    overview_reads::{OverviewReadError, OverviewReadInput, OverviewReadOperation, read_overview},
};
use time::OffsetDateTime;

pub(super) async fn read(pool: &sqlx::PgPool, org: &str, budget: bool) -> HttpResponse {
    let now = OffsetDateTime::now_utc();
    let Some(month_start) = calendar::start(now, true) else {
        return internal_error();
    };
    // Match the existing Node host-local month constructor for Dashboard.
    // D1 Budget overview retains its separate UTC month calculation.
    let input = OverviewReadInput {
        operation: if budget {
            OverviewReadOperation::BudgetOverview
        } else {
            OverviewReadOperation::DashboardSummary
        },
        now_ms: (now.unix_timestamp_nanos() / 1_000_000) as i64,
        host_local_month_start_ms: month_start.unix_timestamp() * 1000,
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
