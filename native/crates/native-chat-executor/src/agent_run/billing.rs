//! Billing metadata and opt-in Codex subscription estimation, preserving the
//! pinned Agent adapter source prices rather than silently changing pricing.
use serde_json::{Value, json};
use std::collections::BTreeMap;
fn present(env: &BTreeMap<String, String>, key: &str) -> bool {
    env.get(key).is_some_and(|value| !value.trim().is_empty())
}
fn openrouter(env: &BTreeMap<String, String>) -> bool {
    present(env, "OPENROUTER_API_KEY")
        || ["OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_BASE_URL"]
            .iter()
            .find_map(|key| {
                env.get(*key)
                    .map(String::as_str)
                    .filter(|value| !value.trim().is_empty())
            })
            .is_some_and(|value| value.to_ascii_lowercase().contains("openrouter.ai"))
}
pub(super) fn provider_from_model(model: &str) -> Option<&str> {
    if let Some((provider, _)) = model.split_once('/') {
        return (!provider.trim().is_empty()).then_some(provider.trim());
    }
    let lower = model.to_ascii_lowercase();
    if lower.contains("sonnet") || lower.contains("claude") {
        Some("anthropic")
    } else if lower.starts_with("gpt") || lower.starts_with('o') {
        Some("openai")
    } else {
        None
    }
}
pub(super) fn apply(
    runtime: &str,
    config: &Value,
    env: &BTreeMap<String, String>,
    model: &str,
    provider: &str,
    usage: &mut Value,
    result: &mut Value,
) {
    if !usage.is_object() {
        return;
    }
    let subscription = match runtime {
        "claude_local" => !present(env, "ANTHROPIC_API_KEY"),
        "codex_local" => !present(env, "OPENAI_API_KEY"),
        "cursor" => !present(env, "CURSOR_API_KEY") && !present(env, "OPENAI_API_KEY"),
        _ => false,
    };
    let biller = match runtime {
        "claude_local" => "anthropic",
        "codex_local" if openrouter(env) => "openrouter",
        "codex_local" if subscription => "chatgpt",
        "codex_local" => "openai",
        "cursor" if openrouter(env) => "openrouter",
        "cursor" if subscription => "cursor",
        "opencode_local" | "pi_local" if openrouter(env) => "openrouter",
        _ => {
            if provider.is_empty() {
                "unknown"
            } else {
                provider
            }
        }
    };
    result["biller"] = json!(biller);
    usage["biller"] = json!(biller);
    if matches!(runtime, "claude_local" | "codex_local" | "cursor") {
        usage["billingType"] = json!(if subscription {
            "subscription_included"
        } else {
            "metered_api"
        });
    }
    if runtime == "codex_local" && subscription && config["countSubscriptionUsageAsCost"] != false {
        let input = usage["inputTokens"].as_i64().unwrap_or_default().max(0) as f64;
        let cached = (usage["cachedInputTokens"]
            .as_i64()
            .unwrap_or_default()
            .max(0) as f64)
            .min(input);
        let output = usage["outputTokens"].as_i64().unwrap_or_default().max(0) as f64;
        if let Some((read, cache, write)) = codex_price(model) {
            let cost = ((input - cached) * read + cached * cache + output * write) / 1_000_000.0;
            if cost > 0.0 {
                usage["costUsd"] = json!(cost);
                usage["billingType"] = json!("metered_api");
            }
        }
    }
}
fn codex_price(model: &str) -> Option<(f64, f64, f64)> {
    let normalized = model.trim().to_ascii_lowercase();
    let normalized = normalized.strip_prefix("openai/").unwrap_or(&normalized);
    Some(match normalized {
        "codex-mini-latest" => (1.5, 0.375, 6.0),
        "gpt-3.5-turbo" => (0.5, 0.5, 1.5),
        "gpt-4" => (30.0, 30.0, 60.0),
        "gpt-4-turbo" => (10.0, 10.0, 30.0),
        "gpt-4.1" => (2.0, 0.5, 8.0),
        "gpt-4.1-mini" => (0.4, 0.1, 1.6),
        "gpt-4.1-nano" => (0.1, 0.025, 0.4),
        "gpt-4o" => (2.5, 1.25, 10.0),
        "gpt-4o-mini" => (0.15, 0.075, 0.6),
        "gpt-5" => (1.25, 0.125, 10.0),
        "gpt-5-codex" => (1.25, 0.125, 10.0),
        "gpt-5-mini" => (0.25, 0.025, 2.0),
        "gpt-5-nano" => (0.05, 0.005, 0.4),
        "gpt-5.1" => (1.25, 0.125, 10.0),
        "gpt-5.1-codex" => (1.25, 0.125, 10.0),
        "gpt-5.1-codex-max" => (1.25, 0.125, 10.0),
        "gpt-5.1-codex-mini" => (0.25, 0.025, 2.0),
        "gpt-5.2" => (1.75, 0.175, 14.0),
        "gpt-5.2-codex" => (1.75, 0.175, 14.0),
        "gpt-5.3-codex" => (1.75, 0.175, 14.0),
        "gpt-5.3-codex-spark" => (1.75, 0.175, 14.0),
        "gpt-5.4" => (2.5, 0.25, 15.0),
        "gpt-5.4-codex" => (2.5, 0.25, 15.0),
        "gpt-5.4-mini" => (0.75, 0.075, 4.5),
        "gpt-5.4-nano" => (0.2, 0.02, 1.25),
        "gpt-5.4-pro" => (30.0, 30.0, 180.0),
        "gpt-5.5" => (5.0, 0.5, 30.0),
        "gpt-5.5-codex" => (2.5, 0.25, 15.0),
        "gpt-5.5-fast" => (12.5, 1.25, 75.0),
        "gpt-5.5-flex" => (2.5, 0.25, 15.0),
        "gpt-5.5-pro" => (30.0, 30.0, 180.0),
        "o1" => (15.0, 7.5, 60.0),
        "o1-mini" => (1.1, 0.55, 4.4),
        "o1-preview" => (15.0, 7.5, 60.0),
        "o3" => (2.0, 0.5, 8.0),
        "o3-mini" => (1.1, 0.55, 4.4),
        "o3-pro" => (20.0, 20.0, 80.0),
        "o4-mini" => (1.1, 0.275, 4.4),
        _ => return None,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subscription_estimate_uses_same_pinned_price_and_cache_formula_as_node() {
        let mut usage = json!({"inputTokens":1000,"cachedInputTokens":200,"outputTokens":100});
        let mut result = json!({});
        apply(
            "codex_local",
            &json!({}),
            &BTreeMap::new(),
            "openai/gpt-5.4",
            "openai",
            &mut usage,
            &mut result,
        );
        assert!((usage["costUsd"].as_f64().unwrap() - 0.00355).abs() < 0.0000001);
        assert_eq!(usage["billingType"], "metered_api");
        assert_eq!(result["biller"], "chatgpt");
    }
    #[test]
    fn explicit_subscription_opt_out_keeps_included_billing_and_openrouter_biller() {
        let mut usage = json!({"inputTokens":1000,"cachedInputTokens":200,"outputTokens":100});
        let mut result = json!({});
        apply(
            "codex_local",
            &json!({"countSubscriptionUsageAsCost":false}),
            &BTreeMap::from([(
                "OPENAI_BASE_URL".into(),
                "https://openrouter.ai/api/v1".into(),
            )]),
            "gpt-5.4",
            "openai",
            &mut usage,
            &mut result,
        );
        assert_eq!(usage["billingType"], "subscription_included");
        assert_eq!(result["biller"], "openrouter");
        assert!(usage.get("costUsd").is_none());
    }
}
