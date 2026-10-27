use super::{
    Host,
    d1::{Access, Error, OAuthCredential},
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::IpAddr,
    path::PathBuf,
    time::Duration,
};
use url::Url;

pub(super) struct HttpOptions {
    pub url: Url,
    pub headers: HeaderMap,
    pub network: Network,
}
#[derive(Clone)]
pub(super) struct Network {
    pub allowed_origins: BTreeSet<String>,
    pub curated_origin: Option<String>,
}
pub(super) struct Launch {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}
fn failure() -> Error {
    Error::Runtime("mcp_transport_failed")
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str().filter(|s| !s.is_empty())
}
fn sensitive_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let compact = lower.replace(['-', '_'], "");
    [
        "apikey",
        "clientkey",
        "accesstoken",
        "auth",
        "bearer",
        "secret",
        "passwd",
        "password",
        "credential",
        "cookie",
        "jwt",
        "privatekey",
        "connectionstring",
    ]
    .iter()
    .any(|needle| compact.contains(needle))
        || lower
            .split(['-', '_'])
            .any(|part| ["token", "key"].contains(&part))
}
fn map(value: &Value) -> Result<BTreeMap<String, String>, Error> {
    value
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    v.as_str()
                        .map(|v| (k.clone(), v.to_owned()))
                        .ok_or_else(failure)
                })
                .collect()
        })
        .unwrap_or_else(|| Ok(BTreeMap::new()))
}
fn csv(host: &Host, key: &str) -> BTreeSet<String> {
    host.environment
        .get(key)
        .into_iter()
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
pub(super) fn network(host: &Host, curated: Option<String>) -> Result<Network, Error> {
    let mut origins = BTreeSet::new();
    for value in csv(host, "RUDDER_MCP_HTTP_ALLOWLIST") {
        let url = parse_url(&value)?;
        if url.path() != "/" || url.query().is_some() {
            return Err(failure());
        }
        origins.insert(url.origin().ascii_serialization());
    }
    Ok(Network {
        allowed_origins: origins,
        curated_origin: curated,
    })
}
pub(super) fn parse_url(value: &str) -> Result<Url, Error> {
    Url::parse(value)
        .ok()
        .filter(|url| {
            ["http", "https"].contains(&url.scheme())
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && url.host_str().is_some()
        })
        .ok_or_else(failure)
}
pub(super) fn endpoint(access: &Access) -> Result<Url, Error> {
    let url = match access.provider.as_str() {
        "custom" => text(&access.safe_config, "url")
            .ok_or_else(failure)?
            .to_owned(),
        "github" => "https://api.githubcopilot.com/mcp/".into(),
        "linear" => format!(
            "https://mcp.linear.app/mcp{}",
            if access.run_access == "read_only" {
                "/readonly"
            } else {
                ""
            }
        ),
        "notion" => "https://mcp.notion.com/mcp".into(),
        "supabase" => {
            let mut url = parse_url("https://mcp.supabase.com/mcp")?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair(
                    "read_only",
                    if access.run_access == "read_only" {
                        "true"
                    } else {
                        "false"
                    },
                );
                if let Some(scope) = &access.external_scope {
                    query.append_pair("project_ref", scope);
                }
            }
            url.to_string()
        }
        _ => return Err(failure()),
    };
    parse_url(&url)
}
fn header_safe(name: &str, credential: bool) -> bool {
    let name = name.trim().to_ascii_lowercase();
    !name.starts_with("proxy-")
        && name != "forwarded"
        && !name.starts_with("x-forwarded-")
        && (![
            "authorization",
            "connection",
            "content-length",
            "cookie",
            "host",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "x-api-key",
        ]
        .contains(&name.as_str())
            || (credential && ["authorization", "x-api-key"].contains(&name.as_str())))
}
fn headers_into(
    out: &mut HeaderMap,
    source: BTreeMap<String, String>,
    credential: bool,
) -> Result<(), Error> {
    for (name, value) in source {
        if !header_safe(&name, credential) {
            return Err(failure());
        }
        out.insert(
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| failure())?,
            HeaderValue::from_str(&value).map_err(|_| failure())?,
        );
    }
    Ok(())
}
pub(super) fn http_options(
    access: &Access,
    credential: &Value,
    oauth: Option<&OAuthCredential>,
    host: &Host,
) -> Result<HttpOptions, Error> {
    let url = endpoint(access)?;
    let curated = (access.provider != "custom").then(|| url.origin().ascii_serialization());
    let mut headers = HeaderMap::new();
    let mut secret = map(&credential["headers"])?;
    let mut bearer = text(credential, "bearerToken").map(str::to_owned);
    if access.provider == "custom" {
        if map(&access.safe_config["staticHeaders"])?
            .keys()
            .any(|name| sensitive_name(name))
        {
            return Err(failure());
        }
        for name in access.safe_config["secretHeaderNames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !header_safe(name, true) {
                return Err(failure());
            }
        }
        let allowed = csv(host, "RUDDER_MCP_STDIO_ENV_ALLOWLIST");
        for (header, key) in map(&access.safe_config["headersFromEnv"])? {
            if !header_safe(&header, true) || HeaderName::from_bytes(header.as_bytes()).is_err() {
                return Err(failure());
            }
            if host.deployment_mode != "local_trusted" && !allowed.contains(&key) {
                return Err(failure());
            }
            if let Some(value) = host.environment.get(&key) {
                secret.insert(header, value.clone());
            }
        }
        if let Some(key) = text(&access.safe_config, "bearerTokenEnvVar") {
            if host.deployment_mode != "local_trusted" && !allowed.contains(key) {
                return Err(failure());
            }
            bearer = host.environment.get(key).cloned();
        }
        headers_into(
            &mut headers,
            map(&access.safe_config["staticHeaders"])?,
            false,
        )?;
    }
    let auth = text(credential, "authorizationHeader");
    let secret_auth = secret
        .keys()
        .any(|key| key.eq_ignore_ascii_case("authorization"));
    if [
        bearer.is_some(),
        auth.is_some(),
        secret_auth,
        oauth.is_some(),
    ]
    .into_iter()
    .filter(|v| *v)
    .count()
        > 1
    {
        return Err(Error::Runtime("mcp_conflicting_authorization"));
    }
    headers_into(&mut headers, secret, true)?;
    let authorization = if let Some(oauth) = oauth {
        Some(format!(
            "Bearer {}",
            text(&oauth.material["tokens"], "access_token")
                .ok_or(Error::Runtime("mcp_upstream_unauthorized"))?
        ))
    } else if let Some(bearer) = bearer {
        Some(format!("Bearer {bearer}"))
    } else {
        auth.map(str::to_owned)
    };
    if let Some(value) = authorization {
        headers.insert(
            "authorization",
            HeaderValue::from_str(&value).map_err(|_| failure())?,
        );
    }
    if access.provider == "github" && !headers.contains_key("authorization") {
        return Err(Error::Runtime("mcp_credentials_unavailable"));
    }
    Ok(HttpOptions {
        url,
        headers,
        network: network(host, curated)?,
    })
}
pub(super) fn stdio_launch(
    access: &Access,
    credential: &Value,
    host: &Host,
) -> Result<Launch, Error> {
    let config = &access.safe_config;
    if map(&config["staticEnv"])?
        .keys()
        .any(|name| sensitive_name(name))
    {
        return Err(failure());
    }
    let mut executable = text(config, "command").ok_or_else(failure)?.to_owned();
    let args: Vec<String> = config["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or_else(failure))
                .collect()
        })
        .transpose()?
        .unwrap_or_default();
    let mut cwd = text(config, "cwd")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|_| failure())?);
    let mut env = map(&config["staticEnv"])?;
    env.extend(map(&credential["env"])?);
    let forwarded = config["forwardedEnv"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or_else(failure))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let mut names = env
        .keys()
        .cloned()
        .chain(forwarded.iter().cloned())
        .collect::<BTreeSet<_>>();
    names.extend(
        config["secretEnvNames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    if host.deployment_mode != "local_trusted" {
        if !PathBuf::from(&executable).is_absolute()
            || !text(config, "cwd").is_some_and(|s| PathBuf::from(s).is_absolute())
        {
            return Err(failure());
        }
        let resolved = std::fs::canonicalize(&executable).map_err(|_| failure())?;
        cwd = std::fs::canonicalize(cwd).map_err(|_| failure())?;
        let commands: Vec<Vec<String>> = serde_json::from_str(
            host.environment
                .get("RUDDER_MCP_STDIO_COMMAND_ALLOWLIST")
                .map(String::as_str)
                .unwrap_or("[]"),
        )
        .map_err(|_| failure())?;
        if !commands.iter().any(|argv| {
            argv.first().is_some_and(|s| {
                PathBuf::from(s).is_absolute()
                    && std::fs::canonicalize(s).ok().as_ref() == Some(&resolved)
            }) && argv.get(1..) == Some(args.as_slice())
        }) {
            return Err(failure());
        }
        if !csv(host, "RUDDER_MCP_STDIO_CWD_ALLOWLIST").iter().any(|p| {
            PathBuf::from(p).is_absolute() && std::fs::canonicalize(p).ok().as_ref() == Some(&cwd)
        }) {
            return Err(failure());
        }
        if !names.is_subset(&csv(host, "RUDDER_MCP_STDIO_ENV_ALLOWLIST")) {
            return Err(failure());
        }
        executable = resolved.to_string_lossy().into_owned();
    }
    // SDK inherits this explicit platform list, never the full server process environment.
    for key in ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"] {
        if !env.contains_key(key) {
            if host.deployment_mode == "local_trusted" {
                if let Some(value) = host.environment.get(key) {
                    env.insert(key.into(), value.clone());
                }
            } else {
                env.insert(key.into(), String::new());
            }
        }
    }
    for key in forwarded {
        if let Some(value) = host.environment.get(&key) {
            env.insert(key, value.clone());
        }
    }
    if !cwd.is_absolute() {
        cwd = std::env::current_dir().map_err(|_| failure())?.join(cwd);
    }
    if !PathBuf::from(&executable).is_absolute() {
        let candidate = if executable.contains(std::path::MAIN_SEPARATOR) {
            Some(cwd.join(&executable))
        } else {
            env.get("PATH")
                .into_iter()
                .flat_map(|path| std::env::split_paths(path))
                .map(|path| {
                    if path.is_absolute() {
                        path.join(&executable)
                    } else {
                        cwd.join(path).join(&executable)
                    }
                })
                .find(|path| {
                    let Ok(metadata) = std::fs::metadata(path) else {
                        return false;
                    };
                    if !metadata.is_file() {
                        return false;
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        metadata.permissions().mode() & 0o111 != 0
                    }
                    #[cfg(not(unix))]
                    {
                        true
                    }
                })
        };
        executable = candidate
            .ok_or_else(failure)?
            .to_string_lossy()
            .into_owned();
    }
    Ok(Launch {
        executable,
        args,
        cwd,
        env,
    })
}
fn subnet(value: u128, network: u128, bits: u32, width: u32) -> bool {
    let shift = width - bits;
    value >> shift == network >> shift
}
pub(super) fn blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let value = u32::from(ip) as u128;
            [
                ("0.0.0.0", 8),
                ("10.0.0.0", 8),
                ("100.64.0.0", 10),
                ("127.0.0.0", 8),
                ("169.254.0.0", 16),
                ("172.16.0.0", 12),
                ("192.0.0.0", 24),
                ("192.0.2.0", 24),
                ("192.88.99.0", 24),
                ("192.168.0.0", 16),
                ("198.18.0.0", 15),
                ("198.51.100.0", 24),
                ("203.0.113.0", 24),
                ("224.0.0.0", 4),
                ("240.0.0.0", 4),
            ]
            .iter()
            .any(|(n, b)| {
                subnet(
                    value,
                    u32::from(n.parse::<std::net::Ipv4Addr>().unwrap()) as u128,
                    *b,
                    32,
                )
            })
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return blocked(IpAddr::V4(v4));
            }
            let value = u128::from(ip);
            if !subnet(
                value,
                u128::from("2000::".parse::<std::net::Ipv6Addr>().unwrap()),
                3,
                128,
            ) {
                return true;
            }
            [
                ("2001::", 23),
                ("2001:2::", 48),
                ("2001:db8::", 32),
                ("2002::", 16),
                ("2620:4f:8000::", 48),
                ("3fff::", 20),
            ]
            .iter()
            .any(|(n, b)| {
                subnet(
                    value,
                    u128::from(n.parse::<std::net::Ipv6Addr>().unwrap()),
                    *b,
                    128,
                )
            })
        }
    }
}
pub(super) async fn pinned(url: &Url, network: &Network) -> Result<std::net::SocketAddr, Error> {
    let origin = url.origin().ascii_serialization();
    if network
        .curated_origin
        .as_ref()
        .is_some_and(|allowed| allowed != &origin)
    {
        return Err(failure());
    }
    let allowed = network.allowed_origins.contains(&origin);
    if url.scheme() != "https" && !allowed {
        return Err(failure());
    }
    let hostname = url.host_str().ok_or_else(failure)?.trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or_else(failure)?;
    let addresses = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((hostname, port)),
    )
    .await
    .map_err(|_| failure())?
    .map_err(|_| failure())?
    .collect::<Vec<_>>();
    if addresses.is_empty()
        || (!allowed
            && network.curated_origin.is_none()
            && addresses.iter().any(|a| blocked(a.ip())))
    {
        return Err(failure());
    }
    Ok(addresses[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_special_networks() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "::1",
            "::ffff:127.0.0.1",
            "2001:db8::1",
            "3fff::1",
            "64:ff9b::8.8.8.8",
        ] {
            assert!(blocked(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(!blocked(ip.parse().unwrap()), "{ip}");
        }
    }
    #[test]
    fn headers_cannot_override_host() {
        assert!(!header_safe("Host", true));
        assert!(!header_safe("X-Forwarded-For", false));
        assert!(!header_safe("Authorization", false));
        assert!(header_safe("Authorization", true));
        assert!(header_safe("X-Api-Key", true));
    }
}
