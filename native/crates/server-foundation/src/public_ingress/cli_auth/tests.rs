use super::*;
use actix_web::test::TestRequest;

#[test]
fn owns_all_six_cli_auth_paths_and_case_trailing_slash_aliases() {
    let cases = [
        ("/api/cli-auth/challenges", Endpoint::Create),
        ("/API/CLI-AUTH/CHALLENGES/", Endpoint::Create),
        (
            "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562",
            Endpoint::Poll,
        ),
        (
            "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562/approve",
            Endpoint::Approve,
        ),
        (
            "/api/cli-auth/challenges/4a884c76-066a-4d80-800f-47c3c41a7562/cancel/",
            Endpoint::Cancel,
        ),
        ("/api/cli-auth/me", Endpoint::Me),
        ("/api/cli-auth/revoke-current/", Endpoint::RevokeCurrent),
    ];
    for (path, endpoint) in cases {
        assert_eq!(endpoint_for_path(path), Some(endpoint), "{path}");
        assert!(reserved_path(path), "{path}");
    }
}

#[test]
fn closes_unknown_cli_auth_paths_and_encoded_aliases_without_proxy_fallback() {
    for path in [
        "/api/cli-auth/unknown",
        "/api/cli-auth/challenges/not-a-uuid",
        "/api/cli-auth/%63hallenges",
        "/api/%63li-auth/challenges",
        "/API/CLI-AUTH/challenges/4a884c76-066a-4d80-800f-47c3c41a7562/other",
    ] {
        assert!(reserved_path(path), "{path} must remain Rust-owned");
    }
    assert_eq!(
        endpoint_for_path("/api/cli-auth/%63hallenges"),
        Some(Endpoint::Create)
    );
    assert_eq!(endpoint_for_path("/api/cli-authentication/me"), None);
}

#[test]
fn get_routes_keep_express_head_behavior() {
    assert!(method_matches(Endpoint::Poll, &Method::HEAD));
    assert!(method_matches(Endpoint::Me, &Method::HEAD));
    assert!(!method_matches(Endpoint::Create, &Method::GET));
    assert!(!method_matches(Endpoint::Approve, &Method::GET));
}

#[test]
fn browser_session_approval_requires_origin_or_referer_from_host() {
    let trusted_origin = TestRequest::post()
        .insert_header((header::HOST, "board.example.test"))
        .insert_header((header::ORIGIN, "https://BOARD.example.test"))
        .to_http_request();
    assert!(is_trusted_browser_mutation(&trusted_origin));

    let trusted_referer = TestRequest::post()
        .insert_header((header::HOST, "127.0.0.1:4321"))
        .insert_header((header::REFERER, "http://127.0.0.1:4321/cli-auth/approve"))
        .to_http_request();
    assert!(is_trusted_browser_mutation(&trusted_referer));

    let untrusted_host_forward = TestRequest::post()
        .insert_header((header::HOST, "internal.invalid"))
        .insert_header((header::ORIGIN, "https://board.example.test"))
        .insert_header(("x-forwarded-host", "board.example.test"))
        .to_http_request();
    assert!(!is_trusted_browser_mutation(&untrusted_host_forward));

    let missing = TestRequest::post()
        .insert_header((header::HOST, "board.example.test"))
        .to_http_request();
    assert!(!is_trusted_browser_mutation(&missing));
}

#[test]
fn raw_secrets_and_command_lengths_match_the_existing_wire_contract() {
    let secret = random_secret("pcp_cli_auth_").expect("secure random source");
    let board_key = random_secret("pcp_board_").expect("secure random source");
    assert!(secret.starts_with("pcp_cli_auth_"));
    assert!(board_key.starts_with("pcp_board_"));
    assert_eq!(secret.len(), "pcp_cli_auth_".len() + 48);
    assert_eq!(board_key.len(), "pcp_board_".len() + 48);
    let secret_suffix = secret.strip_prefix("pcp_cli_auth_").unwrap_or_default();
    let key_suffix = board_key.strip_prefix("pcp_board_").unwrap_or_default();
    assert!(secret_suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(key_suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(utf16_len("a🪿"), 3);
}
