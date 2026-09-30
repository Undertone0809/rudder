use std::{
    collections::HashSet,
    io,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use crate::public_ingress_forwarding::{FORWARDING_HEADERS, ForwardingPolicy};
use actix_web::{
    HttpRequest, HttpResponse,
    http::{
        Method, StatusCode,
        header::{self, HeaderMap, HeaderName, HeaderValue},
    },
    web,
};
use awc::{Client, ClientBuilder, Connector};
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use thiserror::Error;
use url::{Host, Url};

pub const PRIVATE_AUTH_ADAPTER_PATH: &str =
    "/api/_internal/rudder-ingress/authorize-member-directory";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const RESPONSE_HEADERS_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_UPSTREAM_CONNECTIONS: usize = 32;

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

// Other x-rudder fields are public protocol inputs: idempotency, agent/run
// context, Automation signatures and telemetry consent. Their owners must
// validate them normally after the proxy preserves them.
fn is_internal_trust_header(name: &str) -> bool {
    matches!(name, "x-rudder-actor-envelope" | "x-rudder-request-id")
        || name.starts_with("x-rudder-ingress-")
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PublicIngressProxyConfigError {
    #[error(
        "upstream must be an http URL with a loopback IP and no credentials, path, query, or fragment"
    )]
    InvalidUpstream,
}

#[derive(Clone)]
pub struct PublicIngressProxy {
    upstream_authority: SocketAddr,
    client: Client,
    forwarding_policy: ForwardingPolicy,
}

impl PublicIngressProxy {
    /// Builds a proxy pinned to a numeric loopback address; hostnames are never resolved.
    pub fn new(upstream: &str) -> Result<Self, PublicIngressProxyConfigError> {
        let url =
            Url::parse(upstream).map_err(|_| PublicIngressProxyConfigError::InvalidUpstream)?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(PublicIngressProxyConfigError::InvalidUpstream);
        }

        let ip = match url.host() {
            Some(Host::Ipv4(ip)) => IpAddr::V4(ip),
            Some(Host::Ipv6(ip)) => IpAddr::V6(ip),
            Some(Host::Domain(_)) | None => {
                return Err(PublicIngressProxyConfigError::InvalidUpstream);
            }
        };
        if !ip.is_loopback() {
            return Err(PublicIngressProxyConfigError::InvalidUpstream);
        }

        let port = url
            .port_or_known_default()
            .ok_or(PublicIngressProxyConfigError::InvalidUpstream)?;
        let client = ClientBuilder::new()
            .disable_timeout()
            .disable_redirects()
            .no_default_headers()
            .connector(
                Connector::new()
                    .timeout(CONNECT_TIMEOUT)
                    .limit(MAX_UPSTREAM_CONNECTIONS),
            )
            .finish();

        Ok(Self {
            upstream_authority: SocketAddr::new(ip, port),
            client,
            forwarding_policy: Default::default(),
        })
    }

    /// Returns the validated socket authority used for every upstream connection.
    pub fn upstream_authority(&self) -> SocketAddr {
        self.upstream_authority
    }

    pub(crate) fn with_forwarding_policy(mut self, policy: ForwardingPolicy) -> Self {
        self.forwarding_policy = policy;
        self
    }

    /// Forwards one request to the fixed upstream while streaming both body directions.
    pub async fn forward(&self, request: HttpRequest, payload: web::Payload) -> HttpResponse {
        if is_private_auth_adapter_path(request.uri().path()) {
            return HttpResponse::NotFound().finish();
        }
        if is_unsupported_upgrade(request.method(), request.headers()) {
            return proxy_error(StatusCode::NOT_IMPLEMENTED, "upgrade_not_supported");
        }
        let identity = match self.forwarding_policy.identity(&request) {
            Ok(identity) => identity,
            Err(_) => return proxy_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity"),
        };

        let Some(path_and_query) = request.uri().path_and_query() else {
            return HttpResponse::BadRequest().finish();
        };
        let raw_target = path_and_query.as_str();
        if !raw_target.starts_with('/') {
            return HttpResponse::BadRequest().finish();
        }

        let original_host = request.headers().get(header::HOST).cloned();
        let target = format!("http://{}{}", self.upstream_authority, raw_target);
        let mut outbound = self.client.request(request.method().clone(), target);
        for (name, value) in filtered_headers(request.headers(), true) {
            outbound = outbound.append_header((name, value));
        }
        outbound = outbound.insert_header((
            header::HOST,
            original_host.unwrap_or_else(|| {
                HeaderValue::from_str(&self.upstream_authority.to_string())
                    .expect("SocketAddr is a valid Host value")
            }),
        ));
        outbound = outbound
            .insert_header(("x-forwarded-for", identity.client_ip.as_str()))
            .insert_header(("x-real-ip", identity.client_ip.as_str()))
            .insert_header(("x-forwarded-proto", identity.scheme));

        let body = payload.map(|item| item.map_err(|error| io::Error::other(error.to_string())));
        let upstream_response = match tokio::time::timeout(
            RESPONSE_HEADERS_TIMEOUT,
            outbound.send_stream(body),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => return proxy_error(StatusCode::BAD_GATEWAY, "upstream_unavailable"),
            Err(_) => return proxy_error(StatusCode::GATEWAY_TIMEOUT, "upstream_timeout"),
        };

        let status = upstream_response.status();
        let headers = filtered_headers(upstream_response.headers(), false);
        let body = upstream_response
            .map(|item| item.map_err(|error| actix_web::error::ErrorBadGateway(error.to_string())));

        let mut response = HttpResponse::build(status);
        for (name, value) in headers {
            response.append_header((name, value));
        }
        response.streaming(body)
    }
}

/// Actix handler for a parent-owned catch-all proxy route.
pub async fn proxy_handler(
    request: HttpRequest,
    payload: web::Payload,
    proxy: web::Data<PublicIngressProxy>,
) -> HttpResponse {
    proxy.forward(request, payload).await
}

/// Matches the private auth adapter even when its static path is percent-encoded or has a slash suffix.
pub fn is_private_auth_adapter_path(path: &str) -> bool {
    let decoded = percent_decode_str(path).decode_utf8_lossy();
    decoded
        .trim_end_matches('/')
        .eq_ignore_ascii_case(PRIVATE_AUTH_ADAPTER_PATH)
}

fn is_unsupported_upgrade(method: &Method, headers: &HeaderMap) -> bool {
    *method == Method::CONNECT
        || headers.contains_key(header::UPGRADE)
        || connection_nominated_headers(headers).contains(&header::UPGRADE)
}

fn proxy_error(status: StatusCode, body: &'static str) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
        .body(body)
}

fn filtered_headers(headers: &HeaderMap, from_client: bool) -> Vec<(HeaderName, HeaderValue)> {
    let nominated = connection_nominated_headers(headers);
    headers
        .iter()
        .filter(|(name, _)| {
            let name = name.as_str();
            let client_trust = from_client
                && (is_internal_trust_header(name)
                    || name == header::HOST.as_str()
                    || FORWARDING_HEADERS.contains(&name));
            !(nominated.iter().any(|candidate| candidate.as_str() == name)
                || HOP_BY_HOP_HEADERS.contains(&name)
                || client_trust)
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn connection_nominated_headers(headers: &HeaderMap) -> HashSet<HeaderName> {
    let mut nominated = HashSet::new();
    for value in headers.get_all(header::CONNECTION) {
        for token in value.as_bytes().split(|byte| *byte == b',') {
            let Ok(token) = std::str::from_utf8(token) else {
                continue;
            };
            let token = token.trim();
            if !token.is_empty()
                && let Ok(name) = HeaderName::from_bytes(token.as_bytes())
            {
                nominated.insert(name);
            }
        }
    }
    nominated
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        net::{SocketAddr, TcpListener},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use actix_web::{
        App, HttpRequest, HttpResponse, HttpServer,
        dev::ServerHandle,
        http::{Method, StatusCode, header},
        web,
    };
    use awc::{Client, ClientBuilder};
    use futures_util::{StreamExt, stream};

    use super::{
        PRIVATE_AUTH_ADAPTER_PATH, PublicIngressProxy, connection_nominated_headers,
        filtered_headers, is_private_auth_adapter_path, is_unsupported_upgrade,
    };

    type RunningServer = (
        SocketAddr,
        ServerHandle,
        actix_web::rt::task::JoinHandle<std::io::Result<()>>,
    );

    fn start_server<C>(configure: C) -> RunningServer
    where
        C: Fn(&mut web::ServiceConfig) + Clone + Send + 'static,
    {
        let server = HttpServer::new(move || App::new().configure(configure.clone()))
            .bind(("127.0.0.1", 0))
            .expect("loopback mock server binds");
        let address = server.addrs()[0];
        let server = server.run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        (address, handle, task)
    }

    fn start_proxy(proxy: PublicIngressProxy, payload_limit: usize) -> RunningServer {
        let upstream = format!("http://{}", proxy.upstream_authority());
        let forwarding_policy = proxy.forwarding_policy.clone();
        let server = HttpServer::new(move || {
            App::new()
                .app_data(web::Data::new(
                    PublicIngressProxy::new(&upstream)
                        .unwrap()
                        .with_forwarding_policy(forwarding_policy.clone()),
                ))
                .app_data(web::PayloadConfig::new(payload_limit))
                .default_service(web::to(super::proxy_handler))
        })
        .bind(("127.0.0.1", 0))
        .expect("loopback proxy server binds");
        let address = server.addrs()[0];
        let server = server.run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        (address, handle, task)
    }

    async fn stop_server((_, handle, task): RunningServer) {
        handle.stop(true).await;
        task.await
            .expect("server task joins")
            .expect("server stops cleanly");
    }

    fn client() -> Client {
        ClientBuilder::new()
            .disable_redirects()
            .no_default_headers()
            .finish()
    }

    #[test]
    fn config_accepts_only_http_loopback_ip_authorities() {
        let proxy = PublicIngressProxy::new("http://127.0.0.1:3199").unwrap();
        assert_eq!(
            proxy.upstream_authority(),
            "127.0.0.1:3199".parse().unwrap()
        );

        for value in [
            "https://127.0.0.1:3199",
            "http://localhost:3199",
            "http://192.168.1.15:3199",
            "http://127.0.0.1:3199/private",
            "http://127.0.0.1:3199/?target=elsewhere",
            "http://user@127.0.0.1:3199",
        ] {
            assert!(PublicIngressProxy::new(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn filters_hop_headers_connection_tokens_and_client_trust_headers() {
        let mut headers = header::HeaderMap::new();
        headers.append(
            header::CONNECTION,
            header::HeaderValue::from_static("keep-alive, X-Connection-Only"),
        );
        headers.append(
            header::CONNECTION,
            header::HeaderValue::from_static("x-second-token"),
        );
        headers.insert(
            header::HeaderName::from_static("x-connection-only"),
            header::HeaderValue::from_static("drop"),
        );
        headers.insert(
            header::HeaderName::from_static("x-second-token"),
            header::HeaderValue::from_static("drop"),
        );
        headers.insert(
            header::HeaderName::from_static("proxy-authorization"),
            header::HeaderValue::from_static("drop"),
        );
        headers.insert(
            header::HeaderName::from_static("x-rudder-actor-envelope"),
            header::HeaderValue::from_static("forged"),
        );
        headers.insert(
            header::HeaderName::from_static("x-rudder-request-id"),
            header::HeaderValue::from_static("forged"),
        );
        headers.insert(
            header::HeaderName::from_static("x-forwarded-host"),
            header::HeaderValue::from_static("forged.example"),
        );
        headers.insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_static("Bearer preserved"),
        );
        headers.insert(
            header::COOKIE,
            header::HeaderValue::from_static("session=preserved"),
        );
        headers.insert(
            header::HeaderName::from_static("x-application-header"),
            header::HeaderValue::from_static("preserved"),
        );

        let forwarded = filtered_headers(&headers, true);
        let forwarded_names = forwarded
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();

        assert!(!forwarded_names.contains(&"connection"));
        assert!(!forwarded_names.contains(&"keep-alive"));
        assert!(!forwarded_names.contains(&"proxy-authorization"));
        assert!(!forwarded_names.contains(&"x-connection-only"));
        assert!(!forwarded_names.contains(&"x-second-token"));
        assert!(!forwarded_names.contains(&"x-rudder-actor-envelope"));
        assert!(!forwarded_names.contains(&"x-rudder-request-id"));
        assert!(!forwarded_names.contains(&"x-forwarded-host"));
        assert!(forwarded_names.contains(&"authorization"));
        assert!(forwarded_names.contains(&"cookie"));
        assert!(forwarded_names.contains(&"x-application-header"));
        assert_eq!(connection_nominated_headers(&headers).len(), 3);
    }

    #[test]
    fn private_adapter_path_is_denied_after_one_percent_decode() {
        assert!(is_private_auth_adapter_path(PRIVATE_AUTH_ADAPTER_PATH));
        assert!(is_private_auth_adapter_path(
            "/api/%5Finternal/rudder-ingress/authorize-member-directory/"
        ));
        assert!(!is_private_auth_adapter_path("/api/orgs/members"));
    }

    #[test]
    fn preserves_public_mutation_context_webhook_and_consent_headers() {
        let mut headers = header::HeaderMap::new();
        let public_fields = [
            "x-rudder-idempotency-key",
            "x-rudder-required-authority",
            "x-rudder-agent-id",
            "x-rudder-run-id",
            "x-rudder-signature",
            "x-rudder-timestamp",
            "x-rudder-telemetry-consent-version",
            "x-rudder-telemetry-anonymous-authorization",
        ];
        for name in public_fields {
            headers.insert(
                header::HeaderName::from_static(name),
                header::HeaderValue::from_static("public-input"),
            );
        }
        headers.insert(
            header::HeaderName::from_static("x-rudder-ingress-auth"),
            header::HeaderValue::from_static("forged-internal-key"),
        );
        let forwarded = filtered_headers(&headers, true);
        for name in public_fields {
            assert!(
                forwarded
                    .iter()
                    .any(|(actual, value)| actual.as_str() == name && value == "public-input"),
                "{name}"
            );
        }
        assert!(
            !forwarded
                .iter()
                .any(|(name, _)| name.as_str() == "x-rudder-ingress-auth")
        );
    }

    #[test]
    fn identifies_connect_and_http_upgrade_requests() {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::UPGRADE,
            header::HeaderValue::from_static("websocket"),
        );
        assert!(is_unsupported_upgrade(&Method::GET, &headers));

        headers.clear();
        headers.insert(
            header::CONNECTION,
            header::HeaderValue::from_static("keep-alive, uPgRaDe"),
        );
        assert!(is_unsupported_upgrade(&Method::GET, &headers));
        assert!(is_unsupported_upgrade(
            &Method::CONNECT,
            &header::HeaderMap::new()
        ));
        assert!(!is_unsupported_upgrade(
            &Method::GET,
            &header::HeaderMap::new()
        ));
    }

    #[derive(Default)]
    struct ObservedRequest {
        target: String,
        host: Option<String>,
        authorization: Option<String>,
        cookie: Option<String>,
        content_type: Option<String>,
        application_header: Option<String>,
        rudder_header: Option<String>,
        nominated_header: Option<String>,
        forwarded_host: Option<String>,
        forwarded_for: Option<String>,
        forwarded_proto: Option<String>,
        body_bytes: usize,
    }

    async fn observe_request(
        request: HttpRequest,
        mut payload: web::Payload,
        state: web::Data<Arc<Mutex<Option<ObservedRequest>>>>,
    ) -> HttpResponse {
        let mut observed = ObservedRequest {
            target: request
                .uri()
                .path_and_query()
                .map(ToString::to_string)
                .unwrap_or_default(),
            host: header_text(&request, header::HOST),
            authorization: header_text(&request, header::AUTHORIZATION),
            cookie: header_text(&request, header::COOKIE),
            content_type: header_text(&request, header::CONTENT_TYPE),
            application_header: request
                .headers()
                .get("x-application-header")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            rudder_header: request
                .headers()
                .get("x-rudder-request-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            nominated_header: request
                .headers()
                .get("x-connection-only")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            forwarded_host: request
                .headers()
                .get("x-forwarded-host")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            forwarded_for: header_text(
                &request,
                header::HeaderName::from_static("x-forwarded-for"),
            ),
            forwarded_proto: header_text(
                &request,
                header::HeaderName::from_static("x-forwarded-proto"),
            ),
            body_bytes: 0,
        };
        while let Some(chunk) = payload.next().await {
            match chunk {
                Ok(chunk) => observed.body_bytes += chunk.len(),
                Err(_) => return HttpResponse::BadRequest().finish(),
            }
        }
        *state.lock().expect("observation mutex is healthy") = Some(observed);

        HttpResponse::build(StatusCode::CREATED)
            .insert_header((header::LOCATION, "/result?from=upstream"))
            .append_header((header::SET_COOKIE, "first=1; Path=/; HttpOnly"))
            .append_header((header::SET_COOKIE, "second=2; Path=/; SameSite=Lax"))
            .insert_header((header::CONTENT_TYPE, "application/vnd.rudder.proxy+json"))
            .insert_header(("x-upstream-application", "kept"))
            .body("upstream response")
    }

    fn header_text(request: &HttpRequest, name: header::HeaderName) -> Option<String> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    #[actix_web::test]
    async fn forwards_raw_target_original_host_credentials_and_response_headers() {
        let observed = web::Data::new(Arc::new(Mutex::new(None)));
        let upstream_observed = observed.clone();
        let (upstream_address, upstream_handle, upstream_task) = start_server(move |config| {
            config.app_data(upstream_observed.clone());
            config.default_service(web::to(observe_request));
        });
        let proxy = PublicIngressProxy::new(&format!("http://{upstream_address}")).unwrap();
        let (proxy_address, proxy_handle, proxy_task) = start_proxy(proxy, 1024 * 1024);
        let raw_target = "/v1/messages/%2Fraw?x=a%2Fb&item=one&item=two";

        let mut response = client()
            .request(Method::POST, format!("http://{proxy_address}{raw_target}"))
            .insert_header((header::HOST, "private.example.test:8443"))
            .insert_header((header::AUTHORIZATION, "Bearer original-token"))
            .insert_header((header::COOKIE, "session=original"))
            .insert_header((header::CONTENT_TYPE, "multipart/form-data; boundary=abc"))
            .insert_header(("x-application-header", "preserve-me"))
            .insert_header(("x-rudder-request-id", "client-forgery"))
            .insert_header(("x-rudder-actor-envelope", "client-forgery"))
            .insert_header(("x-forwarded-host", "forged.example.test"))
            .insert_header(("x-forwarded-for", "198.51.100.99"))
            .insert_header(("x-forwarded-proto", "https"))
            .send_body("chat-body")
            .await
            .expect("proxy response arrives");

        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/result?from=upstream"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/vnd.rudder.proxy+json"
        );
        assert_eq!(
            response.headers().get("x-upstream-application").unwrap(),
            "kept"
        );
        assert!(response.headers().get("x-response-hop").is_none());
        assert_eq!(response.headers().get_all(header::SET_COOKIE).count(), 2);
        assert_eq!(
            response.body().await.unwrap().as_ref(),
            b"upstream response"
        );

        let observed: ObservedRequest = observed
            .lock()
            .unwrap()
            .take()
            .expect("upstream saw request");
        assert_eq!(observed.target, raw_target);
        assert_eq!(observed.host.as_deref(), Some("private.example.test:8443"));
        assert_eq!(
            observed.authorization.as_deref(),
            Some("Bearer original-token")
        );
        assert_eq!(observed.cookie.as_deref(), Some("session=original"));
        assert_eq!(
            observed.content_type.as_deref(),
            Some("multipart/form-data; boundary=abc")
        );
        assert_eq!(observed.application_header.as_deref(), Some("preserve-me"));
        assert!(observed.rudder_header.is_none());
        assert!(observed.nominated_header.is_none());
        assert!(observed.forwarded_host.is_none());
        assert_eq!(observed.forwarded_for.as_deref(), Some("127.0.0.1"));
        assert_eq!(observed.forwarded_proto.as_deref(), Some("http"));
        assert_eq!(observed.body_bytes, b"chat-body".len());

        stop_server((proxy_address, proxy_handle, proxy_task)).await;
        stop_server((upstream_address, upstream_handle, upstream_task)).await;
    }

    #[actix_web::test]
    async fn trusted_proxy_selects_nearest_client_and_rejects_ambiguous_wire_metadata() {
        let observed = web::Data::new(Arc::new(Mutex::new(None)));
        let upstream_observed = observed.clone();
        let (upstream_address, upstream_handle, upstream_task) = start_server(move |config| {
            config.app_data(upstream_observed.clone());
            config.default_service(web::to(observe_request));
        });
        let proxy = PublicIngressProxy::new(&format!("http://{upstream_address}"))
            .unwrap()
            .with_forwarding_policy(
                crate::public_ingress_forwarding::ForwardingPolicy::parse("127.0.0.1,192.0.2.1")
                    .unwrap(),
            );
        let (proxy_address, proxy_handle, proxy_task) = start_proxy(proxy, 1024 * 1024);
        for real_client in ["198.51.100.7", "198.51.100.8"] {
            let response = client()
                .get(format!("http://{proxy_address}/auth/callback"))
                .insert_header((
                    "x-forwarded-for",
                    format!("203.0.113.99,{real_client},192.0.2.1"),
                ))
                .insert_header(("x-forwarded-proto", "https"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CREATED);
            let request: ObservedRequest = observed.lock().unwrap().take().unwrap();
            assert_eq!(request.forwarded_for.as_deref(), Some(real_client));
            assert_eq!(request.forwarded_proto.as_deref(), Some("https"));
        }
        for (chain, scheme) in [
            ("127.0.0.1", "https"),
            ("unknown", "https"),
            ("198.51.100.7", "https,http"),
        ] {
            let response = client()
                .get(format!("http://{proxy_address}/auth/callback"))
                .insert_header(("x-forwarded-for", chain))
                .insert_header(("x-forwarded-proto", scheme))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(observed.lock().unwrap().is_none());
        }
        stop_server((proxy_address, proxy_handle, proxy_task)).await;
        stop_server((upstream_address, upstream_handle, upstream_task)).await;
    }

    async fn count_body(mut payload: web::Payload) -> HttpResponse {
        let mut received = 0usize;
        while let Some(chunk) = payload.next().await {
            match chunk {
                Ok(chunk) => received += chunk.len(),
                Err(_) => return HttpResponse::BadRequest().finish(),
            }
        }
        HttpResponse::Ok()
            .insert_header(("x-received-bytes", received.to_string()))
            .finish()
    }

    #[actix_web::test]
    async fn removes_connection_nominated_headers_on_actual_http_wire_in_both_directions() {
        use std::io::{BufRead, BufReader, Read, Write};
        // Actix/AWC encoders replace Connection with their own transport value.
        // Raw peers are needed to put custom nominations on the actual wire.
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let upstream_task = std::thread::spawn(move || {
            let (mut socket, _) = upstream.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&mut socket);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
                assert!(request.len() < 64 * 1024);
            }
            drop(reader);
            assert!(!request.to_ascii_lowercase().contains("x-request-hop:"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("x-rudder-idempotency-key: stable-retry")
            );
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close, x-response-hop\r\nX-Response-Hop: remove-me\r\nX-Application: retained\r\n\r\nhello").unwrap();
        });
        let proxy = PublicIngressProxy::new(&format!("http://{upstream_address}")).unwrap();
        let running_proxy = start_proxy(proxy, 1024 * 1024);
        let proxy_address = running_proxy.0;
        let response = tokio::task::spawn_blocking(move || {
            let mut socket = std::net::TcpStream::connect(proxy_address).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            socket.write_all(b"GET /wire HTTP/1.1\r\nHost: public.example\r\nConnection: close, x-request-hop\r\nX-Request-Hop: remove-me\r\nX-Rudder-Idempotency-Key: stable-retry\r\n\r\n").unwrap();
            let mut reader = BufReader::new(socket);
            let mut response = String::new();
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                response.push_str(&line);
                if line == "\r\n" { break; }
                assert!(response.len() < 64 * 1024);
            }
            let mut body = [0; 5];
            reader.read_exact(&mut body).unwrap();
            response.push_str(std::str::from_utf8(&body).unwrap());
            response
        }).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(!response.to_ascii_lowercase().contains("x-response-hop:"));
        assert!(
            response
                .to_ascii_lowercase()
                .contains("x-application: retained")
        );
        assert!(response.ends_with("hello"));
        upstream_task.join().unwrap();
        stop_server(running_proxy).await;
    }

    #[actix_web::test]
    async fn streams_request_larger_than_global_payload_limit_without_body_fixture() {
        let (upstream_address, upstream_handle, upstream_task) = start_server(|config| {
            config.default_service(web::to(count_body));
        });
        let proxy = PublicIngressProxy::new(&format!("http://{upstream_address}")).unwrap();
        let (proxy_address, proxy_handle, proxy_task) = start_proxy(proxy, 1024 * 1024);
        let total = 2 * 1024 * 1024 + 17;
        let chunk_size = 64 * 1024;
        let body = stream::unfold(0usize, move |sent| async move {
            if sent >= total {
                None
            } else {
                let size = chunk_size.min(total - sent);
                Some((
                    Ok::<_, io::Error>(web::Bytes::from(vec![b'x'; size])),
                    sent + size,
                ))
            }
        });

        let response = client()
            .post(format!("http://{proxy_address}/chat/upload"))
            .insert_header((header::CONTENT_LENGTH, total.to_string()))
            .insert_header((header::CONTENT_TYPE, "multipart/form-data; boundary=large"))
            .send_stream(body)
            .await
            .expect("large streamed request reaches mock upstream");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("x-received-bytes")
                .unwrap()
                .to_str()
                .unwrap(),
            total.to_string()
        );

        stop_server((proxy_address, proxy_handle, proxy_task)).await;
        stop_server((upstream_address, upstream_handle, upstream_task)).await;
    }

    struct StreamDropNotice(Arc<AtomicBool>);

    impl Drop for StreamDropNotice {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    async fn event_stream(dropped: web::Data<Arc<AtomicBool>>) -> HttpResponse {
        let body = stream::unfold(
            (0usize, StreamDropNotice(dropped.get_ref().clone())),
            |(index, notice)| async move {
                if index == 0 {
                    Some((
                        Ok::<_, io::Error>(web::Bytes::from_static(b"data: first\n\n")),
                        (1, notice),
                    ))
                } else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    Some((
                        Ok(web::Bytes::from_static(b"data: next\n\n")),
                        (index + 1, notice),
                    ))
                }
            },
        );
        HttpResponse::Ok()
            .insert_header((header::CONTENT_TYPE, "text/event-stream"))
            .streaming(body)
    }

    #[actix_web::test]
    async fn streams_sse_incrementally_and_cancels_upstream_when_downstream_closes() {
        let dropped = web::Data::new(Arc::new(AtomicBool::new(false)));
        let upstream_dropped = dropped.clone();
        let (upstream_address, upstream_handle, upstream_task) = start_server(move |config| {
            config.app_data(upstream_dropped.clone());
            config.route("/events", web::get().to(event_stream));
        });
        let proxy = PublicIngressProxy::new(&format!("http://{upstream_address}")).unwrap();
        let (proxy_address, proxy_handle, proxy_task) = start_proxy(proxy, 1024 * 1024);

        let mut response = client()
            .get(format!("http://{proxy_address}/events"))
            .send()
            .await
            .expect("SSE response headers arrive");
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        let first = tokio::time::timeout(Duration::from_secs(2), response.next())
            .await
            .expect("first event is flushed before the next event delay")
            .expect("event stream remains open")
            .expect("first event has no upstream error");
        assert_eq!(first.as_ref(), b"data: first\n\n");
        drop(response);

        tokio::time::timeout(Duration::from_secs(2), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("downstream close drops the upstream response stream");

        stop_server((proxy_address, proxy_handle, proxy_task)).await;
        stop_server((upstream_address, upstream_handle, upstream_task)).await;
    }

    async fn count_hit(hits: web::Data<AtomicUsize>) -> HttpResponse {
        hits.fetch_add(1, Ordering::SeqCst);
        HttpResponse::Ok().finish()
    }

    #[actix_web::test]
    async fn denies_private_auth_adapter_without_contacting_upstream() {
        let hits = web::Data::new(AtomicUsize::new(0));
        let upstream_hits = hits.clone();
        let (upstream_address, upstream_handle, upstream_task) = start_server(move |config| {
            config.app_data(upstream_hits.clone());
            config.default_service(web::to(count_hit));
        });
        let proxy = PublicIngressProxy::new(&format!("http://{upstream_address}")).unwrap();
        let (proxy_address, proxy_handle, proxy_task) = start_proxy(proxy, 1024 * 1024);

        let response = client()
            .get(format!(
                "http://{proxy_address}/api/%5Finternal/rudder-ingress/authorize-member-directory?org=one"
            ))
            .send()
            .await
            .expect("deny response arrives");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        stop_server((proxy_address, proxy_handle, proxy_task)).await;
        stop_server((upstream_address, upstream_handle, upstream_task)).await;
    }

    #[actix_web::test]
    async fn rejects_websocket_upgrade_without_contacting_upstream() {
        let hits = web::Data::new(AtomicUsize::new(0));
        let upstream_hits = hits.clone();
        let (upstream_address, upstream_handle, upstream_task) = start_server(move |config| {
            config.app_data(upstream_hits.clone());
            config.default_service(web::to(count_hit));
        });
        let proxy = PublicIngressProxy::new(&format!("http://{upstream_address}")).unwrap();
        let (proxy_address, proxy_handle, proxy_task) = start_proxy(proxy, 1024 * 1024);

        let mut response = client()
            .get(format!("http://{proxy_address}/api/chat"))
            .insert_header((header::CONNECTION, "keep-alive, Upgrade"))
            .insert_header((header::UPGRADE, "websocket"))
            .send()
            .await
            .expect("explicit unsupported response arrives");

        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        assert_eq!(
            response.body().await.unwrap().as_ref(),
            b"upgrade_not_supported"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        stop_server((proxy_address, proxy_handle, proxy_task)).await;
        stop_server((upstream_address, upstream_handle, upstream_task)).await;
    }

    #[actix_web::test]
    async fn connection_failure_returns_bad_gateway_without_fallback() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let unused_address = listener.local_addr().unwrap();
        drop(listener);

        let proxy = PublicIngressProxy::new(&format!("http://{unused_address}")).unwrap();
        let (proxy_address, proxy_handle, proxy_task) = start_proxy(proxy, 1024 * 1024);
        let mut response = client()
            .get(format!("http://{proxy_address}/api/chat"))
            .send()
            .await
            .expect("proxy returns an explicit upstream failure response");

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            response.body().await.unwrap().as_ref(),
            b"upstream_unavailable"
        );

        stop_server((proxy_address, proxy_handle, proxy_task)).await;
    }
}
