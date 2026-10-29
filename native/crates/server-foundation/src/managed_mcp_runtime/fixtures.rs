//! Disposable PostgreSQL + synthetic loopback peers. No user/provider data.
#![allow(dead_code)]
use super::*;
use crate::postgres_test_support as support;
use rudder_d1_persistence::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    agent_execution::{self, AgentExecutionActor, AgentWakeRequest},
    secrets,
};
use sqlx::PgConnection;
use std::{future::Future, pin::Pin};
struct Board;
impl NativeAgentAuthorizer for Board {
    fn revalidate<'a>(
        &'a self,
        _: &'a mut PgConnection,
        org: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            Ok(if org == support::ORG {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Forbidden
            })
        })
    }
}
struct Fixture {
    database: support::Database,
    identity: Identity,
    binding: String,
    connection: String,
    claim: agent_execution::AgentRunClaim,
    root: tempfile::TempDir,
}
impl Fixture {
    async fn new(
        provider: &str,
        safe_config: Value,
        credential: Option<&Value>,
        authorization: Option<Value>,
    ) -> Self {
        let database = support::Database::start().await;
        let agent = uuid::Uuid::new_v4().to_string();
        let connection = uuid::Uuid::new_v4().to_string();
        let binding = uuid::Uuid::new_v4().to_string();
        let tool = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Synthetic managed MCP fixture','general','idle','process','{\"command\":\"/bin/true\"}'::jsonb,'{}'::jsonb)").bind(&agent).bind(support::ORG).execute(&database.pool).await.unwrap();
        let secret = if let Some(credential) = credential {
            assert!(
                std::env::var("RUDDER_SECRETS_MASTER_KEY").is_ok(),
                "fixture requires an explicit synthetic RUDDER_SECRETS_MASTER_KEY; never creates a repo/user key file"
            );
            let(_,created)=secrets::execute_secrets_for_actor(&database.pool,support::ORG,"synthetic-managed-mcp-fixture",&json!({"operation":"create","input":{"name":"synthetic-managed-mcp-material","value":credential.to_string()}}),&Board).await.unwrap();
            let id = created["id"].as_str().unwrap().to_owned();
            sqlx::query("UPDATE organization_secrets SET purpose=$2 WHERE id=$1::uuid")
                .bind(&id)
                .bind(if provider == "custom" {
                    "managed_mcp_connection"
                } else {
                    "managed_mcp_oauth"
                })
                .execute(&database.pool)
                .await
                .unwrap();
            Some(id)
        } else {
            None
        };
        sqlx::query("INSERT INTO mcp_connections(id,org_id,name,display_name,provider,transport,access_mode,status,enabled,safe_config,credential_secret_id) VALUES($1::uuid,$2::uuid,'synthetic-fixture','Synthetic fixture',$3,'streamable_http',$4,'active',true,$5::jsonb,$6::uuid)").bind(&connection).bind(support::ORG).bind(provider).bind(if provider=="custom"{"provider_default"}else{"read_write"}).bind(safe_config).bind(if provider=="custom"{secret.as_deref()}else{None}).execute(&database.pool).await.unwrap();
        if provider != "custom" {
            sqlx::query("INSERT INTO mcp_oauth_grants(org_id,connection_id,credential_secret_id,status,status_metadata) VALUES($1::uuid,$2::uuid,$3::uuid,'active',$4::jsonb)").bind(support::ORG).bind(&connection).bind(secret.as_deref()).bind(json!({"authorization":authorization})).execute(&database.pool).await.unwrap();
        }
        sqlx::query("INSERT INTO custom_integration_tools(id,org_id,connection_id,external_tool_name,rudder_tool_name,capability_class,input_schema) VALUES($1::uuid,$2::uuid,$3::uuid,'fixture_read','external.synthetic.fixture_read','read','{\"type\":\"object\"}'::jsonb)").bind(&tool).bind(support::ORG).bind(&connection).execute(&database.pool).await.unwrap();
        sqlx::query("INSERT INTO agent_custom_integration_bindings(id,org_id,agent_id,connection_id,status,access_mode,enabled_tool_ids) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'active',$5,$6::jsonb)").bind(&binding).bind(support::ORG).bind(&agent).bind(&connection).bind(if provider=="custom"{"full"}else{"read_write"}).bind(json!([tool])).execute(&database.pool).await.unwrap();
        let descriptors = d1::resolve_runtime_bindings(&database.pool, support::ORG, &agent)
            .await
            .unwrap();
        assert_eq!(descriptors.len(), 1);
        assert_eq!(
            descriptors[0]["toolPolicy"]["allowedToolNames"],
            json!(["external.synthetic.fixture_read"])
        );
        let admitted = agent_execution::admit(
            &database.pool,
            &Board,
            &AgentExecutionActor {
                actor_type: "user",
                actor_id: "synthetic-managed-mcp-fixture".into(),
                run_id: None,
            },
            &AgentWakeRequest {
                organization_id: support::ORG.into(),
                agent_id: agent.clone(),
                source: "on_demand".into(),
                trigger_detail: Some("manual".into()),
                reason: Some("synthetic_managed_mcp_fixture".into()),
                payload: Some(json!({})),
                idempotency_key: Some(uuid::Uuid::new_v4().to_string()),
                context_snapshot: json!({"managedMcpPolicySnapshot":descriptors}),
            },
        )
        .await
        .unwrap();
        let run = admitted.run_id.unwrap();
        let claim = agent_execution::claim_queued_run(&database.pool, support::ORG, &run)
            .await
            .unwrap()
            .unwrap();
        Self {
            database,
            identity: Identity {
                organization_id: support::ORG.into(),
                agent_id: agent,
                run_id: run,
            },
            binding,
            connection,
            claim,
            root: tempfile::tempdir().unwrap(),
        }
    }
    fn host(&self, origin: &str) -> Host {
        Host {
            deployment_mode: "local_trusted".into(),
            process_host: Default::default(),
            runtime_root: self.root.path().join("runtime"),
            environment: [("RUDDER_MCP_HTTP_ALLOWLIST".into(), origin.into())]
                .into_iter()
                .collect(),
            oauth_redirect_uri: "http://127.0.0.1:3100/api/mcp/oauth/callback".into(),
        }
    }
}
fn read_request(socket: &mut std::net::TcpStream) -> (String, String) {
    use std::io::Read;
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        socket.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    let head = String::from_utf8(bytes).unwrap();
    let count = head
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; count];
    socket.read_exact(&mut body).unwrap();
    (head, String::from_utf8(body).unwrap())
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL 188 and an explicit synthetic secrets key"]
async fn native_binding_list_call_audit_and_live_revoke() {
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let fixture = Fixture::new(
        "custom",
        json!({"url":format!("{origin}/mcp")}),
        Some(&json!({"bearerToken":"synthetic-fixture-token"})),
        None,
    )
    .await;
    let peer = std::thread::spawn(move || {
        for method in ["server/discover", "tools/call"] {
            let (mut socket, _) = listener.accept().unwrap();
            let (head, body) = read_request(&mut socket);
            assert!(
                head.to_ascii_lowercase()
                    .contains("authorization: bearer synthetic-fixture-token")
            );
            let request: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(request["method"], method);
            let result = if method == "server/discover" {
                json!({"supportedVersions":[MODERN],"capabilities":{"tools":{}},"resultType":"complete"})
            } else {
                assert_eq!(request["params"]["name"], "fixture_read");
                json!({"content":[{"type":"text","text":"synthetic managed result"}],"resultType":"complete"})
            };
            let body = json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    let host = fixture.host(&origin);
    let listed = handle(
        &fixture.database.pool,
        &fixture.identity,
        &fixture.binding,
        &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        None,
        &host,
    )
    .await
    .body
    .unwrap();
    assert_eq!(
        listed["result"]["tools"][0]["name"],
        "external.synthetic.fixture_read"
    );
    let called=handle(&fixture.database.pool,&fixture.identity,&fixture.binding,&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"external.synthetic.fixture_read","arguments":{"access_token":"synthetic-private-input","contact":"fixture@example.test"}}}),None,&host).await.body.unwrap();
    assert_eq!(
        called["result"]["content"][0]["text"],
        "synthetic managed result"
    );
    peer.join().unwrap();
    let audit:Value=sqlx::query_scalar("SELECT to_jsonb(c) FROM custom_integration_tool_calls c WHERE org_id=$1::uuid AND run_id=$2::uuid").bind(support::ORG).bind(&fixture.identity.run_id).fetch_one(&fixture.database.pool).await.unwrap();
    assert_eq!(audit["status"], "success");
    assert!(
        !audit["sanitized_input"]
            .to_string()
            .contains("synthetic-private-input")
    );
    assert!(
        !audit["sanitized_input"]
            .to_string()
            .contains("fixture@example.test")
    );
    sqlx::query("UPDATE agent_custom_integration_bindings SET status='revoked',revoked_at=statement_timestamp() WHERE id=$1::uuid").bind(&fixture.binding).execute(&fixture.database.pool).await.unwrap();
    let denied = handle(
        &fixture.database.pool,
        &fixture.identity,
        &fixture.binding,
        &json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
        None,
        &host,
    )
    .await
    .body
    .unwrap();
    assert_eq!(denied["error"]["code"], -32001);
    let foreign = Identity {
        organization_id: support::OTHER.into(),
        agent_id: fixture.identity.agent_id.clone(),
        run_id: fixture.identity.run_id.clone(),
    };
    assert!(matches!(
        d1::require_binding(&fixture.database.pool, &foreign, &fixture.binding, true).await,
        Err(Error::Denied)
    ));
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL 188 and an explicit synthetic secrets key"]
async fn oauth_refresh_rotates_fences_and_invalid_authorizer_revokes() {
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let material = json!({"clientInformation":{"client_id":"synthetic-client","token_endpoint_auth_method":"none","issuer":format!("{origin}/")},"tokens":{"access_token":"synthetic-old-access","refresh_token":"synthetic-old-refresh","token_type":"Bearer","issuer":format!("{origin}/")},"discoveryState":{"authorizationServerUrl":format!("{origin}/"),"authorizationServerMetadata":{"issuer":format!("{origin}/"),"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"token_endpoint_auth_methods_supported":["none"]},"resourceMetadata":{"resource":format!("{origin}/mcp")}}});
    let fixture = Fixture::new(
        "linear",
        json!({}),
        Some(&material),
        Some(json!({"serverUrl":format!("{origin}/mcp"),"accessMode":"read_write"})),
    )
    .await;
    let host = fixture.host(&origin);
    let access = d1::require_binding(
        &fixture.database.pool,
        &fixture.identity,
        &fixture.binding,
        true,
    )
    .await
    .unwrap();
    let baseline = d1::credentials(&fixture.database.pool, &fixture.identity, &access, true)
        .await
        .unwrap()
        .oauth
        .unwrap();
    let peer = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let (head, body) = read_request(&mut socket);
        assert!(head.starts_with("POST /token "));
        let form = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        assert_eq!(form["grant_type"], "refresh_token");
        assert_eq!(form["refresh_token"], "synthetic-old-refresh");
        assert_eq!(form["client_id"], "synthetic-client");
        let body=json!({"access_token":"synthetic-new-access","refresh_token":"synthetic-new-refresh","token_type":"Bearer","expires_in":3600,"scope":"read write"}).to_string();
        write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    oauth::refresh(
        &fixture.database.pool,
        &fixture.identity,
        &access,
        &baseline,
        &host,
    )
    .await
    .unwrap();
    peer.join().unwrap();
    let current = d1::credentials(&fixture.database.pool, &fixture.identity, &access, true)
        .await
        .unwrap()
        .oauth
        .unwrap();
    assert_eq!(current.latest_version, 2);
    assert_eq!(
        current.material["tokens"]["access_token"],
        "synthetic-new-access"
    );
    assert_eq!(
        current.material["tokens"]["refresh_token"],
        "synthetic-new-refresh"
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='mcp_oauth.token_refreshed'").bind(support::ORG).bind(&fixture.connection).fetch_one(&fixture.database.pool).await.unwrap();
    assert_eq!(count, 1);
    let lease = match d1::claim_refresh(
        &fixture.database.pool,
        &fixture.identity,
        &access,
        &current,
        true,
    )
    .await
    .unwrap()
    {
        d1::RefreshClaim::Owned(lease) => lease,
        _ => panic!("fixture owns the next existing refresh nonce"),
    };
    sqlx::query("UPDATE mcp_oauth_grants SET refresh_lease_nonce=$2 WHERE id=$1::uuid")
        .bind(&current.grant_id)
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&fixture.database.pool)
        .await
        .unwrap();
    assert!(matches!(
        d1::finish_refresh(
            &fixture.database.pool,
            &lease,
            d1::RefreshOutcome::Success(&current.material),
            true
        )
        .await,
        Err(Error::Runtime("mcp_oauth_refresh_stale"))
    ));
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES('synthetic-revoked-authorizer','Synthetic revoked authorizer','revoked@example.test',statement_timestamp(),statement_timestamp())").execute(&fixture.database.pool).await.unwrap();
    sqlx::query("UPDATE mcp_oauth_grants SET authorizing_user_id='synthetic-revoked-authorizer' WHERE id=$1::uuid").bind(&current.grant_id).execute(&fixture.database.pool).await.unwrap();
    assert!(matches!(
        d1::require_binding(
            &fixture.database.pool,
            &fixture.identity,
            &fixture.binding,
            false
        )
        .await,
        Err(Error::Denied)
    ));
    let status: String = sqlx::query_scalar("SELECT status FROM mcp_connections WHERE id=$1::uuid")
        .bind(&fixture.connection)
        .fetch_one(&fixture.database.pool)
        .await
        .unwrap();
    assert_eq!(status, "needs_reauth");
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_secrets WHERE id=$1::uuid)")
            .bind(&current.secret_id)
            .fetch_one(&fixture.database.pool)
            .await
            .unwrap();
    assert!(!exists);
}
