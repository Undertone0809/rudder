//! Shared SQL authorization policy for Run-derived public projections.
//! Owner identity is supplied by a verified actor, never by request JSON.
//! Chat-origin orphans fail closed because legacy SideChat creation did not
//! persist an unambiguous private marker. Historical rows remain intact.

/// Build an owner-bound predicate for a trusted, compile-time Run table alias.
pub fn predicate(run_alias: &str, owner_parameter: usize) -> String {
    assert!(
        !run_alias.is_empty()
            && run_alias
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    );
    assert_ne!(run_alias, "visibility_chat");
    assert!(owner_parameter > 0);
    let owner = format!("${owner_parameter}::text");
    let marker = "coalesce((r.scene = 'side_chat' OR r.context_snapshot->>'scene' = 'side_chat' OR r.context_snapshot->>'rudderScene' = 'side_chat' OR r.context_snapshot->'unifiedAgentRun'->>'scene' = 'side_chat' OR (r.chat_conversation_id IS NULL AND (r.scene = 'chat' OR r.context_snapshot->>'scene' = 'chat' OR r.context_snapshot->>'rudderScene' = 'chat' OR r.context_snapshot->'unifiedAgentRun'->>'scene' = 'chat'))), false)";
    let visibility = format!(
        "(({marker}) AND EXISTS (SELECT 1 FROM chat_conversations visibility_chat WHERE visibility_chat.id=r.chat_conversation_id AND visibility_chat.org_id=r.org_id AND visibility_chat.conversation_kind='side_chat' AND visibility_chat.created_by_user_id={owner})) OR (NOT ({marker}) AND (r.chat_conversation_id IS NULL OR EXISTS (SELECT 1 FROM chat_conversations visibility_chat WHERE visibility_chat.id=r.chat_conversation_id AND visibility_chat.org_id=r.org_id AND (visibility_chat.conversation_kind<>'side_chat' OR visibility_chat.created_by_user_id={owner}))))"
    );
    format!("({})", visibility.replace("r.", &format!("{run_alias}.")))
}

pub fn scoped_query(sql: &str, owner_parameter: usize) -> String {
    let visibility = predicate("r", owner_parameter);
    let visible = format!(
        "visible_runs AS NOT MATERIALIZED (SELECT r.* FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND ({visibility}))"
    );
    // All input SQL is a compile-time authority query. Rewrite its run sources
    // consistently, including overview subqueries, before limits/aggregations.
    let sql = sql
        .trim_start()
        .replace("heartbeat_runs r", "visible_runs r");
    match sql.strip_prefix("WITH ") {
        Some(rest) => format!("WITH {visible}, {rest}"),
        None => format!("WITH {visible} {sql}"),
    }
}

/// An unbound cleanup log cannot be attributed safely when its workspace was
/// also used by an inaccessible Run. Fail closed instead of revealing it via
/// a different visible Run sharing that workspace. No historical data is lost.
pub fn unbound_workspace_visible(operation_alias: &str) -> String {
    let trim = "'{}- ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)";
    format!(
        "NOT EXISTS (SELECT 1 FROM heartbeat_runs hidden WHERE hidden.org_id=$1::uuid AND translate(lower(hidden.context_snapshot->>'executionWorkspaceId'), {trim}, '')=replace({operation_alias}.execution_workspace_id::text, '-', '') AND NOT EXISTS(SELECT 1 FROM visible_runs admitted WHERE admitted.id=hidden.id))"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_applies_to_nested_run_selection_before_limits() {
        let sql = scoped_query(
            "SELECT r.id FROM heartbeat_runs r INNER JOIN (SELECT r.id FROM heartbeat_runs r LIMIT 1) nested ON nested.id=r.id",
            2,
        );
        assert_eq!(sql.matches("FROM heartbeat_runs r").count(), 1);
        assert_eq!(sql.matches("FROM visible_runs r").count(), 2);
        assert!(sql.contains("visibility_chat.created_by_user_id=$2::text"));
        assert!(sql.contains("visibility_chat.org_id=r.org_id"));
        assert!(sql.contains("r.context_snapshot->'unifiedAgentRun'->>'scene'"));
    }
    #[test]
    fn predicate_supports_other_trusted_aliases() {
        let sql = predicate("hr", 7);
        assert!(sql.starts_with('(') && sql.ends_with(')'));
        assert!(sql.contains("visibility_chat.org_id=hr.org_id"));
        assert!(sql.contains("visibility_chat.created_by_user_id=$7::text"));
        assert!(!sql.contains("=r."));
    }
    #[test]
    fn existing_cte_is_extended_instead_of_nested_invalid_with() {
        let sql = scoped_query(
            "WITH live AS (SELECT r.id FROM heartbeat_runs r) SELECT * FROM live",
            4,
        );
        assert!(sql.contains("), live AS ("));
        assert_eq!(sql.matches("WITH ").count(), 1);
    }
}
