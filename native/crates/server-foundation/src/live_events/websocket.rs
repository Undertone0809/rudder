//! Native org live-event WebSocket. Public ingress resolves existing native
//! credentials; this owner revalidates them and Run visibility in PostgreSQL.
use super::{LiveEvent, LiveEventPublisher, Subscription};
use crate::{
    ActorIdentity,
    member_directory_auth::{MemberDirectoryNativeAccess, MemberDirectoryNativeAuth},
    native_session_auth::NativeIngressIdentity,
    native_session_revocation::SessionRevocationRegistration,
    public_ingress_config::NativeSessionAuthKind,
};
use actix_web::{HttpRequest, HttpResponse, web};
use actix_ws::{CloseCode, CloseReason, Message};
use futures_util::StreamExt;
use serde_json::json;
use sqlx::PgPool;
use std::{
    collections::{HashSet, VecDeque},
    time::Duration,
};

const PING_INTERVAL: Duration = Duration::from_secs(30);
const MAX_FRAME_BYTES: usize = 100 * 1024 * 1024; // existing ws transport default
const DEDUPE_WINDOW: usize = 1024;

/// The sole existing subscription path. No client message can change org or
/// authentication after upgrade; reconnect performs authentication again.
pub(crate) fn organization_from_path(path: &str) -> Option<String> {
    let segment = path
        .strip_prefix("/api/orgs/")?
        .strip_suffix("/events/ws")?;
    if segment.is_empty() || segment.contains('/') {
        return None;
    }
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return None;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    let decoded = percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .ok()?;
    uuid::Uuid::parse_str(&decoded)
        .ok()
        .map(|id| id.to_string())
}
/// Preserve WS header-first then ?token= compatibility. The public ingress
/// resolves this token using the native bearer verifier, never a Node adapter.
pub(crate) fn bearer_token(request: &HttpRequest) -> Option<String> {
    let header = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|auth| {
            auth.get(..7)
                .filter(|prefix| prefix.eq_ignore_ascii_case("bearer "))
                .and_then(|_| auth.get(7..))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty());
    header.map(str::to_owned).or_else(|| {
        url::form_urlencoded::parse(request.query_string().as_bytes())
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

struct SocketIdentity {
    identity: NativeIngressIdentity,
    actor: ActorIdentity,
    session_id: String,
    session_kind: NativeSessionAuthKind,
}
impl SocketIdentity {
    fn new(identity: NativeIngressIdentity, session_kind: NativeSessionAuthKind) -> Option<Self> {
        let (kind, id, session_id) = match &identity {
            NativeIngressIdentity::None => return None,
            NativeIngressIdentity::LocalImplicit => {
                ("board", "board".to_owned(), "local-implicit".into())
            }
            NativeIngressIdentity::Session(identity) => (
                "user",
                identity.user_id.clone(),
                identity.session_id.clone(),
            ),
            NativeIngressIdentity::BoardKey {
                user_id, key_id, ..
            } => ("user", user_id.clone(), format!("board-key:{key_id}")),
            NativeIngressIdentity::AgentKey {
                agent_id, key_id, ..
            } => ("agent", agent_id.clone(), format!("agent-key:{key_id}")),
            NativeIngressIdentity::AgentJwt(identity) => (
                "agent",
                identity.agent_id.clone(),
                format!("agent-jwt:{}", identity.agent_id),
            ),
        };
        Some(Self {
            identity,
            actor: ActorIdentity::new(kind, id).ok()?,
            session_id,
            session_kind,
        })
    }
    fn owner(&self) -> Option<&str> {
        (self.actor.kind == "user").then_some(self.actor.id.as_str())
    }
    fn authorizer(&self) -> MemberDirectoryNativeAuth<'_> {
        match &self.identity {
            NativeIngressIdentity::LocalImplicit => MemberDirectoryNativeAuth::LocalImplicit,
            NativeIngressIdentity::Session(identity) => MemberDirectoryNativeAuth::Session {
                identity,
                kind: self.session_kind,
            },
            NativeIngressIdentity::BoardKey { token_hash, .. }
            | NativeIngressIdentity::AgentKey { token_hash, .. } => {
                MemberDirectoryNativeAuth::Bearer {
                    actor: &self.actor,
                    session_id: &self.session_id,
                    token_hash,
                }
            }
            NativeIngressIdentity::AgentJwt(identity) => {
                MemberDirectoryNativeAuth::AgentJwt { identity }
            }
            NativeIngressIdentity::None => {
                unreachable!("unauthenticated identity cannot construct a native socket")
            }
        }
    }
    async fn authorized(
        &self,
        pool: &PgPool,
        org: &str,
        event: Option<&LiveEvent>,
    ) -> Result<FrameAccess, sqlx::Error> {
        let mut tx = pool.begin().await?;
        let authorized = matches!(
            self.authorizer().revalidate(&mut tx, org).await?,
            MemberDirectoryNativeAccess::Authorized
        );
        if !authorized {
            return Ok(FrameAccess::Revoked);
        }
        let visible = if let Some(event) = event {
            if event.org_id != org {
                false
            } else {
                rudder_d1_persistence::live_event_access::visible_in_transaction(
                    &mut tx,
                    org,
                    self.owner(),
                    &event.event_type,
                    &event.payload,
                )
                .await?
            }
        } else {
            true
        };
        tx.commit().await?;
        Ok(if visible {
            FrameAccess::Visible
        } else {
            FrameAccess::Hidden
        })
    }
}
enum FrameAccess {
    Visible,
    Hidden,
    Revoked,
}
#[derive(Default)]
struct Dedupe {
    keys: HashSet<String>,
    order: VecDeque<String>,
}
impl Dedupe {
    fn admit(&mut self, key: Option<&str>) -> bool {
        let Some(key) = key else {
            return true;
        };
        if !self.keys.insert(key.into()) {
            return false;
        }
        self.order.push_back(key.into());
        if self.order.len() > DEDUPE_WINDOW {
            if let Some(oldest) = self.order.pop_front() {
                self.keys.remove(&oldest);
            }
        }
        true
    }
}
fn close(code: CloseCode, description: &str) -> Option<CloseReason> {
    Some(CloseReason {
        code,
        description: Some(description.into()),
    })
}
async fn revoked(registration: &mut Option<SessionRevocationRegistration>) {
    if let Some(registration) = registration {
        registration.cancelled().await;
    } else {
        std::future::pending::<()>().await;
    }
}
fn is_revoked(registration: &mut Option<SessionRevocationRegistration>) -> bool {
    registration
        .as_mut()
        .is_some_and(SessionRevocationRegistration::is_cancelled)
}

/// Ingress supplies a credential proof from its native resolver and begins the
/// existing local-account revocation registration before asynchronous auth.
/// No Node authorization, frame emitter, or socket is required by this path.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upgrade(
    request: HttpRequest,
    payload: web::Payload,
    publisher: LiveEventPublisher,
    pool: PgPool,
    identity: NativeIngressIdentity,
    session_kind: NativeSessionAuthKind,
    mut revocation: Option<SessionRevocationRegistration>,
) -> HttpResponse {
    let Some(org) = organization_from_path(request.path()) else {
        return HttpResponse::NotFound().finish();
    };
    let Some(identity) = SocketIdentity::new(identity, session_kind) else {
        return HttpResponse::Forbidden().json(json!({"error":"forbidden"}));
    };
    let mut shutdown = publisher.shutdown.subscribe();
    if *shutdown.borrow() {
        return HttpResponse::ServiceUnavailable().json(json!({"error":"Live events are closed"}));
    }
    let authorized = tokio::select! {
        _=revoked(&mut revocation)=>return HttpResponse::Forbidden().json(json!({"error":"account session changed"})),
        _=shutdown.changed()=>return HttpResponse::ServiceUnavailable().json(json!({"error":"Live events are closed"})),
        authorized=identity.authorized(&pool,&org,None)=>authorized,
    };
    match authorized {
        Ok(FrameAccess::Visible) => {}
        Ok(_) => return HttpResponse::Forbidden().json(json!({"error":"forbidden"})),
        Err(_) => {
            return HttpResponse::ServiceUnavailable()
                .json(json!({"error":"Native live-event authorization is unavailable"}));
        }
    }
    if is_revoked(&mut revocation) {
        return HttpResponse::Forbidden().json(json!({"error":"account session changed"}));
    }
    let subscription = match publisher.subscribe(&org) {
        Ok(subscription) => subscription,
        Err(_) => {
            return HttpResponse::ServiceUnavailable()
                .json(json!({"error":"Live events are closed"}));
        }
    };
    let (response, session, stream) = match actix_ws::handle(&request, payload) {
        Ok(upgrade) => upgrade,
        Err(_) => {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid WebSocket upgrade"}));
        }
    };
    actix_web::rt::spawn(async move {
        relay(
            session,
            stream.max_frame_size(MAX_FRAME_BYTES),
            subscription,
            pool,
            org,
            identity,
            revocation,
        )
        .await;
    });
    response
}
async fn relay(
    mut session: actix_ws::Session,
    mut stream: actix_ws::MessageStream,
    mut subscription: Subscription,
    pool: PgPool,
    org: String,
    identity: SocketIdentity,
    mut revocation: Option<SessionRevocationRegistration>,
) {
    let mut ping =
        tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut alive = true;
    let mut dedupe = Dedupe::default();
    let reason = loop {
        if *subscription.shutdown.borrow() {
            break close(CloseCode::Away, "server shutting down");
        }
        if is_revoked(&mut revocation) {
            break close(CloseCode::Policy, "account signed out");
        }
        tokio::select! {
            _=revoked(&mut revocation)=>break close(CloseCode::Policy,"account signed out"),
            changed=subscription.shutdown.changed()=>{if changed.is_err()||*subscription.shutdown.borrow(){break close(CloseCode::Away,"server shutting down");}},
            event=subscription.receiver.recv()=>{
                let event=match event{Ok(event)=>event,Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>break close(CloseCode::Again,"live event subscriber fell behind; reconnect"),Err(tokio::sync::broadcast::error::RecvError::Closed)=>break close(CloseCode::Away,"server shutting down")};
                // Only this read-only auth/visibility future is interruptible.
                // A blocked SELECT must not hold the existing revocation close.
                let access=tokio::select!{
                    _=revoked(&mut revocation)=>break close(CloseCode::Policy,"account signed out"),
                    _=subscription.shutdown.changed()=>break close(CloseCode::Away,"server shutting down"),
                    access=identity.authorized(&pool,&org,Some(&event))=>access,
                };
                match access{Ok(FrameAccess::Hidden)=>continue,Ok(FrameAccess::Revoked)=>break close(CloseCode::Policy,"authentication revoked"),Err(_)=>break close(CloseCode::Error,"live event authorization failed"),Ok(FrameAccess::Visible)=>{}}
                if *subscription.shutdown.borrow(){break close(CloseCode::Away,"server shutting down");}
                if is_revoked(&mut revocation){break close(CloseCode::Policy,"account signed out");}if !dedupe.admit(event.dedupe_key.as_deref()){continue;}
                let text=match serde_json::to_string(event.as_ref()){Ok(text)=>text,Err(_)=>break close(CloseCode::Error,"live event encoding failed")};if session.text(text).await.is_err(){break None;}
            },
            _=ping.tick()=>{
                if !alive{break close(CloseCode::Away,"heartbeat timed out");}
                let access=tokio::select!{
                    _=revoked(&mut revocation)=>break close(CloseCode::Policy,"account signed out"),
                    _=subscription.shutdown.changed()=>break close(CloseCode::Away,"server shutting down"),
                    access=identity.authorized(&pool,&org,None)=>access,
                };
                match access{Ok(FrameAccess::Visible)=>{},Ok(_)=>break close(CloseCode::Policy,"authentication revoked"),Err(_)=>break close(CloseCode::Error,"live event authorization failed")}
                alive=false;if session.ping(b"").await.is_err(){break None;}
            },
            message=stream.next()=>match message{
                Some(Ok(Message::Pong(_)))=>alive=true,
                Some(Ok(Message::Ping(bytes)))=>{if session.pong(&bytes).await.is_err(){break None;}},
                Some(Ok(Message::Close(reason)))=>break reason,
                Some(Ok(_))=>{}, // existing transport has no client command protocol
                Some(Err(_))=>break close(CloseCode::Protocol,"invalid WebSocket frame"),
                None=>break None,
            }
        }
    };
    let _ = session.close(reason).await; // Subscription Drop removes its listener.
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;
    #[test]
    fn subscription_path_and_query_token_preserve_existing_contract() {
        assert_eq!(
            organization_from_path("/api/orgs/10000000-0000-4000-8000-000000000001/events/ws")
                .as_deref(),
            Some("10000000-0000-4000-8000-000000000001")
        );
        assert!(organization_from_path("/api/orgs/%xx/events/ws").is_none());
        assert!(
            organization_from_path(
                "/api/orgs/10000000-0000-4000-8000-000000000001/events/ws/extra"
            )
            .is_none()
        );
        let request = TestRequest::with_uri("/api/orgs/a/events/ws?token=query-token")
            .insert_header(("authorization", "Bearer header-token"))
            .to_http_request();
        assert_eq!(bearer_token(&request).as_deref(), Some("header-token"));
        let request = TestRequest::with_uri("/api/orgs/a/events/ws?token=%20query-token%20")
            .to_http_request();
        assert_eq!(bearer_token(&request).as_deref(), Some("query-token"));
    }
    #[test]
    fn dedupe_is_per_connection_and_bounded_fifo() {
        let mut first = Dedupe::default();
        let mut other = Dedupe::default();
        assert!(first.admit(Some("a")));
        assert!(!first.admit(Some("a")));
        assert!(other.admit(Some("a")));
        for index in 0..DEDUPE_WINDOW {
            assert!(first.admit(Some(&format!("key-{index}"))));
        }
        assert!(first.admit(Some("a")));
        assert!(first.admit(None));
    }
}
