//! Rust copy of the effective private-host policy for public-ingress handlers.
//!
//! The ingress proxy preserves the original `Host` header when it forwards to
//! Node, but strips all forwarding headers, including `X-Forwarded-Host`.
//! Direct Rust routes therefore gate on the original Host only; trusting
//! `X-Forwarded-Host` here would create a different trust boundary.

use actix_web::{
    HttpRequest, HttpResponse,
    http::header::{self, HOST, Header},
};
use serde::Deserialize;
use url::Url;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePrivateHostGate {
    pub(crate) enabled: bool,
    pub(crate) allowed_hostnames: Vec<String>,
    pub(crate) bind_host: String,
}

impl NativePrivateHostGate {
    pub(crate) fn parse(value: &str) -> Result<Self, &'static str> {
        if value.len() > 16 * 1024 {
            return Err("configuration is too large");
        }
        let gate: Self = serde_json::from_str(value).map_err(|_| "invalid JSON configuration")?;
        if gate.allowed_hostnames.len() > 256
            || gate.allowed_hostnames.iter().any(|host| host.len() > 255)
            || gate.bind_host.len() > 255
        {
            return Err("host configuration is too large");
        }
        Ok(gate)
    }

    pub(crate) fn rejection(&self, request: &HttpRequest) -> Option<HttpResponse> {
        if !self.enabled {
            return None;
        }

        let raw_host = request
            .headers()
            .get(HOST)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(raw_host) = raw_host else {
            return Some(host_rejection(request, "Missing Host header. If you want to allow a hostname, run pnpm rudder allowed-hostname <host>.".to_owned()));
        };

        // Match Express's `new URL(http://${raw}).hostname` behavior. Invalid
        // authorities fall back to their raw lowercase value, which cannot
        // accidentally match the normalized allowlist.
        let hostname = Url::parse(&format!("http://{raw_host}"))
            .map(|url| match url.host() {
                Some(url::Host::Ipv6(host)) => format!("[{host}]").to_lowercase(),
                Some(host) => host.to_string().trim().to_lowercase(),
                None => String::new(),
            })
            .unwrap_or_else(|_| raw_host.to_lowercase());
        let normalized_bind = self.bind_host.trim().to_lowercase();
        let is_loopback = matches!(hostname.as_str(), "localhost" | "127.0.0.1" | "::1");
        let configured = self
            .allowed_hostnames
            .iter()
            .any(|allowed| allowed.trim().eq_ignore_ascii_case(&hostname));
        let bound = normalized_bind != "0.0.0.0" && normalized_bind == hostname;
        if is_loopback || configured || bound {
            return None;
        }

        Some(host_rejection(
            request,
            format!(
                "Hostname '{hostname}' is not allowed for this Rudder instance. If you want to allow this hostname, please run pnpm rudder allowed-hostname {hostname}"
            ),
        ))
    }
}

fn host_rejection(request: &HttpRequest, message: String) -> HttpResponse {
    if request.path().starts_with("/api") || prefers_json(request) {
        HttpResponse::Forbidden().json(serde_json::json!({ "error": message }))
    } else {
        HttpResponse::Forbidden()
            .content_type("text/plain; charset=utf-8")
            .body(message)
    }
}

/// Match Express accepts(["json", "html", "text"]), including q=0 exclusions,
/// media specificity, client order, and finally the server's offered order.
fn prefers_json(request: &HttpRequest) -> bool {
    if request
        .headers()
        .get(header::ACCEPT)
        .is_none_or(|value| value.as_bytes().is_empty())
    {
        return true;
    }
    let Ok(accept) = header::Accept::parse(request) else {
        return false;
    };
    let mut selected = None;
    for (offered, (kind, subtype)) in [("application", "json"), ("text", "html"), ("text", "plain")]
        .into_iter()
        .enumerate()
    {
        let priority = accept
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                let mime = &item.item;
                if (mime.type_().as_str() != kind && mime.type_() != "*")
                    || (mime.subtype().as_str() != subtype && mime.subtype() != "*")
                    || mime.params().any(|(_, value)| value != "*")
                {
                    return None;
                }
                let specificity = u8::from(mime.type_().as_str() == kind) * 4
                    + u8::from(mime.subtype().as_str() == subtype) * 2;
                Some((specificity, item.quality, std::cmp::Reverse(index)))
            })
            .max();
        if let Some((specificity, quality, order)) = priority
            && quality > header::Quality::ZERO
        {
            let rank = (quality, specificity, order, std::cmp::Reverse(offered));
            if selected.as_ref().is_none_or(|(best, _)| rank > *best) {
                selected = Some((rank, offered));
            }
        }
    }
    selected.is_some_and(|(_, offered)| offered == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{App, test, web};

    #[actix_web::test]
    async fn matches_private_hostname_allowlist_and_requires_host() {
        let gate = NativePrivateHostGate {
            enabled: true,
            allowed_hostnames: vec!["board.example.test".to_owned()],
            bind_host: "10.0.0.4".to_owned(),
        };
        let app = test::init_service(App::new().route(
            "/",
            web::to(move |request: HttpRequest| {
                let gate = gate.clone();
                async move {
                    gate.rejection(&request)
                        .unwrap_or_else(|| HttpResponse::Ok().finish())
                }
            }),
        ))
        .await;

        for host in [
            "localhost:3100",
            "127.0.0.1:3100",
            "BOARD.example.test:443",
            "10.0.0.4:3100",
        ] {
            let response = test::call_service(
                &app,
                test::TestRequest::get()
                    .uri("/")
                    .insert_header((HOST, host))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), actix_web::http::StatusCode::OK, "{host}");
        }

        // The existing Express guard compares the URL-serialized bracketed
        // IPv6 hostname against an unbracketed `::1` allowlist entry, so it
        // currently rejects this authority unless explicitly bracket-allowed.
        let ipv6_loopback = test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/")
                .insert_header((HOST, "[::1]:3100"))
                .to_request(),
        )
        .await;
        assert_eq!(
            ipv6_loopback.status(),
            actix_web::http::StatusCode::FORBIDDEN
        );

        let denied = test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/")
                .insert_header((HOST, "attacker.example.test"))
                .to_request(),
        )
        .await;
        assert_eq!(denied.status(), actix_web::http::StatusCode::FORBIDDEN);

        let missing =
            test::call_service(&app, test::TestRequest::get().uri("/").to_request()).await;
        assert_eq!(missing.status(), actix_web::http::StatusCode::FORBIDDEN);
    }

    #[actix_web::test]
    async fn parses_bounded_host_gate_configuration() {
        let gate = NativePrivateHostGate::parse(
            r#"{"enabled":true,"allowedHostnames":["board.example.test"],"bindHost":"0.0.0.0"}"#,
        )
        .unwrap();
        assert!(gate.enabled);
        assert!(NativePrivateHostGate::parse(&"x".repeat(16 * 1024 + 1)).is_err());
    }
}
