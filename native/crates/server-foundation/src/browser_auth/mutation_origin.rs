//! Browser mutation origins come from immutable startup configuration, never
//! the request Host or forwarding headers. Apply after credential verification
//! and before entering a product mutation transaction.
use super::{BrowserActor, BrowserAuthError};
use actix_web::{HttpRequest, http::header};
use std::collections::BTreeSet;
use url::Url;

#[derive(Clone)]
pub struct BrowserMutationPolicy {
    trusted_origins: BTreeSet<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("browser mutation policy requires explicit HTTP or HTTPS origins")]
pub struct BrowserMutationPolicyError;

impl BrowserMutationPolicy {
    /// Origin-only entries; wildcards, credentials, paths, queries and
    /// fragments are configuration errors. An empty list fails closed for
    /// session and local-implicit actors, while explicit bearer actors remain
    /// usable. Loopback binding alone does not prevent cross-origin requests.
    pub fn new(origins: &[String]) -> Result<Self, BrowserMutationPolicyError> {
        if origins.len() > 64 {
            return Err(BrowserMutationPolicyError);
        }
        let trusted_origins = origins
            .iter()
            .map(|value| parse_origin(value, false).ok_or(BrowserMutationPolicyError))
            .collect::<Result<_, _>>()?;
        Ok(Self { trusted_origins })
    }

    pub fn authorize(
        &self,
        actor: &BrowserActor,
        request: &HttpRequest,
    ) -> Result<(), BrowserAuthError> {
        // This source was minted by authenticate(), not deserialized from
        // the request. A header that merely looks like Bearer is insufficient.
        match actor.source() {
            "board_key" => return Ok(()),
            "session" | "local_implicit" => {}
            _ => return Err(BrowserAuthError::Forbidden),
        }
        let origin = one_header(request, header::ORIGIN)?;
        let referer = one_header(request, header::REFERER)?;
        let parsed = match origin {
            // A present but invalid/foreign Origin cannot be rescued by a
            // trusted Referer, Host or forwarded-host value.
            Some(value) => parse_origin(value, false),
            None => referer.and_then(|value| parse_origin(value, true)),
        };
        if parsed.is_some_and(|origin| self.trusted_origins.contains(&origin)) {
            Ok(())
        } else {
            Err(BrowserAuthError::Forbidden)
        }
    }
}

fn one_header(
    request: &HttpRequest,
    name: header::HeaderName,
) -> Result<Option<&str>, BrowserAuthError> {
    let mut values = request.headers().get_all(name);
    let first = values.next();
    if values.next().is_some() {
        return Err(BrowserAuthError::Forbidden);
    }
    first
        .map(|value| value.to_str().map_err(|_| BrowserAuthError::Forbidden))
        .transpose()
}

fn parse_origin(value: &str, allow_path: bool) -> Option<String> {
    if value.is_empty()
        || value.len() > 8192
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || value.contains('\\')
    {
        return None;
    }
    let (scheme, remainder) = value.split_once("://")?;
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        || remainder.starts_with('/')
        || remainder.split(['/', '?', '#']).next()?.contains('@')
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(|host| host.contains('*'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (!allow_path && (url.path() != "/" || url.query().is_some()))
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    fn actor(source: &'static str) -> BrowserActor {
        BrowserActor {
            user_id: "fixture-user".into(),
            session_id: "fixture-session".into(),
            source,
            credential: super::super::AuthenticatedBrowserCredential::LocalImplicit,
        }
    }

    fn policy() -> BrowserMutationPolicy {
        BrowserMutationPolicy::new(&[
            "https://chat.example.test".into(),
            "http://127.0.0.1:3100".into(),
        ])
        .unwrap()
    }

    #[test]
    fn validates_explicit_config_and_normalizes_default_ports() {
        for bad in [
            "*",
            "null",
            "file:///tmp/chat",
            "https://*.example.test",
            "https://user@chat.example.test",
            "https://chat.example.test/path",
            "https://chat.example.test?query",
            "https://chat.example.test#fragment",
            " https://chat.example.test",
            "https://chat.example.test\\evil",
        ] {
            assert!(BrowserMutationPolicy::new(&[bad.into()]).is_err(), "{bad}");
        }
        let request = TestRequest::post()
            .insert_header((header::ORIGIN, "https://CHAT.example.test:443"))
            .to_http_request();
        assert!(policy().authorize(&actor("session"), &request).is_ok());
    }

    #[test]
    fn requires_explicit_trust_and_does_not_use_host_headers() {
        for origin in [
            "null",
            "https://evil.test",
            "https://chat.example.test.evil.test",
            "http://chat.example.test",
            "https://chat.example.test:444",
            "https://chat.example.test/path",
        ] {
            let request = TestRequest::post()
                .insert_header((header::ORIGIN, origin))
                .insert_header((header::REFERER, "https://chat.example.test/chat/1"))
                .insert_header((header::HOST, "chat.example.test"))
                .insert_header(("x-forwarded-host", "chat.example.test"))
                .to_http_request();
            assert!(
                policy().authorize(&actor("session"), &request).is_err(),
                "{origin}"
            );
        }
        let missing = TestRequest::post()
            .insert_header((header::HOST, "chat.example.test"))
            .to_http_request();
        assert!(policy().authorize(&actor("session"), &missing).is_err());
        let no_policy = BrowserMutationPolicy::new(&[]).unwrap();
        let request = TestRequest::post()
            .insert_header((header::ORIGIN, "https://chat.example.test"))
            .to_http_request();
        assert!(no_policy.authorize(&actor("session"), &request).is_err());
    }

    #[test]
    fn referer_is_only_a_fallback_for_an_absent_origin() {
        let request = TestRequest::post()
            .insert_header((header::REFERER, "https://chat.example.test/chat/1?q=test"))
            .to_http_request();
        assert!(policy().authorize(&actor("session"), &request).is_ok());
        let request = TestRequest::post()
            .insert_header((header::ORIGIN, ""))
            .insert_header((header::REFERER, "https://chat.example.test/chat/1"))
            .to_http_request();
        assert!(policy().authorize(&actor("session"), &request).is_err());
        let request = TestRequest::post()
            .append_header((header::ORIGIN, "https://chat.example.test"))
            .append_header((header::ORIGIN, "https://chat.example.test"))
            .to_http_request();
        assert!(policy().authorize(&actor("session"), &request).is_err());
        let request = TestRequest::post()
            .append_header((header::REFERER, "https://chat.example.test"))
            .append_header((header::REFERER, "https://chat.example.test"))
            .to_http_request();
        assert!(policy().authorize(&actor("session"), &request).is_err());
    }

    #[test]
    fn source_exemptions_require_an_authenticated_actor() {
        let request = TestRequest::post()
            .insert_header((header::AUTHORIZATION, "Bearer unverified"))
            .to_http_request();
        assert!(policy().authorize(&actor("session"), &request).is_err());
        assert!(policy().authorize(&actor("untrusted"), &request).is_err());
        assert!(
            policy()
                .authorize(&actor("local_implicit"), &request)
                .is_err()
        );
        assert!(policy().authorize(&actor("board_key"), &request).is_ok());
        let local_request = TestRequest::post()
            .insert_header((header::ORIGIN, "http://127.0.0.1:3100"))
            .to_http_request();
        assert!(
            policy()
                .authorize(&actor("local_implicit"), &local_request)
                .is_ok()
        );
    }
}
