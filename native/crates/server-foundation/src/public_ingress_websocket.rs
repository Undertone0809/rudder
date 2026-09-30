//! Bidirectional WebSocket proxy for the explicitly configured private Node upstream.

use std::{collections::HashSet, net::SocketAddr, sync::Arc, time::Duration};

use actix_web::{
    HttpRequest, HttpResponse,
    http::{
        Method, StatusCode,
        header::{self, HeaderMap, HeaderName, HeaderValue},
    },
    web,
};
use actix_ws::{CloseCode, CloseReason, Message, MessageStream, Session};
use awc::{ClientBuilder, Connector, error::WsClientError, ws::Frame};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use percent_encoding::percent_decode_str;
use thiserror::Error;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_UPSTREAM_CONNECTIONS: usize = 32;
const MAX_WEBSOCKET_FRAME_BYTES: usize = 100 * 1024 * 1024;
const PRIVATE_AUTH_ADAPTER_PATH: &str = "/api/_internal/rudder-ingress/authorize-member-directory";

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

const ORIGINAL_HOST_METADATA_HEADERS: &[&str] =
    &["forwarded", "x-forwarded-host", "x-original-host"];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PublicIngressWebSocketConfigError {
    #[error("upstream must be a nonzero loopback socket address")]
    InvalidUpstream,
}

#[derive(Clone)]
pub struct PublicIngressWebSocketProxy {
    upstream_authority: SocketAddr,
    upstream_connections: Arc<Semaphore>,
}

impl PublicIngressWebSocketProxy {
    /// Pins every websocket connection to the configured numeric loopback socket.
    pub fn new(upstream_authority: SocketAddr) -> Result<Self, PublicIngressWebSocketConfigError> {
        if !upstream_authority.ip().is_loopback() || upstream_authority.port() == 0 {
            return Err(PublicIngressWebSocketConfigError::InvalidUpstream);
        }

        Ok(Self {
            upstream_authority,
            upstream_connections: Arc::new(Semaphore::new(MAX_UPSTREAM_CONNECTIONS)),
        })
    }

    pub fn upstream_authority(&self) -> SocketAddr {
        self.upstream_authority
    }

    /// Opens the private Node websocket before accepting the public handshake.
    pub async fn forward(&self, request: HttpRequest, payload: web::Payload) -> HttpResponse {
        if is_private_auth_adapter_path(request.uri().path()) {
            return proxy_error(StatusCode::NOT_FOUND, "not_found");
        }
        if request.method() != Method::GET {
            return HttpResponse::MethodNotAllowed()
                .insert_header((header::ALLOW, "GET"))
                .finish();
        }

        let Some(host) = request.headers().get(header::HOST).cloned() else {
            return proxy_error(StatusCode::BAD_REQUEST, "missing_host");
        };
        let Some(raw_target) = request.uri().path_and_query().map(|value| value.as_str()) else {
            return proxy_error(StatusCode::BAD_REQUEST, "invalid_target");
        };
        if !raw_target.starts_with('/') {
            return proxy_error(StatusCode::BAD_REQUEST, "invalid_target");
        }
        let protocols = match offered_protocols(request.headers()) {
            Ok(protocols) => protocols,
            Err(()) => return proxy_error(StatusCode::BAD_REQUEST, "invalid_subprotocol"),
        };
        let upstream_permit = match self.upstream_connections.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                return proxy_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "websocket_capacity_exhausted",
                );
            }
        };

        let (mut downstream_response, downstream_session, downstream_stream) =
            match actix_ws::handle(&request, payload) {
                Ok(connection) => connection,
                Err(_) => return proxy_error(StatusCode::BAD_REQUEST, "invalid_websocket_upgrade"),
            };

        let upstream_url = format!("ws://{}{}", self.upstream_authority, raw_target);
        let client = ClientBuilder::new()
            .timeout(CONNECT_TIMEOUT)
            .disable_redirects()
            .no_default_headers()
            .connector(Connector::new().timeout(CONNECT_TIMEOUT))
            .finish();
        let mut upstream_request = client
            .ws(upstream_url)
            .address(self.upstream_authority)
            .max_frame_size(MAX_WEBSOCKET_FRAME_BYTES)
            .set_header(header::HOST, host);
        for (name, value) in forwarded_request_headers(request.headers()) {
            upstream_request = upstream_request.header(name, value);
        }
        if !protocols.is_empty() {
            upstream_request = upstream_request.protocols(protocols.iter());
        }

        let (upstream_response, upstream_socket) = match upstream_request.connect().await {
            Ok(connection) => connection,
            Err(error) => return upstream_handshake_error(error),
        };
        let selected_protocol = match selected_protocol(upstream_response.headers(), &protocols) {
            Ok(protocol) => protocol,
            Err(()) => return proxy_error(StatusCode::BAD_GATEWAY, "invalid_upstream_subprotocol"),
        };
        if let Some(protocol) = selected_protocol {
            downstream_response
                .headers_mut()
                .insert(header::SEC_WEBSOCKET_PROTOCOL, protocol);
        }

        let downstream_stream = downstream_stream.max_frame_size(MAX_WEBSOCKET_FRAME_BYTES);
        let (upstream_sink, upstream_stream) = upstream_socket.split();
        actix_web::rt::spawn(relay(
            downstream_session,
            downstream_stream,
            upstream_sink,
            upstream_stream,
            upstream_permit,
        ));
        downstream_response
    }
}

/// Actix handler for a parent-owned websocket-upgrade route.
pub async fn websocket_proxy_handler(
    request: HttpRequest,
    payload: web::Payload,
    proxy: web::Data<PublicIngressWebSocketProxy>,
) -> HttpResponse {
    proxy.forward(request, payload).await
}

#[derive(Debug)]
enum RelayEnd {
    ClientClose(Option<CloseReason>),
    ClientDisconnected,
    ClientProtocolError,
    UpstreamClose(Option<CloseReason>),
    UpstreamDisconnected,
    UpstreamProtocolError,
    UpstreamInvalidText,
    UpstreamWriteFailed,
    ClientWriteFailed,
}

async fn relay<SinkType, StreamType, StreamError>(
    mut downstream_session: Session,
    mut downstream_stream: MessageStream,
    mut upstream_sink: SinkType,
    mut upstream_stream: StreamType,
    _upstream_permit: OwnedSemaphorePermit,
) where
    SinkType: Sink<Message> + Unpin,
    SinkType::Error: Send + 'static,
    StreamType: Stream<Item = Result<Frame, StreamError>> + Unpin,
    StreamError: Send + 'static,
{
    let end = {
        let client_to_upstream =
            pump_client_to_upstream(&mut downstream_stream, &mut upstream_sink);
        let upstream_to_client =
            pump_upstream_to_client(&mut upstream_stream, &mut downstream_session);
        tokio::pin!(client_to_upstream, upstream_to_client);
        tokio::select! {
            end = &mut client_to_upstream => end,
            end = &mut upstream_to_client => end,
        }
    };

    match end {
        RelayEnd::ClientClose(reason) | RelayEnd::UpstreamClose(reason) => {
            let _ = tokio::join!(
                upstream_sink.send(Message::Close(reason.clone())),
                downstream_session.close(reason),
            );
        }
        RelayEnd::ClientDisconnected => {
            let _ = upstream_sink
                .send(Message::Close(Some(CloseCode::Away.into())))
                .await;
        }
        RelayEnd::ClientProtocolError | RelayEnd::UpstreamProtocolError => {
            close_both(
                &mut upstream_sink,
                downstream_session,
                Some(CloseCode::Protocol.into()),
            )
            .await;
        }
        RelayEnd::UpstreamInvalidText => {
            close_both(
                &mut upstream_sink,
                downstream_session,
                Some(CloseCode::Invalid.into()),
            )
            .await;
        }
        RelayEnd::UpstreamDisconnected => {
            let _ = downstream_session.close(Some(CloseCode::Away.into())).await;
        }
        RelayEnd::UpstreamWriteFailed => {
            let _ = downstream_session
                .close(Some(CloseCode::Error.into()))
                .await;
        }
        RelayEnd::ClientWriteFailed => {
            let _ = upstream_sink
                .send(Message::Close(Some(CloseCode::Away.into())))
                .await;
        }
    }
}

async fn close_both<S>(
    upstream_sink: &mut S,
    downstream_session: Session,
    reason: Option<CloseReason>,
) where
    S: Sink<Message> + Unpin,
{
    let _ = tokio::join!(
        upstream_sink.send(Message::Close(reason.clone())),
        downstream_session.close(reason),
    );
}

async fn pump_client_to_upstream<S>(
    downstream_stream: &mut MessageStream,
    upstream_sink: &mut S,
) -> RelayEnd
where
    S: Sink<Message> + Unpin,
{
    while let Some(message) = downstream_stream.recv().await {
        let message = match message {
            Ok(message) => message,
            Err(_) => return RelayEnd::ClientProtocolError,
        };
        match message {
            Message::Close(reason) => return RelayEnd::ClientClose(reason),
            Message::Nop => continue,
            message => {
                if upstream_sink.send(message).await.is_err() {
                    return RelayEnd::UpstreamWriteFailed;
                }
            }
        }
    }
    RelayEnd::ClientDisconnected
}

async fn pump_upstream_to_client<S, E>(
    upstream_stream: &mut S,
    downstream_session: &mut Session,
) -> RelayEnd
where
    S: Stream<Item = Result<Frame, E>> + Unpin,
{
    while let Some(frame) = upstream_stream.next().await {
        let message = match frame {
            Ok(frame) => match frame_to_message(frame) {
                Ok(Some(message)) => message,
                Ok(None) => continue,
                Err(end) => return end,
            },
            Err(_) => return RelayEnd::UpstreamProtocolError,
        };
        match message {
            Message::Close(reason) => return RelayEnd::UpstreamClose(reason),
            message => {
                if downstream_session.send(message).await.is_err() {
                    return RelayEnd::ClientWriteFailed;
                }
            }
        }
    }
    RelayEnd::UpstreamDisconnected
}

fn frame_to_message(frame: Frame) -> Result<Option<Message>, RelayEnd> {
    match frame {
        Frame::Text(bytes) => bytes
            .try_into()
            .map(Message::Text)
            .map(Some)
            .map_err(|_| RelayEnd::UpstreamInvalidText),
        Frame::Binary(bytes) => Ok(Some(Message::Binary(bytes))),
        Frame::Continuation(item) => Ok(Some(Message::Continuation(item))),
        Frame::Ping(bytes) => Ok(Some(Message::Ping(bytes))),
        Frame::Pong(bytes) => Ok(Some(Message::Pong(bytes))),
        Frame::Close(reason) => Ok(Some(Message::Close(reason))),
    }
}

fn upstream_handshake_error(error: WsClientError) -> HttpResponse {
    match error {
        WsClientError::InvalidResponseStatus(status) if !status.is_redirection() => {
            proxy_error(status, "upstream_websocket_rejected")
        }
        _ => proxy_error(StatusCode::BAD_GATEWAY, "upstream_websocket_unavailable"),
    }
}

fn proxy_error(status: StatusCode, message: &'static str) -> HttpResponse {
    HttpResponse::build(status)
        .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
        .body(message)
}

fn is_private_auth_adapter_path(path: &str) -> bool {
    percent_decode_str(path)
        .decode_utf8_lossy()
        .trim_end_matches('/')
        .eq_ignore_ascii_case(PRIVATE_AUTH_ADAPTER_PATH)
}

fn is_client_trust_header(name: &str) -> bool {
    name == "x-rudder-actor-envelope"
        || name == "x-rudder-request-id"
        || name.starts_with("x-rudder-ingress-")
}

fn forwarded_request_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    let nominated = connection_nominated_headers(headers);
    headers
        .iter()
        .filter(|(name, _)| {
            let name_text = name.as_str();
            !nominated.contains(*name)
                && !HOP_BY_HOP_HEADERS.contains(&name_text)
                && !is_client_trust_header(name_text)
                && name_text != header::HOST.as_str()
                && name_text != "content-length"
                && name_text != "content-type"
                && !name_text.starts_with("sec-websocket-")
                && !ORIGINAL_HOST_METADATA_HEADERS.contains(&name_text)
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn connection_nominated_headers(headers: &HeaderMap) -> HashSet<HeaderName> {
    let mut nominated = HashSet::new();
    for value in headers.get_all(header::CONNECTION) {
        let Ok(value) = value.to_str() else {
            continue;
        };
        for token in value
            .split(',')
            .map(str::trim)
            .filter(|token| !token.is_empty())
        {
            if let Ok(name) = HeaderName::from_bytes(token.as_bytes()) {
                nominated.insert(name);
            }
        }
    }
    nominated
}

fn offered_protocols(headers: &HeaderMap) -> Result<Vec<String>, ()> {
    let mut protocols = Vec::new();
    for value in headers.get_all(header::SEC_WEBSOCKET_PROTOCOL) {
        let value = value.to_str().map_err(|_| ())?;
        for protocol in value.split(',').map(str::trim) {
            if protocol.is_empty() || !is_http_token(protocol) {
                return Err(());
            }
            protocols.push(protocol.to_owned());
        }
    }
    Ok(protocols)
}

fn selected_protocol(headers: &HeaderMap, offered: &[String]) -> Result<Option<HeaderValue>, ()> {
    let mut values = headers.get_all(header::SEC_WEBSOCKET_PROTOCOL);
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    let protocol = value.to_str().map_err(|_| ())?;
    if !is_http_token(protocol) || !offered.iter().any(|offered| offered == protocol) {
        return Err(());
    }
    Ok(Some(value.clone()))
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        net::SocketAddr,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use actix_web::{
        App, HttpRequest, HttpResponse, HttpServer,
        dev::ServerHandle,
        http::{StatusCode, header},
        web,
    };
    use actix_ws::{CloseCode, Item, Message};
    use awc::{
        Client, ClientBuilder,
        ws::{Frame, Message as ClientMessage},
    };
    use futures_util::{SinkExt, StreamExt};

    use super::{
        MAX_WEBSOCKET_FRAME_BYTES, PublicIngressWebSocketConfigError, PublicIngressWebSocketProxy,
        websocket_proxy_handler,
    };

    type RunningServer = (
        SocketAddr,
        ServerHandle,
        tokio::task::JoinHandle<io::Result<()>>,
    );

    #[derive(Default)]
    struct Observations {
        handshakes: Mutex<Vec<header::HeaderMap>>,
        targets: Mutex<Vec<String>>,
        closes: AtomicUsize,
        disconnects: AtomicUsize,
    }

    fn start_server<C>(configure: C) -> RunningServer
    where
        C: Fn(&mut web::ServiceConfig) + Clone + Send + 'static,
    {
        let server = HttpServer::new(move || App::new().configure(configure.clone()))
            .bind(("127.0.0.1", 0))
            .expect("loopback fixture binds");
        let address = server.addrs()[0];
        let server = server.run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        (address, handle, task)
    }

    fn start_proxy(upstream: SocketAddr) -> RunningServer {
        let proxy = web::Data::new(PublicIngressWebSocketProxy::new(upstream).unwrap());
        let server = HttpServer::new(move || {
            App::new()
                .app_data(proxy.clone())
                .default_service(web::to(websocket_proxy_handler))
        })
        .bind(("127.0.0.1", 0))
        .expect("loopback proxy binds");
        let address = server.addrs()[0];
        let server = server.run();
        let handle = server.handle();
        let task = actix_web::rt::spawn(server);
        (address, handle, task)
    }

    fn start_upstream(observations: Arc<Observations>) -> RunningServer {
        let observations = web::Data::new(observations);
        start_server(move |config| {
            config.app_data(observations.clone());
            config
                .route("/events", web::get().to(echo_websocket))
                .route("/close", web::get().to(close_websocket))
                .route("/unauthorized", web::get().to(unauthorized));
        })
    }

    async fn stop_server((_, handle, task): RunningServer) {
        handle.stop(true).await;
        task.await
            .expect("fixture task joins")
            .expect("fixture stops cleanly");
    }

    fn websocket_request(
        client: &Client,
        proxy: SocketAddr,
        path: &str,
        token: &str,
        cookie: &str,
        agent_id: &str,
        run_id: &str,
    ) -> awc::ws::WebsocketsRequest {
        client
            .ws(format!("ws://{proxy}{path}"))
            .max_frame_size(MAX_WEBSOCKET_FRAME_BYTES)
            .set_header(header::HOST, "private.example:3100")
            .set_header(header::ORIGIN, "https://private.example")
            .set_header(header::AUTHORIZATION, token)
            .set_header(header::COOKIE, cookie)
            .set_header("x-rudder-agent-id", agent_id)
            .set_header("x-rudder-run-id", run_id)
            .set_header("x-rudder-idempotency-key", "ws-operation-1")
            .set_header("x-rudder-required-authority", "rust")
            .set_header("x-rudder-signature", "signature-value")
            .set_header("x-rudder-timestamp", "1780000000")
            .set_header("x-rudder-installation-id", "installation-1")
            .set_header("x-rudder-telemetry-consent-version", "v1")
            .set_header("x-rudder-telemetry-consent-epoch", "2")
            .set_header(
                "x-rudder-telemetry-pseudonymous-installation-id",
                "pseudo-installation-1",
            )
            .set_header("x-rudder-actor-envelope", "client-forgery")
            .set_header("x-rudder-request-id", "client-forgery")
            .set_header("x-rudder-ingress-auth", "client-forgery")
            .set_header("x-rudder-ingress-forwarding-assertion", "client-forgery")
            .protocols(["rudder.events.v1"])
    }

    async fn echo_websocket(
        request: HttpRequest,
        payload: web::Payload,
        observations: web::Data<Arc<Observations>>,
    ) -> HttpResponse {
        let Some(authorization) = request.headers().get(header::AUTHORIZATION) else {
            return HttpResponse::Unauthorized().finish();
        };
        if !authorization
            .to_str()
            .is_ok_and(|value| value.starts_with("Bearer "))
        {
            return HttpResponse::Unauthorized().finish();
        }
        observations
            .handshakes
            .lock()
            .expect("handshake observations lock")
            .push(request.headers().clone());
        observations
            .targets
            .lock()
            .expect("request target observations lock")
            .push(
                request
                    .uri()
                    .path_and_query()
                    .map_or_else(|| "/".to_owned(), |target| target.as_str().to_owned()),
            );

        let Ok((response, mut session, messages)) =
            actix_ws::handle_with_protocols(&request, payload, &["rudder.events.v1"])
        else {
            return HttpResponse::BadRequest().finish();
        };
        let mut messages = messages.max_frame_size(MAX_WEBSOCKET_FRAME_BYTES);
        let observations = observations.get_ref().clone();
        actix_web::rt::spawn(async move {
            while let Some(message) = messages.recv().await {
                match message {
                    Ok(Message::Close(reason)) => {
                        observations.closes.fetch_add(1, Ordering::SeqCst);
                        let _ = session.close(reason).await;
                        return;
                    }
                    Ok(Message::Nop) => {}
                    Ok(message) => {
                        if session.send(message).await.is_err() {
                            return;
                        }
                    }
                    Err(_) => {
                        observations.disconnects.fetch_add(1, Ordering::SeqCst);
                        let _ = session.close(Some(CloseCode::Protocol.into())).await;
                        return;
                    }
                }
            }
            let _ = session.close(Some(CloseCode::Away.into())).await;
        });
        response
    }

    async fn close_websocket(request: HttpRequest, payload: web::Payload) -> HttpResponse {
        let Ok((response, session, _messages)) = actix_ws::handle(&request, payload) else {
            return HttpResponse::BadRequest().finish();
        };
        actix_web::rt::spawn(async move {
            let _ = session.close(Some(CloseCode::Restart.into())).await;
        });
        response
    }

    async fn unauthorized() -> HttpResponse {
        HttpResponse::Unauthorized().finish()
    }

    fn assert_header(headers: &header::HeaderMap, name: &str, expected: &str) {
        assert_eq!(
            headers.get(name).unwrap().to_str().unwrap(),
            expected,
            "{name}"
        );
    }

    #[test]
    fn upstream_must_be_a_nonzero_loopback_socket() {
        assert!(PublicIngressWebSocketProxy::new("192.0.2.1:3100".parse().unwrap()).is_err());
        assert!(matches!(
            PublicIngressWebSocketProxy::new("127.0.0.1:0".parse().unwrap()),
            Err(PublicIngressWebSocketConfigError::InvalidUpstream)
        ));
        assert!(PublicIngressWebSocketProxy::new("[::1]:3100".parse().unwrap()).is_ok());
    }

    #[actix_web::test]
    async fn relays_frames_and_preserves_request_identity_on_reconnect() {
        let observations = Arc::new(Observations::default());
        let upstream = start_upstream(observations.clone());
        let proxy = start_proxy(upstream.0);
        let client = ClientBuilder::new()
            .disable_redirects()
            .no_default_headers()
            .finish();

        let (response, mut first) = websocket_request(
            &client,
            proxy.0,
            "/events?cursor=a%2Fb&mode=tail",
            "Bearer agent-token-one",
            "session=session-one",
            "agent-one",
            "run-one",
        )
        .connect()
        .await
        .expect("first authenticated upgrade succeeds");
        assert_eq!(
            response
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .unwrap(),
            "rudder.events.v1"
        );

        first
            .send(ClientMessage::Text("hello".into()))
            .await
            .unwrap();
        assert_eq!(
            first.next().await.unwrap().unwrap(),
            Frame::Text("hello".into())
        );
        first
            .send(ClientMessage::Binary(b"binary".as_slice().into()))
            .await
            .unwrap();
        assert_eq!(
            first.next().await.unwrap().unwrap(),
            Frame::Binary(b"binary".as_slice().into())
        );
        let large_payload = vec![b'x'; 128 * 1024];
        first
            .send(ClientMessage::Binary(large_payload.clone().into()))
            .await
            .unwrap();
        let large_response = first.next().await.unwrap().unwrap();
        assert!(
            matches!(
                &large_response,
                Frame::Binary(payload) if payload.as_ref() == large_payload.as_slice()
            ),
            "expected the 128 KiB binary frame to round-trip"
        );
        first
            .send(ClientMessage::Ping(b"ping-data".as_slice().into()))
            .await
            .unwrap();
        assert_eq!(
            first.next().await.unwrap().unwrap(),
            Frame::Ping(b"ping-data".as_slice().into())
        );
        first
            .send(ClientMessage::Pong(b"pong-data".as_slice().into()))
            .await
            .unwrap();
        assert_eq!(
            first.next().await.unwrap().unwrap(),
            Frame::Pong(b"pong-data".as_slice().into())
        );
        for (item, expected) in [
            (
                Item::FirstText("fragment-1".as_bytes().into()),
                Item::FirstText("fragment-1".as_bytes().into()),
            ),
            (
                Item::Continue("fragment-2".as_bytes().into()),
                Item::Continue("fragment-2".as_bytes().into()),
            ),
            (
                Item::Last("fragment-3".as_bytes().into()),
                Item::Last("fragment-3".as_bytes().into()),
            ),
        ] {
            first.send(ClientMessage::Continuation(item)).await.unwrap();
            assert_eq!(
                first.next().await.unwrap().unwrap(),
                Frame::Continuation(expected)
            );
        }
        let close_reason = Some((CloseCode::Normal, "client done").into());
        first
            .send(ClientMessage::Close(close_reason.clone()))
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), first.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            Frame::Close(close_reason)
        );
        drop(first);

        let (response, mut second) = websocket_request(
            &client,
            proxy.0,
            "/events?cursor=second",
            "Bearer agent-token-two",
            "session=session-two",
            "agent-two",
            "run-two",
        )
        .connect()
        .await
        .expect("reconnected identity gets a new upstream handshake");
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        second
            .send(ClientMessage::Text("second".into()))
            .await
            .unwrap();
        assert_eq!(
            second.next().await.unwrap().unwrap(),
            Frame::Text("second".into())
        );
        let _ = second
            .send(ClientMessage::Close(Some(CloseCode::Normal.into())))
            .await;
        drop(second);

        {
            let handshakes = observations.handshakes.lock().unwrap();
            assert_eq!(handshakes.len(), 2);
            assert_header(
                &handshakes[0],
                header::HOST.as_str(),
                "private.example:3100",
            );
            assert_header(
                &handshakes[0],
                header::ORIGIN.as_str(),
                "https://private.example",
            );
            assert_header(
                &handshakes[0],
                header::AUTHORIZATION.as_str(),
                "Bearer agent-token-one",
            );
            assert_header(
                &handshakes[0],
                header::COOKIE.as_str(),
                "session=session-one",
            );
            assert_header(&handshakes[0], "x-rudder-agent-id", "agent-one");
            assert_header(&handshakes[0], "x-rudder-run-id", "run-one");
            for (name, value) in [
                ("x-rudder-idempotency-key", "ws-operation-1"),
                ("x-rudder-required-authority", "rust"),
                ("x-rudder-signature", "signature-value"),
                ("x-rudder-timestamp", "1780000000"),
                ("x-rudder-installation-id", "installation-1"),
                ("x-rudder-telemetry-consent-version", "v1"),
                ("x-rudder-telemetry-consent-epoch", "2"),
                (
                    "x-rudder-telemetry-pseudonymous-installation-id",
                    "pseudo-installation-1",
                ),
            ] {
                assert_header(&handshakes[0], name, value);
            }
            for name in [
                "x-rudder-actor-envelope",
                "x-rudder-request-id",
                "x-rudder-ingress-auth",
                "x-rudder-ingress-forwarding-assertion",
            ] {
                assert!(handshakes[0].get(name).is_none(), "{name} must be stripped");
            }
            assert_header(
                &handshakes[1],
                header::AUTHORIZATION.as_str(),
                "Bearer agent-token-two",
            );
            assert_header(
                &handshakes[1],
                header::COOKIE.as_str(),
                "session=session-two",
            );
            assert_header(&handshakes[1], "x-rudder-agent-id", "agent-two");
            assert_header(&handshakes[1], "x-rudder-run-id", "run-two");
            assert_eq!(
                handshakes[0].get(header::HOST),
                handshakes[1].get(header::HOST)
            );
        }
        assert_eq!(
            *observations.targets.lock().unwrap(),
            ["/events?cursor=a%2Fb&mode=tail", "/events?cursor=second"]
        );

        stop_server(proxy).await;
        stop_server(upstream).await;
    }

    #[actix_web::test]
    async fn disconnect_closes_the_upstream_and_server_close_code_reaches_client() {
        let observations = Arc::new(Observations::default());
        let upstream = start_upstream(observations.clone());
        let proxy = start_proxy(upstream.0);
        let client = Client::new();

        let (_, disconnected) = websocket_request(
            &client,
            proxy.0,
            "/events",
            "Bearer disconnect-token",
            "session=disconnect",
            "agent-disconnect",
            "run-disconnect",
        )
        .connect()
        .await
        .expect("upgrade succeeds");
        drop(disconnected);
        tokio::time::timeout(Duration::from_secs(2), async {
            while observations.closes.load(Ordering::SeqCst)
                + observations.disconnects.load(Ordering::SeqCst)
                == 0
            {
                actix_web::rt::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("downstream disconnect closes the private upstream");

        let (_server_close, mut socket) = client
            .ws(format!("ws://{}/close", proxy.0))
            .set_header(header::HOST, "private.example:3100")
            .set_header(header::AUTHORIZATION, "Bearer close-token")
            .connect()
            .await
            .expect("second upgrade succeeds");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            Frame::Close(Some(CloseCode::Restart.into()))
        );

        drop(socket);
        stop_server(proxy).await;
        stop_server(upstream).await;
    }

    #[actix_web::test]
    async fn upstream_auth_rejection_is_returned_without_public_upgrade() {
        let observations = Arc::new(Observations::default());
        let upstream = start_upstream(observations);
        let proxy = start_proxy(upstream.0);
        let client = ClientBuilder::new()
            .disable_redirects()
            .no_default_headers()
            .finish();

        let result = client
            .ws(format!("ws://{}/unauthorized", proxy.0))
            .set_header(header::HOST, "private.example:3100")
            .connect()
            .await;
        let Err(error) = result else {
            panic!("upstream authentication rejection must not upgrade publicly");
        };
        assert!(matches!(
            error,
            awc::error::WsClientError::InvalidResponseStatus(StatusCode::UNAUTHORIZED)
        ));

        stop_server(proxy).await;
        stop_server(upstream).await;
    }

    #[actix_web::test]
    async fn private_auth_adapter_is_never_proxied_and_non_get_is_rejected() {
        let observations = Arc::new(Observations::default());
        let upstream = start_upstream(observations.clone());
        let proxy = start_proxy(upstream.0);
        let client = Client::new();

        let response = client
            .post(format!(
                "http://{}/api/_internal/rudder-ingress/authorize-member-directory",
                proxy.0
            ))
            .send()
            .await
            .expect("private adapter request reaches proxy handler");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = client
            .post(format!("http://{}/events", proxy.0))
            .send()
            .await
            .expect("non-GET request reaches proxy handler");
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers().get(header::ALLOW).unwrap(), "GET");
        assert!(observations.handshakes.lock().unwrap().is_empty());

        stop_server(proxy).await;
        stop_server(upstream).await;
    }
}
