mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::agent_core::{
    AgentCoreError, AgentCoreRequest, NativeAgentAccess, NativeAgentAuthorizer,
    execute_agent_with_native_auth,
};
use sqlx::PgConnection;
use std::{future::Future, pin::Pin};
use support::{Database, ORG};

const SECRET: &[u8] = b"native-agent-core-roster-revalidation-test-key";
const BOARD_USER: &str = "roster-board-user";

fn verified_board_user() -> VerifiedActor {
    let actor = ActorIdentity::new("user", BOARD_USER).expect("valid board user identity");
    let path = format!("/api/orgs/{ORG}/agents");
    let body = br#"{"operation":"list"}"#;
    let request_id = "agent-core-roster-revalidation-request";
    let nonce = "agent-core-roster-revalidation-nonce";
    let envelope = ActorEnvelope::new(
        actor.clone(),
        ORG,
        "board-session",
        1,
        "rudder-server-foundation",
        "GET",
        &path,
        "agent-core.execute",
        body,
        request_id,
        nonce,
        1_000,
        1_100,
    )
    .expect("unsigned actor envelope")
    .sign(SECRET)
    .expect("signed actor envelope");
    let request = RequestContext::new(
        &actor,
        ORG,
        "board-session",
        1,
        "rudder-server-foundation",
        "GET",
        &path,
        "agent-core.execute",
        body,
        request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified actor envelope")
}

struct RevokedMembershipAuthorizer {
    user_id: &'static str,
}

impl NativeAgentAuthorizer for RevokedMembershipAuthorizer {
    fn revalidate<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        org_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            // Revoke the board user's membership after the initial
            // authorize_org check. This mirrors the production membership
            // query and exercises a real scope denial during revalidation.
            sqlx::query(
                "UPDATE organization_memberships SET status='revoked' WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
            )
                .bind(org_id)
                .bind(self.user_id)
                .execute(&mut *connection)
                .await?;
            let active = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active')",
            )
            .bind(org_id)
            .bind(self.user_id)
            .fetch_one(&mut *connection)
            .await?;
            Ok(if active {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Forbidden
            })
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn roster_revalidation_denial_returns_forbidden_after_initial_board_access() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Roster User','roster-user@example.test',now(),now())",
    )
    .bind(BOARD_USER)
    .execute(&database.pool)
    .await
    .expect("seed board user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(BOARD_USER)
    .execute(&database.pool)
    .await
    .expect("seed active organization membership");

    let actor = verified_board_user();
    let request = AgentCoreRequest::parse(
        br#"{"operation":"list","orgId":"10000000-0000-4000-8000-000000000001","query":{}}"#,
    )
    .expect("valid roster request");

    let result = execute_agent_with_native_auth(
        &database.pool,
        &actor,
        &request,
        &RevokedMembershipAuthorizer {
            user_id: BOARD_USER,
        },
    )
    .await;
    match result {
        Err(AgentCoreError::Http(403, message, _)) => assert_eq!(message, "Forbidden"),
        other => panic!("expected revalidation denial, got {other:?}"),
    }
}
