use crate::native_bearer_auth;
use crate::native_session_auth::{self, NativeSessionAccess, NativeSessionIdentity};
use crate::public_ingress_config::NativeSessionAuthKind;
use crate::{ActorIdentity, PgConnection};

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
                    connection, token_hash, org_id, actor, session_id,
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
        };
        Ok(access)
    }
}
