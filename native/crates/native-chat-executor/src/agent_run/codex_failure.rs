//! Exact Agent Codex provider-auth classifier from codex-local/server/parse.ts.
//! Tool/MCP/CLI-login 401s do not qualify as a provider readiness failure.
pub(super) fn provider_auth_failure(evidence: &str) -> Option<String> {
    let status = regex::Regex::new(r"(?i)\b(?:status\s+)?401\b|\b401\s+Unauthorized\b").unwrap();
    let reason=regex::Regex::new(r"(?i)\b(?:API_KEY_REQUIRED|INVALID_API_KEY|AUTHENTICATION_REQUIRED|UNAUTHORIZED|invalid\s+(?:api[-_ ]?key|credential)|api[-_ ]?key\s+(?:is\s+)?required|authentication\s+(?:failed|required)|credential\s+(?:rejected|required))\b").unwrap();
    let event =
        regex::Regex::new(r#"(?i)\bunexpected\s+status\s+401\b|https://[^\s)"']+/v1/responses\b"#)
            .unwrap();
    evidence
        .lines()
        .map(str::trim)
        .find(|line| event.is_match(line) && status.is_match(line) && reason.is_match(line))
        .map(str::to_owned)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_actual_provider_401_evidence_triggers_the_hard_stop() {
        assert!(provider_auth_failure("unexpected status 401 Unauthorized: INVALID_API_KEY https://provider.invalid/v1/responses").is_some());
        for line in [
            "MCP server replied401 Unauthorized",
            "CLI login required",
            "https://provider.invalid/v1/responses 503 provider error",
            "https://provider.invalid/v1/responses 401",
        ] {
            assert!(provider_auth_failure(line).is_none(), "{line}");
        }
    }
}
