//! Standalone Assets use the same native storage, auth, audit, and rows as Issues.
use super::*;
use actix_multipart::Multipart;
use futures_util::{StreamExt, stream};
use rudder_d1_persistence::{
    assets as domain,
    issue_attachments::{IssueAttachmentActor, IssueAttachmentError},
    issue_core_writes::IssueAssetStorage,
};
use serde_json::json;

const SVG: &str = "image/svg+xml";
const DEFAULT_MAX: usize = 10 * 1024 * 1024;
#[derive(Debug, PartialEq)]
enum Endpoint {
    Image(String),
    Logo(String),
    Content(String),
}
fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let parts = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    if parts.iter().any(|p| p.is_empty()) || !parts.first()?.eq_ignore_ascii_case("api") {
        return None;
    }
    match parts.as_slice() {
        [_, orgs, org, assets, images]
            if orgs.eq_ignore_ascii_case("orgs")
                && assets.eq_ignore_ascii_case("assets")
                && images.eq_ignore_ascii_case("images")
                && *method == Method::POST =>
        {
            Some(Endpoint::Image((*org).into()))
        }
        [_, orgs, org, logo]
            if orgs.eq_ignore_ascii_case("orgs")
                && logo.eq_ignore_ascii_case("logo")
                && *method == Method::POST =>
        {
            Some(Endpoint::Logo((*org).into()))
        }
        [_, assets, id, content]
            if assets.eq_ignore_ascii_case("assets")
                && content.eq_ignore_ascii_case("content")
                && matches!(*method, Method::GET | Method::HEAD) =>
        {
            Some(Endpoint::Content((*id).into()))
        }
        _ => None,
    }
}
pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint(path, method).is_some()
}
pub(super) async fn handle(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint(request.uri().path(), request.method()) else {
        return error(404, "Asset not found");
    };
    let (identity, actor, session_id, run_id) =
        match issue_core::public_issue_actor(&state, &request).await {
            Ok(actor) => actor,
            Err(response) => return response,
        };
    if !matches!(endpoint, Endpoint::Content(_))
        && matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return error(403, crate::local_account_ingress::BOARD_ORIGIN_ERROR);
    }
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return error(401, "Unauthorized");
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return error(503, "Rust assets are unavailable");
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => return error(503, "Request queue full"),
    };
    if let Endpoint::Content(id) = &endpoint {
        let Some(id) = canonical(id) else {
            return error(404, "Asset not found");
        };
        let asset = match domain::content(pool, &id, &authorizer).await {
            Ok(Some(asset)) => asset,
            Ok(None) => return error(404, "Asset not found"),
            Err(err) => return domain_error(err),
        };
        let Some(storage) = state.config.issue_asset_storage.as_deref() else {
            return error(503, "Rust asset storage is unavailable");
        };
        let object = match storage.get_object(&asset.org_id, &asset.object_key).await {
            Ok(object) => object,
            Err(err) => {
                tracing::warn!(%err,"Asset read failed");
                return error(500, "Internal server error");
            }
        };
        let ct = if asset.content_type.is_empty() {
            object
                .content_type
                .as_deref()
                .unwrap_or("application/octet-stream")
        } else {
            &asset.content_type
        };
        let html = ct
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case("text/html");
        let download = html
            || url::form_urlencoded::parse(request.query_string().as_bytes())
                .any(|(k, v)| k == "download" && v == "1");
        let filename = asset
            .filename
            .as_deref()
            .unwrap_or("asset")
            .replace('"', "");
        let mut response = HttpResponse::Ok();
        response.insert_header((
            header::CONTENT_TYPE,
            if html { "application/octet-stream" } else { ct },
        ));
        response.insert_header((
            header::CONTENT_LENGTH,
            if asset.byte_size > 0 {
                asset.byte_size.to_string()
            } else {
                object.body.len().to_string()
            },
        ));
        response.insert_header((header::CACHE_CONTROL, "private, max-age=60"));
        response.insert_header(("x-content-type-options", "nosniff"));
        if ct == SVG {
            response.insert_header((
                "content-security-policy",
                "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
            ));
        } else if html {
            response.insert_header(("content-security-policy","sandbox; default-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"));
        }
        response.insert_header((
            header::CONTENT_DISPOSITION,
            format!(
                "{}; filename=\"{}\"",
                if download { "attachment" } else { "inline" },
                filename
            ),
        ));
        return response.body(object.body);
    }
    let logo = matches!(endpoint, Endpoint::Logo(_));
    let org = match endpoint {
        Endpoint::Image(org) | Endpoint::Logo(org) => org,
        Endpoint::Content(_) => unreachable!(),
    };
    let Some(org) = canonical(&org) else {
        return error(404, "Organization not found");
    };
    if let Err(err) = domain::validate_access(pool, &org, &authorizer).await {
        return domain_error(err);
    }
    let Some(storage) = state.config.issue_asset_storage.as_deref() else {
        return error(503, "Rust asset storage is unavailable");
    };
    let max = max_bytes();
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return error(400, "Invalid request body");
        };
        if body.len().saturating_add(chunk.len()) > max.saturating_add(1024 * 1024) {
            return too_large(logo);
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    let mut multipart = Multipart::new(
        request.headers(),
        stream::once(
            async move { Ok::<_, actix_web::error::PayloadError>(web::Bytes::from(body)) },
        ),
    );
    let mut file = None;
    let mut namespace = None;
    while let Some(field) = multipart.next().await {
        let Ok(mut field) = field else {
            return error(400, "Invalid asset form");
        };
        let name = field.name().unwrap_or_default().to_owned();
        let filename = field
            .content_disposition()
            .and_then(|v| v.get_filename())
            .map(str::to_owned);
        if let Some(filename) = filename {
            if name != "file" || file.is_some() {
                return error(400, "Unexpected field");
            }
            let ct = field
                .content_type()
                .map(|v| v.essence_str().to_ascii_lowercase())
                .unwrap_or_else(|| "application/octet-stream".into());
            let bytes = match field.bytes(max).await {
                Ok(Ok(bytes)) => bytes,
                Err(_) => return too_large(logo),
                _ => return error(400, "Invalid asset form"),
            };
            file = Some((filename, ct, bytes.to_vec()));
        } else {
            let bytes = match field.bytes(1024 * 1024).await {
                Ok(Ok(bytes)) => bytes,
                _ => return error(400, "Field value too long"),
            };
            if name == "namespace" && !logo {
                if namespace.is_some() {
                    return invalid_metadata(vec![
                        json!({"code":"invalid_type","expected":"string","received":"array","path":["namespace"],"message":"Expected string, received array"}),
                    ]);
                }
                namespace = Some(String::from_utf8_lossy(&bytes).trim().to_owned());
            }
        }
    }
    let Some((filename, ct, mut body)) = file else {
        return error(400, "Missing file field 'file'");
    };
    if let Some(namespace) = namespace.as_deref() {
        let mut issues = Vec::new();
        if namespace.is_empty() {
            issues.push(json!({"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["namespace"]}));
        }
        if namespace.encode_utf16().count() > 120 {
            issues.push(json!({"code":"too_big","maximum":120,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 120 character(s)","path":["namespace"]}));
        }
        if namespace.is_empty()
            || !namespace
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-'))
        {
            issues.push(json!({"validation":"regex","code":"invalid_string","message":"Invalid","path":["namespace"]}));
        }
        if !issues.is_empty() {
            return invalid_metadata(issues);
        }
    }
    let allowed = if logo {
        matches!(
            ct.as_str(),
            "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif" | SVG
        )
    } else {
        ct == SVG || issue_core::attachments::is_allowed_content_type(&ct)
    };
    if !allowed {
        return error(
            422,
            &format!(
                "Unsupported {} type: {}",
                if logo { "image" } else { "file" },
                ct
            ),
        );
    }
    if ct == SVG {
        body = match super::asset_svg::sanitize(&body) {
            Some(body) if !body.is_empty() => body,
            _ => return error(422, "SVG could not be sanitized"),
        };
    }
    if body.is_empty() {
        return error(422, "Image is empty");
    }
    let namespace = if logo {
        "assets/orgs".into()
    } else {
        format!("assets/{}", namespace.as_deref().unwrap_or("general"))
    };
    let write_actor = IssueAttachmentActor {
        kind: &actor.kind,
        id: &actor.id,
        agent_id: (actor.kind == "agent").then_some(actor.id.as_str()),
        run_id: run_id.as_deref(),
        authorizer: &authorizer,
    };
    match domain::create(
        pool,
        &write_actor,
        domain::AssetUpload {
            org_id: &org,
            namespace: &namespace,
            filename: (!filename.is_empty()).then_some(filename.as_str()),
            content_type: &ct,
            body: &body,
            logo,
        },
        storage,
    )
    .await
    {
        Ok(raw) => HttpResponse::Created()
            .content_type("application/json")
            .body(raw),
        Err(err) => domain_error(err),
    }
}
fn canonical(value: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()?;
    Uuid::parse_str(&decoded).ok().map(|id| id.to_string())
}
fn max_bytes() -> usize {
    std::env::var("RUDDER_ATTACHMENT_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MAX)
}
fn too_large(logo: bool) -> HttpResponse {
    error(
        422,
        &format!(
            "{} exceeds {} bytes",
            if logo { "Image" } else { "File" },
            max_bytes()
        ),
    )
}
fn invalid_metadata(details: Vec<serde_json::Value>) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({"error":"Invalid image metadata","details":details}))
}
fn error(status: u16, message: &str) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(json!({"error":message}))
}
fn domain_error(err: IssueAttachmentError) -> HttpResponse {
    match err {
        IssueAttachmentError::Http(status, msg) => error(status, &msg),
        err => {
            tracing::warn!(%err,"Native Asset operation failed");
            error(500, "Internal server error")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_and_head_are_reserved_without_node() {
        assert_eq!(
            endpoint("/API/ORGS/id/ASSETS/IMAGES/", &Method::POST),
            Some(Endpoint::Image("id".into()))
        );
        assert_eq!(
            endpoint("/api/assets/id/content", &Method::HEAD),
            Some(Endpoint::Content("id".into()))
        );
        assert!(!is_reserved_path("/api/assets/id/content", &Method::POST));
    }
}
