//! Existing persistent OAuth refresh protocol, with the grant's original
//! nonce/latestVersion fence owned by D1. No refresh token leaves this module.
use super::{
    Host,
    d1::{self, Access, Error, Identity, OAuthCredential, RefreshClaim, RefreshOutcome},
    http,
    security::{self, Network},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{
    Method,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::{Duration, Instant};
use url::Url;
enum Failure {
    InvalidGrant,
    InvalidClient,
    Transient,
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str().filter(|v| !v.is_empty())
}
fn same_issuer(a: &str, b: &str) -> bool {
    a == b || a.strip_suffix('/') == Some(b) || b.strip_suffix('/') == Some(a)
}
fn oauth_network(host: &Host) -> Result<Network, Error> {
    let mut network = security::network(host, None)?;
    for origin in [
        "https://mcp.supabase.com",
        "https://api.supabase.com",
        "https://mcp.linear.app",
        "https://mcp.notion.com",
    ] {
        network.allowed_origins.insert(origin.into());
    }
    Ok(network)
}
async fn fetch(
    network: &Network,
    url: &Url,
    method: Method,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
) -> Result<(u16, Value), Failure> {
    let wire = http::request(
        network,
        url,
        method,
        headers,
        body,
        None,
        Duration::from_secs(90),
    )
    .await
    .map_err(|_| Failure::Transient)?;
    let value = match serde_json::from_slice(&wire.body) {
        Ok(value) => value,
        Err(_) if !(200..300).contains(&wire.status) => Value::Null,
        Err(_) => return Err(Failure::Transient),
    };
    Ok((wire.status, value))
}
fn headers(json_body: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("application/json"));
    headers.insert(
        "mcp-protocol-version",
        HeaderValue::from_static("2026-07-28"),
    );
    if json_body {
        headers.insert("content-type", HeaderValue::from_static("application/json"));
    }
    headers
}
fn url(value: &str) -> Result<Url, Failure> {
    security::parse_url(value).map_err(|_| Failure::Transient)
}
fn eligible_fallback(status: u16) -> bool {
    (400..500).contains(&status) || status == 502
}
async fn resource_metadata(
    network: &Network,
    server: &Url,
    saved: &Value,
) -> Result<Option<Value>, Failure> {
    let explicit = text(saved, "resourceMetadataUrl");
    let mut target = if let Some(explicit) = explicit {
        url(explicit)?
    } else {
        let path = server.path().trim_end_matches('/');
        server
            .join(&format!("/.well-known/oauth-protected-resource{path}"))
            .map_err(|_| Failure::Transient)?
    };
    if explicit.is_none() {
        target.set_query(server.query());
    }
    let (status, value) = fetch(network, &target, Method::GET, headers(false), None).await?;
    let (status, value) = if explicit.is_none() && server.path() != "/" && eligible_fallback(status)
    {
        fetch(
            network,
            &server
                .join("/.well-known/oauth-protected-resource")
                .map_err(|_| Failure::Transient)?,
            Method::GET,
            headers(false),
            None,
        )
        .await?
    } else {
        (status, value)
    };
    if !(200..300).contains(&status) {
        return Ok(None);
    }
    if text(&value, "resource").is_none() {
        return Err(Failure::Transient);
    }
    Ok(Some(value))
}
async fn discover(network: &Network, authorization: &Url) -> Result<Option<Value>, Failure> {
    let path = authorization.path().trim_end_matches('/');
    let paths = if path.is_empty() {
        vec![
            "/.well-known/oauth-authorization-server".into(),
            "/.well-known/openid-configuration".into(),
        ]
    } else {
        vec![
            format!("/.well-known/oauth-authorization-server{path}"),
            format!("/.well-known/openid-configuration{path}"),
            format!("{path}/.well-known/openid-configuration"),
        ]
    };
    for path in paths {
        let endpoint = authorization.join(&path).map_err(|_| Failure::Transient)?;
        let (status, metadata) =
            fetch(network, &endpoint, Method::GET, headers(false), None).await?;
        if !(200..300).contains(&status) {
            if eligible_fallback(status) {
                continue;
            }
            return Err(Failure::Transient);
        }
        let issuer = text(&metadata, "issuer").ok_or(Failure::Transient)?;
        let expected = authorization.as_str();
        if issuer != expected && expected.strip_suffix('/') != Some(issuer) {
            return Err(Failure::Transient);
        }
        if text(&metadata, "authorization_endpoint").is_none()
            || text(&metadata, "token_endpoint").is_none()
        {
            return Err(Failure::Transient);
        }
        return Ok(Some(metadata));
    }
    Ok(None)
}
fn resource(server: &Url, metadata: Option<&Value>) -> Result<Option<Url>, Failure> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    let configured = url(text(metadata, "resource").ok_or(Failure::Transient)?)?;
    let requested_path = format!("{}/", server.path().trim_end_matches('/'));
    let configured_path = format!("{}/", configured.path().trim_end_matches('/'));
    if configured.origin() != server.origin()
        || server.path().len() < configured.path().len()
        || !requested_path.starts_with(&configured_path)
    {
        return Err(Failure::Transient);
    }
    Ok(Some(configured))
}
fn auth_method(client: &Value, metadata: &Value) -> String {
    let methods = metadata["token_endpoint_auth_methods_supported"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let explicit = text(client, "token_endpoint_auth_method");
    let supported = |method: &str| methods.iter().any(|v| v == method);
    if let Some(explicit) = explicit
        && ["client_secret_basic", "client_secret_post", "none"].contains(&explicit)
        && (methods.is_empty() || supported(explicit))
    {
        return explicit.into();
    }
    let secret = client.get("client_secret").is_some();
    if methods.is_empty() {
        return if secret {
            "client_secret_basic"
        } else {
            "none"
        }
        .into();
    }
    if secret && supported("client_secret_basic") {
        "client_secret_basic"
    } else if secret && supported("client_secret_post") {
        "client_secret_post"
    } else if supported("none") {
        "none"
    } else if secret {
        "client_secret_post"
    } else {
        "none"
    }
    .into()
}
fn apply_auth(
    client: &Value,
    metadata: &Value,
    headers: &mut HeaderMap,
    form: &mut url::form_urlencoded::Serializer<'_, String>,
) -> Result<(), Failure> {
    let id = text(client, "client_id").ok_or(Failure::Transient)?;
    match auth_method(client, metadata).as_str() {
        "client_secret_basic" => {
            let secret = text(client, "client_secret").ok_or(Failure::Transient)?;
            let basic = format!("Basic {}", STANDARD.encode(format!("{id}:{secret}")));
            headers.insert(
                "authorization",
                HeaderValue::from_str(&basic).map_err(|_| Failure::Transient)?,
            );
        }
        "client_secret_post" => {
            form.append_pair("client_id", id);
            if let Some(secret) = text(client, "client_secret") {
                form.append_pair("client_secret", secret);
            }
        }
        _ => {
            form.append_pair("client_id", id);
        }
    }
    Ok(())
}
fn redirect(host: &Host) -> Result<&str, Failure> {
    let uri = url(&host.oauth_redirect_uri)?;
    if uri.path() != "/api/mcp/oauth/callback" || uri.query().is_some() {
        return Err(Failure::Transient);
    }
    if host.deployment_mode == "local_trusted" {
        if uri.scheme() != "http" || uri.host_str() != Some("127.0.0.1") {
            return Err(Failure::Transient);
        }
    } else if uri.scheme() != "https" {
        return Err(Failure::Transient);
    }
    Ok(&host.oauth_redirect_uri)
}
async fn refresh_material(
    access: &Access,
    lease: &d1::RefreshLease,
    host: &Host,
    network: &Network,
    reset_client: bool,
) -> Result<Value, Failure> {
    let server = if let Some(server) = text(&lease.authorization, "serverUrl") {
        url(server)?
    } else {
        security::endpoint(access).map_err(|_| Failure::Transient)?
    };
    let mut material = lease.credential.material.clone();
    let saved = material["discoveryState"].clone();
    let mut resource_meta = saved
        .get("resourceMetadata")
        .filter(|v| v.is_object())
        .cloned();
    let authorization = if let Some(value) = text(&saved, "authorizationServerUrl") {
        url(value)?
    } else {
        resource_meta = resource_metadata(network, &server, &saved).await?;
        resource_meta
            .as_ref()
            .and_then(|v| v["authorization_servers"].as_array())
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .map(url)
            .transpose()?
            .unwrap_or(server.join("/").map_err(|_| Failure::Transient)?)
    };
    let metadata = if saved["authorizationServerMetadata"].is_object() {
        saved["authorizationServerMetadata"].clone()
    } else {
        discover(network, &authorization)
            .await?
            .unwrap_or(Value::Null)
    };
    if resource_meta.is_none() {
        resource_meta = resource_metadata(network, &server, &saved).await?;
    }
    let issuer = text(&metadata, "issuer")
        .unwrap_or(authorization.as_str())
        .to_owned();
    let selected_resource = resource(&server, resource_meta.as_ref())?;
    material["authorizationServerUrl"] = json!(issuer);
    material["discoveryState"] = json!({"authorizationServerUrl":authorization.as_str(),"resourceMetadata":resource_meta,"authorizationServerMetadata":metadata});
    if let Some(metadata_url) = text(&saved, "resourceMetadataUrl") {
        material["discoveryState"]["resourceMetadataUrl"] = json!(metadata_url);
    }
    if let Some(resource) = &selected_resource {
        material["resourceUrl"] = json!(resource.as_str());
    }
    let mut client = material["clientInformation"].clone();
    let mut tokens = material["tokens"].clone();
    if reset_client {
        client = Value::Null;
        tokens = Value::Null;
    }
    if text(&client, "issuer").is_some_and(|stored| !same_issuer(stored, &issuer)) {
        client = Value::Null;
    }
    if text(&tokens, "issuer").is_some_and(|stored| !same_issuer(stored, &issuer)) {
        tokens = Value::Null;
    }
    if !client.is_object() {
        let registration = if metadata.is_object() {
            url(text(&metadata, "registration_endpoint").ok_or(Failure::Transient)?)?
        } else {
            authorization
                .join("/register")
                .map_err(|_| Failure::Transient)?
        };
        let mut registration_body = json!({"client_name":"Rudder","redirect_uris":[redirect(host)?],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":if host.deployment_mode=="local_trusted"{"native"}else{"web"}});
        let scope = text(&lease.authorization, "scope")
            .map(str::to_owned)
            .or_else(|| {
                resource_meta
                    .as_ref()
                    .and_then(|v| v["scopes_supported"].as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
            });
        if let Some(mut scope) = scope {
            if metadata["scopes_supported"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == "offline_access"))
                && !scope.split_whitespace().any(|s| s == "offline_access")
            {
                scope.push_str(" offline_access");
            }
            registration_body["scope"] = json!(scope);
        }
        let (status, registered) = fetch(
            network,
            &registration,
            Method::POST,
            headers(true),
            Some(serde_json::to_vec(&registration_body).map_err(|_| Failure::Transient)?),
        )
        .await?;
        if !(200..300).contains(&status) || text(&registered, "client_id").is_none() {
            return Err(Failure::Transient);
        }
        client = registered;
    }
    client["issuer"] = json!(issuer);
    material["clientInformation"] = client.clone();
    let refresh = text(&tokens, "refresh_token").ok_or(Failure::InvalidGrant)?;
    let endpoint = if let Some(endpoint) = text(&metadata, "token_endpoint") {
        url(endpoint)?
    } else {
        authorization
            .join("/token")
            .map_err(|_| Failure::Transient)?
    };
    if endpoint.scheme() != "https"
        && !matches!(
            endpoint.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    {
        return Err(Failure::Transient);
    }
    let mut request_headers = headers(false);
    request_headers.insert(
        "content-type",
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("grant_type", "refresh_token")
        .append_pair("refresh_token", refresh);
    if let Some(resource) = selected_resource {
        form.append_pair("resource", resource.as_str());
    }
    apply_auth(&client, &metadata, &mut request_headers, &mut form)?;
    let (status, mut refreshed) = fetch(
        network,
        &endpoint,
        Method::POST,
        request_headers,
        Some(form.finish().into_bytes()),
    )
    .await?;
    if !(200..300).contains(&status) || refreshed.get("error").is_some() {
        return Err(match text(&refreshed, "error") {
            Some("invalid_grant") => Failure::InvalidGrant,
            Some("invalid_client" | "unauthorized_client") => Failure::InvalidClient,
            _ => Failure::Transient,
        });
    }
    if text(&refreshed, "access_token").is_none()
        || text(&refreshed, "token_type").is_none()
        || refreshed.get("expires_in").is_some_and(|v| !v.is_number())
    {
        return Err(Failure::Transient);
    }
    if text(&refreshed, "refresh_token").is_none() {
        refreshed["refresh_token"] = json!(refresh);
    }
    refreshed["issuer"] = json!(issuer);
    material["tokens"] = refreshed;
    Ok(material)
}
async fn revoke(material: &Value, network: &Network, timeout: Duration) {
    let Some(endpoint) = text(
        &material["discoveryState"]["authorizationServerMetadata"],
        "revocation_endpoint",
    )
    .and_then(|v| url(v).ok()) else {
        return;
    };
    let tokens = &material["tokens"];
    let token = text(tokens, "refresh_token").or_else(|| text(tokens, "access_token"));
    let Some(token) = token else {
        return;
    };
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("token", token).append_pair(
        "token_type_hint",
        if text(tokens, "refresh_token").is_some() {
            "refresh_token"
        } else {
            "access_token"
        },
    );
    for key in ["client_id", "client_secret"] {
        if let Some(value) = text(&material["clientInformation"], key) {
            form.append_pair(key, value);
        }
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let _ = http::request(
        network,
        &endpoint,
        Method::POST,
        headers,
        Some(form.finish().into_bytes()),
        None,
        timeout,
    )
    .await;
}
pub(super) async fn refresh(
    pool: &PgPool,
    identity: &Identity,
    access: &Access,
    baseline: &OAuthCredential,
    host: &Host,
) -> Result<(), Error> {
    let network = oauth_network(host)?;
    redirect(host).map_err(|_| Error::Runtime("mcp_oauth_refresh_failed"))?;
    let local = host.deployment_mode == "local_trusted";
    let started = Instant::now();
    let lease = loop {
        match d1::claim_refresh(pool, identity, access, baseline, local).await? {
            RefreshClaim::Changed => return Ok(()),
            RefreshClaim::Busy {
                wait_ms,
                timeout_ms,
            } => {
                if started.elapsed() > Duration::from_millis(timeout_ms + 2000) {
                    return Err(Error::Runtime("mcp_oauth_refresh_timeout"));
                }
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            }
            RefreshClaim::Owned(lease) => break lease,
        }
    };
    let refreshed = tokio::time::timeout(Duration::from_millis(lease.timeout_ms), async {
        match refresh_material(access, &lease, host, &network, false).await {
            Err(Failure::InvalidClient) => {
                refresh_material(access, &lease, host, &network, true).await
            }
            result => result,
        }
    })
    .await;
    match refreshed {
        Ok(Ok(material)) => {
            match d1::finish_refresh(pool, &lease, RefreshOutcome::Success(&material), local).await
            {
                Ok(true) => Ok(()),
                outcome => {
                    revoke(&material, &network, Duration::from_millis(lease.timeout_ms)).await;
                    outcome?;
                    Err(Error::Runtime("mcp_oauth_refresh_stale"))
                }
            }
        }
        Ok(Err(Failure::InvalidGrant)) => {
            d1::finish_refresh(pool, &lease, RefreshOutcome::InvalidGrant, local).await?;
            Err(Error::Runtime("mcp_oauth_reauthorization_required"))
        }
        _ => {
            d1::finish_refresh(pool, &lease, RefreshOutcome::Failed, local).await?;
            Err(Error::Runtime("mcp_oauth_refresh_failed"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn client_auth_matches_existing_preference() {
        assert_eq!(
            auth_method(
                &json!({"client_id":"id","client_secret":"secret"}),
                &json!({})
            ),
            "client_secret_basic"
        );
        assert_eq!(
            auth_method(
                &json!({"client_id":"id","client_secret":"secret","token_endpoint_auth_method":"none"}),
                &json!({})
            ),
            "none"
        );
        assert_eq!(
            auth_method(
                &json!({"client_id":"id","client_secret":"secret"}),
                &json!({"token_endpoint_auth_methods_supported":["client_secret_post"]})
            ),
            "client_secret_post"
        );
    }
    #[test]
    fn issuer_isolation_allows_only_single_trailing_slash() {
        assert!(same_issuer("https://a/", "https://a"));
        assert!(!same_issuer("https://a//", "https://a"));
        assert!(!same_issuer("https://a", "https://b"));
    }
    #[test]
    fn resource_path_boundaries_are_enforced() {
        let server = Url::parse("https://example.test/mcp/readonly?read_only=true").unwrap();
        assert!(
            resource(
                &server,
                Some(&json!({"resource":"https://example.test/mcp"}))
            )
            .is_ok()
        );
        assert!(
            resource(
                &server,
                Some(&json!({"resource":"https://example.test/mc"}))
            )
            .is_err()
        );
        assert!(resource(&server, Some(&json!({"resource":"https://other.test/mcp"}))).is_err());
    }
}
