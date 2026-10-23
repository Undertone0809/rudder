//! Forwarding identity is derived from the socket, never implicit loopback trust.
use std::{collections::HashSet, net::IpAddr};

use actix_web::{HttpRequest, http::header::HeaderMap};
use url::{Host, Url};

#[derive(Clone, Default)]
pub(crate) struct ForwardingPolicy {
    trusted_proxies: HashSet<IpAddr>,
}

pub(crate) struct ForwardingIdentity {
    pub client_ip: String,
    pub scheme: &'static str,
}

pub(crate) const FORWARDING_HEADERS: &[&str] = &[
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-original-host",
    "x-real-ip",
    "true-client-ip",
    "cf-connecting-ip",
];

fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    }
}

impl ForwardingPolicy {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        if value.is_empty() {
            return Ok(Self::default());
        }
        if value.len() > 2048 {
            return Err("trusted proxy list is too large");
        }
        let entries: Vec<_> = value.split(',').collect();
        if entries.len() > 32 {
            return Err("too many trusted proxy addresses");
        }
        let mut trusted_proxies = HashSet::new();
        for entry in entries {
            let ip = entry
                .trim()
                .parse::<IpAddr>()
                .map_err(|_| "numeric trusted proxy IP required")?;
            if ip.is_unspecified() || ip.is_multicast() {
                return Err("invalid trusted proxy IP");
            }
            trusted_proxies.insert(normalize_ip(ip));
        }
        Ok(Self { trusted_proxies })
    }

    pub fn identity(&self, request: &HttpRequest) -> Result<ForwardingIdentity, &'static str> {
        let peer = request.peer_addr().ok_or("missing socket peer")?.ip();
        self.resolve_peer(peer, request.headers())
    }

    /// Return the request authority suitable for public links. Forwarded host
    /// is considered only when the socket peer is a configured trusted proxy
    /// and the rest of its forwarding identity is valid.
    pub fn authority(&self, request: &HttpRequest) -> Option<String> {
        let peer = request.peer_addr().map(|peer| normalize_ip(peer.ip()));
        if peer.is_some_and(|peer| self.trusted_proxies.contains(&peer))
            && self.identity(request).is_ok()
        {
            match single_header(request.headers(), "x-forwarded-host") {
                Ok(Some(value)) => return validate_authority(value).ok(),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        request
            .headers()
            .get("host")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| validate_authority(value).ok())
    }

    fn resolve_peer(
        &self,
        peer: IpAddr,
        headers: &HeaderMap,
    ) -> Result<ForwardingIdentity, &'static str> {
        let peer = normalize_ip(peer);
        let mut client = peer;
        let mut scheme = "http"; // This listener is HTTP; TLS is terminated by an explicitly trusted proxy.
        if self.trusted_proxies.contains(&peer) {
            {
                let value = single_header(headers, "x-forwarded-for")?
                    .ok_or("trusted proxy must supply client identity")?;
                if value.len() > 2048 {
                    return Err("forwarded chain is too large");
                }
                let entries: Vec<_> = value.split(',').collect();
                if entries.len() > 32 {
                    return Err("forwarded chain is too long");
                }
                let ips = entries
                    .iter()
                    .map(|entry| {
                        entry
                            .trim()
                            .parse::<IpAddr>()
                            .map(normalize_ip)
                            .map_err(|_| "invalid forwarded IP")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                for ip in ips.into_iter().rev() {
                    client = ip;
                    if !self.trusted_proxies.contains(&ip) {
                        break;
                    }
                }
                if self.trusted_proxies.contains(&client) {
                    return Err("forwarded chain contains no untrusted client");
                }
            }
            {
                let value = single_header(headers, "x-forwarded-proto")?
                    .ok_or("trusted proxy must supply protocol")?;
                scheme = match value {
                    "http" => "http",
                    "https" => "https",
                    _ => return Err("invalid forwarded protocol"),
                };
            }
        }
        Ok(ForwardingIdentity {
            client_ip: client.to_string(),
            scheme,
        })
    }
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, &'static str> {
    let mut values = headers.get_all(name);
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err("duplicate forwarding header");
    }
    value
        .to_str()
        .map(Some)
        .map_err(|_| "invalid forwarding header")
}

fn validate_authority(value: &str) -> Result<String, &'static str> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 512
        || value.chars().any(|ch| {
            ch.is_control()
                || ch.is_whitespace()
                || matches!(ch, ',' | '/' | '\\' | '?' | '#' | '@' | '%')
        })
    {
        return Err("invalid host authority");
    }
    // Use a non-special scheme so `Url::port()` preserves explicitly supplied
    // default HTTP/HTTPS ports; the actual external scheme is chosen separately.
    let url = Url::parse(&format!("rudder://{value}/")).map_err(|_| "invalid host authority")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid host authority");
    }
    let host = match url.host().ok_or("invalid host authority")? {
        Host::Domain(host) => host.to_owned(),
        Host::Ipv4(host) => host.to_string(),
        Host::Ipv6(host) => format!("[{host}]"),
    };
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{
        http::header::{HeaderName, HeaderValue},
        test::TestRequest,
    };

    #[test]
    fn untrusted_peer_cannot_choose_client_identity_or_protocol() {
        let request = TestRequest::default()
            .peer_addr("192.0.2.7:4000".parse().unwrap())
            .insert_header(("x-forwarded-for", "198.51.100.4"))
            .insert_header(("x-forwarded-proto", "https"))
            .to_http_request();
        let identity = ForwardingPolicy::default().identity(&request).unwrap();
        assert_eq!(identity.client_ip, "192.0.2.7");
        assert_eq!(identity.scheme, "http");
    }

    #[test]
    fn trusted_chain_stops_at_nearest_untrusted_hop() {
        let request = TestRequest::default()
            .peer_addr("127.0.0.1:4000".parse().unwrap())
            .insert_header(("x-forwarded-for", "203.0.113.99, 198.51.100.7, 192.0.2.1"))
            .insert_header(("x-forwarded-proto", "https"))
            .to_http_request();
        let identity = ForwardingPolicy::parse("127.0.0.1,192.0.2.1")
            .unwrap()
            .identity(&request)
            .unwrap();
        assert_eq!(identity.client_ip, "198.51.100.7");
        assert_eq!(identity.scheme, "https");
    }

    #[test]
    fn trusted_proxy_can_supply_a_valid_external_authority() {
        let request = TestRequest::default()
            .peer_addr("127.0.0.1:4000".parse().unwrap())
            .insert_header(("host", "private.internal:3100"))
            .insert_header(("x-forwarded-for", "198.51.100.7"))
            .insert_header(("x-forwarded-proto", "https"))
            .insert_header(("x-forwarded-host", "Board.example.test:8443"))
            .to_http_request();
        let policy = ForwardingPolicy::parse("127.0.0.1").unwrap();
        assert_eq!(policy.identity(&request).unwrap().scheme, "https");
        assert_eq!(
            policy.authority(&request).as_deref(),
            Some("board.example.test:8443")
        );

        let default_port = TestRequest::default()
            .peer_addr("127.0.0.1:4000".parse().unwrap())
            .insert_header(("host", "private.internal:3100"))
            .insert_header(("x-forwarded-for", "198.51.100.7"))
            .insert_header(("x-forwarded-proto", "https"))
            .insert_header(("x-forwarded-host", "board.example.test:80"))
            .to_http_request();
        assert_eq!(
            policy.authority(&default_port).as_deref(),
            Some("board.example.test:80")
        );
    }

    #[test]
    fn untrusted_peer_cannot_choose_external_authority() {
        let request = TestRequest::default()
            .peer_addr("192.0.2.7:4000".parse().unwrap())
            .insert_header(("host", "private.internal:3100"))
            .insert_header(("x-forwarded-for", "198.51.100.7"))
            .insert_header(("x-forwarded-proto", "https"))
            .insert_header(("x-forwarded-host", "attacker.example.test"))
            .to_http_request();
        let policy = ForwardingPolicy::parse("127.0.0.1").unwrap();
        assert_eq!(policy.identity(&request).unwrap().scheme, "http");
        assert_eq!(
            policy.authority(&request).as_deref(),
            Some("private.internal:3100")
        );
    }

    #[test]
    fn trusted_forwarded_authority_rejects_ambiguous_or_invalid_values() {
        let policy = ForwardingPolicy::parse("127.0.0.1").unwrap();
        for host in [
            "board.example.test/path",
            "board.example.test,attacker.example.test",
            "user@board.example.test",
            "board.example.test:99999",
            "board.example.test%2f.attacker.test",
        ] {
            let request = TestRequest::default()
                .peer_addr("127.0.0.1:4000".parse().unwrap())
                .insert_header(("host", "private.internal:3100"))
                .insert_header(("x-forwarded-for", "198.51.100.7"))
                .insert_header(("x-forwarded-proto", "https"))
                .insert_header(("x-forwarded-host", host))
                .to_http_request();
            assert_eq!(policy.authority(&request), None, "{host}");
        }
    }

    #[test]
    fn trusted_peer_rejects_ambiguous_headers_and_missing_socket() {
        let policy = ForwardingPolicy::parse("127.0.0.1").unwrap();
        for (name, value) in [
            ("x-forwarded-proto", "https,http"),
            ("x-forwarded-for", "unknown"),
            ("x-forwarded-for", "198.51.100.7:80"),
        ] {
            let request = TestRequest::default()
                .peer_addr("127.0.0.1:4000".parse().unwrap())
                .insert_header((name, value))
                .to_http_request();
            assert!(policy.identity(&request).is_err());
        }
        let mut headers = HeaderMap::new();
        headers.append(
            HeaderName::from_static("x-forwarded-for"),
            HeaderValue::from_static("192.0.2.1"),
        );
        headers.append(
            HeaderName::from_static("x-forwarded-for"),
            HeaderValue::from_static("192.0.2.2"),
        );
        assert!(
            policy
                .resolve_peer("127.0.0.1".parse().unwrap(), &headers)
                .is_err()
        );
        assert!(
            policy
                .identity(&TestRequest::default().to_http_request())
                .is_err()
        );
    }

    #[test]
    fn proxy_configuration_is_explicit_numeric_and_bounded() {
        for value in ["localhost", "0.0.0.0", "::", "127.0.0.1,", "192.0.2.0/24"] {
            assert!(ForwardingPolicy::parse(value).is_err());
        }
        assert!(ForwardingPolicy::parse("::ffff:127.0.0.1").is_ok());
    }

    #[test]
    fn trusted_proxy_requires_bounded_complete_unambiguous_identity() {
        let policy = ForwardingPolicy::parse("127.0.0.1").unwrap();
        for chain in ["", "127.0.0.1", "192.0.2.1,", "192.0.2.1,,198.51.100.1"] {
            let request = TestRequest::default()
                .peer_addr("127.0.0.1:4000".parse().unwrap())
                .insert_header(("x-forwarded-for", chain))
                .insert_header(("x-forwarded-proto", "https"))
                .to_http_request();
            assert!(policy.identity(&request).is_err());
        }
        for chain in [
            std::iter::repeat_n("192.0.2.1", 33)
                .collect::<Vec<_>>()
                .join(","),
            "1".repeat(2049),
        ] {
            let request = TestRequest::default()
                .peer_addr("127.0.0.1:4000".parse().unwrap())
                .insert_header(("x-forwarded-for", chain))
                .insert_header(("x-forwarded-proto", "https"))
                .to_http_request();
            assert!(policy.identity(&request).is_err());
        }
        let request = TestRequest::default()
            .peer_addr("[::ffff:127.0.0.1]:4000".parse().unwrap())
            .insert_header(("x-forwarded-for", "198.51.100.1"))
            .insert_header(("x-forwarded-proto", "https"))
            .to_http_request();
        assert_eq!(policy.identity(&request).unwrap().client_ip, "198.51.100.1");
    }
}
