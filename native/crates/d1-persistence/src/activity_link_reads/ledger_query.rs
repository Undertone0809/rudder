//! Fixed per-source ledger queries preserve raw timestamp ordering and source caps.
use super::ledger::{Cursor, Source};
use crate::activity_reads::{legacy_date_text, legacy_stamp};

fn approval_issue(parameter: usize) -> String {
    format!(
        "(p.payload->>'issueId'=${parameter} OR p.payload->>'primaryIssueId'=${parameter} OR p.payload->'issueIds' ? ${parameter})"
    )
}
fn approval_project() -> String {
    "(p.payload->>'projectId'=$6 OR EXISTS(SELECT 1 FROM issues project_issue WHERE project_issue.org_id=p.org_id AND project_issue.project_id=$6::uuid AND project_issue.hidden_at IS NULL AND (project_issue.id::text=p.payload->>'issueId' OR project_issue.id::text=p.payload->>'primaryIssueId' OR p.payload->'issueIds' ? project_issue.id::text)))".into()
}
pub(super) fn query(
    source: Source,
    cursor: Option<&Cursor>,
    all_activity: bool,
    issues: bool,
    approvals: bool,
) -> String {
    let (alias,fields,from,conditions)=match source {
        Source::Chat =>("m",r#"'id',m.id,'orgId',m.org_id,'conversationId',m.conversation_id,'body',m.body,'messageKind',m.kind,'messageStatus',m.status,'runId',m.run_id,
          'replyingAgentId',m.replying_agent_id,'conversationTitle',c.title,'preferredAgentId',c.preferred_agent_id,'routedAgentId',c.routed_agent_id,
          'primaryIssueId',c.primary_issue_id,'issueIdentifier',i.identifier,'issueTitle',i.title,'issueProjectId',i.project_id,'issueGoalId',i.goal_id"#.to_owned(),
          "chat_messages m INNER JOIN chat_conversations c ON m.conversation_id=c.id AND m.org_id=c.org_id LEFT JOIN issues i ON c.primary_issue_id=i.id AND c.org_id=i.org_id AND i.hidden_at IS NULL".to_owned(),
          "m.org_id=$1::uuid AND m.role='user' AND c.org_id=$1::uuid AND c.created_by_user_id=$2 AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=viewer.owner) AND m.superseded_at IS NULL AND ($5::text IS NULL OR m.replying_agent_id=$5::uuid OR c.preferred_agent_id=$5::uuid OR c.routed_agent_id=$5::uuid) AND ($6::text IS NULL OR i.project_id=$6::uuid) AND ($7::text IS NULL OR c.primary_issue_id=$7::uuid)".to_owned()),
        Source::Comment =>("m",r#"'id',m.id,'orgId',m.org_id,'issueId',m.issue_id,'body',m.body,'issueIdentifier',i.identifier,'issueTitle',i.title,
          'issueStatus',i.status,'projectId',i.project_id,'goalId',i.goal_id,'assigneeAgentId',i.assignee_agent_id,'reviewerAgentId',i.reviewer_agent_id"#.to_owned(),
          "issue_comments m INNER JOIN issues i ON m.issue_id=i.id AND m.org_id=i.org_id".to_owned(),
          "m.org_id=$1::uuid AND m.author_user_id=$2 AND i.org_id=$1::uuid AND m.deleted_at IS NULL AND i.hidden_at IS NULL AND ($5::text IS NULL OR i.assignee_agent_id=$5::uuid OR i.reviewer_agent_id=$5::uuid) AND ($6::text IS NULL OR i.project_id=$6::uuid) AND ($7::text IS NULL OR m.issue_id=$7::uuid)".to_owned()),
        Source::Approval =>("m",r#"'id',m.id,'orgId',m.org_id,'approvalId',m.approval_id,'body',m.body,'approvalType',p.type,'approvalStatus',p.status,'requestedByAgentId',p.requested_by_agent_id"#.to_owned(),
          "approval_comments m INNER JOIN approvals p ON m.approval_id=p.id AND m.org_id=p.org_id".to_owned(),
          format!("m.org_id=$1::uuid AND m.author_user_id=$2 AND p.org_id=$1::uuid AND ($5::text IS NULL OR p.requested_by_agent_id=$5::uuid) AND ($6::text IS NULL OR {}) AND ($7::text IS NULL OR {})",approval_project(),approval_issue(7))),
        Source::Activity => {
            let inclusion=if all_activity{"TRUE".to_owned()}else{format!("({} OR {})",if issues{"a.entity_type='issue'"}else{"FALSE"},if approvals{"a.entity_type='approval'"}else{"FALSE"})};
            let low_signal="(a.action='issue.updated' AND jsonb_typeof(a.details)='object' AND (a.details ? 'title' OR a.details ? 'description') AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(a.details) k(key) WHERE k.key NOT IN ('identifier','issueIdentifier','_previous','_references','source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason','title','description')))";
            ("a",r#"'id',a.id,'orgId',a.org_id,'agentId',a.agent_id,'runId',a.run_id,'action',a.action,'entityType',a.entity_type,'entityId',a.entity_id,'details',a.details,
              'issueIdentifier',i.identifier,'issueTitle',i.title,'issueProjectId',i.project_id,'issueGoalId',i.goal_id,'agentName',g.name,'approvalType',p.type,'approvalRequestedByAgentId',p.requested_by_agent_id"#.to_owned(),
              "activity_log a LEFT JOIN issues i ON a.entity_type='issue' AND i.org_id=a.org_id AND a.entity_id=i.id::text AND i.hidden_at IS NULL LEFT JOIN approvals p ON a.entity_type='approval' AND p.org_id=a.org_id AND a.entity_id=p.id::text LEFT JOIN agents g ON a.agent_id=g.id AND a.org_id=g.org_id".to_owned(),
              format!("a.org_id=$1::uuid AND a.actor_type='user' AND a.actor_id=$2 AND (a.entity_type<>'chat' OR EXISTS(SELECT 1 FROM chat_conversations visible_chat WHERE visible_chat.org_id=a.org_id AND visible_chat.id::text=a.entity_id AND (visible_chat.conversation_kind<>'side_chat' OR visible_chat.created_by_user_id=viewer.owner))) AND a.action NOT IN ('issue.comment_added','approval.comment_added','issue.read_marked') AND NOT {low_signal} AND {inclusion} AND ($5::text IS NULL OR a.agent_id=$5::uuid OR (a.actor_type='agent' AND a.actor_id=$5) OR p.requested_by_agent_id=$5::uuid) AND ($6::text IS NULL OR (a.entity_type='project' AND a.entity_id=$6) OR i.project_id=$6::uuid OR (a.entity_type='approval' AND {})) AND ($7::text IS NULL OR (a.entity_type='issue' AND a.entity_id=$7) OR (a.entity_type='approval' AND {}))",approval_project(),approval_issue(7)))
        }
    };
    let mut limit_parameter = 9;
    let cursor_condition = if let Some(cursor) = cursor {
        let order = source.rank().cmp(&cursor.source.rank());
        limit_parameter = 10;
        let mut choices = vec![format!("{alias}.created_at<$9::text::timestamptz")];
        if !order.is_lt() {
            limit_parameter = 11;
            let id = if order.is_eq() {
                limit_parameter = 12;
                format!(" AND {alias}.id::text>$11::text")
            } else {
                String::new()
            };
            choices.push(format!("({alias}.created_at=$10::text::timestamptz{id})"));
        }
        format!("({})", choices.join(" OR "))
    } else {
        "TRUE".into()
    };
    let stamp = legacy_stamp(&format!("{alias}.created_at"));
    let occurred = legacy_date_text("parsed.stamp");
    format!(
        "SELECT jsonb_build_object({fields})::text payload, {occurred} occurred_at, (extract(epoch FROM date_trunc('milliseconds',parsed.stamp))*1000)::bigint millis FROM {from} CROSS JOIN (SELECT $8::text AS owner) viewer CROSS JOIN LATERAL (SELECT {stamp} stamp) parsed WHERE {conditions} AND ($3::text IS NULL OR {alias}.created_at>=$3::timestamptz) AND ($4::text IS NULL OR {alias}.created_at<=$4::timestamptz) AND {cursor_condition} ORDER BY {alias}.created_at DESC,{alias}.id ASC LIMIT ${limit_parameter}"
    )
}
