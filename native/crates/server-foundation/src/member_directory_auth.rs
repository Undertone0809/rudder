use crate::native_agent_jwt::NativeAgentJwtIdentity;
use crate::native_bearer_auth;
use crate::native_session_auth::{self, NativeSessionAccess, NativeSessionIdentity};
use crate::public_ingress_config::NativeSessionAuthKind;
use crate::{ActorIdentity, PgConnection};
use rudder_d1_persistence::agent_core::{NativeAgentAccess, NativeAgentAuthorizer};
use std::{future::Future, pin::Pin};

pub(super) enum MemberDirectoryNativeAuth<'a> {
    Bearer {
        actor: &'a ActorIdentity,
        session_id: &'a str,
        token_hash: &'a str,
    },
    Session {
        identity: &'a NativeSessionIdentity,
        kind: NativeSessionAuthKind,
    },
    AgentJwt {
        identity: &'a NativeAgentJwtIdentity,
    },
    LocalImplicit,
}

#[derive(Clone, Copy)]
pub(super) enum MemberDirectoryNativeAccess {
    Authorized,
    Unauthorized,
    Forbidden,
}

impl MemberDirectoryNativeAuth<'_> {
    pub(super) async fn revalidate(
        &self,
        connection: &mut PgConnection,
        org_id: &str,
    ) -> Result<MemberDirectoryNativeAccess, sqlx::Error> {
        let access = match self {
            Self::Bearer {
                actor,
                session_id,
                token_hash,
            } => {
                match native_bearer_auth::revalidate_native_bearer_in_snapshot(
                    connection,
                    token_hash,
                    Some(org_id),
                    actor,
                    session_id,
                )
                .await?
                {
                    native_bearer_auth::NativeBearerAccess::Authorized => {
                        MemberDirectoryNativeAccess::Authorized
                    }
                    native_bearer_auth::NativeBearerAccess::Unauthorized => {
                        MemberDirectoryNativeAccess::Unauthorized
                    }
                    native_bearer_auth::NativeBearerAccess::Forbidden => {
                        MemberDirectoryNativeAccess::Forbidden
                    }
                }
            }
            Self::Session { identity, kind } => {
                match native_session_auth::revalidate_in_snapshot(
                    connection, identity, org_id, *kind,
                )
                .await?
                {
                    NativeSessionAccess::Authorized => MemberDirectoryNativeAccess::Authorized,
                    NativeSessionAccess::Unauthorized => MemberDirectoryNativeAccess::Unauthorized,
                    NativeSessionAccess::Forbidden => MemberDirectoryNativeAccess::Forbidden,
                }
            }
            Self::AgentJwt { identity } => {
                match native_bearer_auth::revalidate_native_agent_jwt_in_snapshot(
                    connection,
                    identity,
                    Some(org_id),
                )
                .await?
                {
                    native_bearer_auth::NativeBearerAccess::Authorized => {
                        MemberDirectoryNativeAccess::Authorized
                    }
                    native_bearer_auth::NativeBearerAccess::Unauthorized => {
                        MemberDirectoryNativeAccess::Unauthorized
                    }
                    native_bearer_auth::NativeBearerAccess::Forbidden => {
                        MemberDirectoryNativeAccess::Forbidden
                    }
                }
            }
            // This identity is issued only by the public ingress after both
            // the configured listener bind and the actual socket peer are
            // verified as numeric loopback. It is the existing local-trusted
            // full-control Board actor and has no user row to revalidate.
            Self::LocalImplicit => MemberDirectoryNativeAccess::Authorized,
        };
        Ok(access)
    }
}

impl NativeAgentAuthorizer for MemberDirectoryNativeAuth<'_> {
    fn revalidate<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        org_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            self.revalidate(connection, org_id)
                .await
                .map(|access| match access {
                    MemberDirectoryNativeAccess::Authorized => NativeAgentAccess::Authorized,
                    MemberDirectoryNativeAccess::Unauthorized => NativeAgentAccess::Unauthorized,
                    MemberDirectoryNativeAccess::Forbidden => NativeAgentAccess::Forbidden,
                })
        })
    }
}
