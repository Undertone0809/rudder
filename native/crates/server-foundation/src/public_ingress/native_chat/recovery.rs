//! Read-only recovery discovery stays Rust-owned even when dispatch is disabled.
use super::*;

pub(super) async fn read(
    state: web::Data<IngressState>,
    request: HttpRequest,
    chat: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    if let Err(response) = canonical(&request, &chat, "recovery") {
        return *response;
    }
    if !body.is_empty() || !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "input_not_allowed");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return unavailable(),
    };
    let (pool, actor) = match principal(&state, &request, &chat, false).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    result(control::read_recovery_state(&pool, &actor, &chat).await)
}
