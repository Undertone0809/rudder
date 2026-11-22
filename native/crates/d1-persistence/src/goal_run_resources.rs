//! Context used by the existing Goal-started runtime prompt.
//!
//! This mirrors the data selected by `agent-run-context.ts` and
//! `agent-startup-context.ts`. Its only filesystem writes are the same empty
//! daily-memory files that the legacy context builder ensures.

use crate::{StoreError, transaction};
use sqlx::{PgPool, Row};
use std::{fs, path::Path};
use time::{Duration, OffsetDateTime};

const RECENT_CONTEXT_LIMIT: usize = 12_000;
const MEMORY_FILE_LIMIT: usize = 2_000;
const ISSUE_SNIPPET_LIMIT: usize = 360;
const CHAT_SNIPPET_LIMIT: usize = 360;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoalStartedResources {
    /// The `rudderWorkspace.orgResourcesPrompt` value passed to the Goal prompt.
    pub org_resources_prompt: String,
    /// The same startup context bundle exposed in the nested Node prompt map.
    pub startup_context: serde_json::Value,
}

#[derive(Clone, Debug)]
struct Automation {
    id: String,
    title: String,
    output_mode: String,
    last_triggered_at: Option<String>,
    triggers: Vec<Trigger>,
}

#[derive(Clone, Debug)]
struct Trigger {
    kind: String,
    label: Option<String>,
    enabled: bool,
    next_run_at: Option<String>,
    last_fired_at: Option<String>,
}

#[derive(Clone, Debug)]
struct IntegrationTool {
    integration_name: String,
    kind: String,
    scope: String,
    tool_name: String,
    external_tool_name: String,
    description: Option<String>,
}

#[derive(Clone, Debug)]
struct RecentIssue {
    id: String,
    identifier: Option<String>,
    status: String,
    role: String,
    assignee: Option<String>,
    reviewer: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    title: String,
    summary: Option<String>,
}

#[derive(Clone, Debug)]
struct RecentChat {
    id: String,
    activity_at: Option<String>,
    title: String,
    summary: Option<String>,
}

#[derive(Clone, Debug)]
struct OrganizationMember {
    name: String,
    kind: String,
    role: String,
    reference: String,
}

#[derive(Clone, Debug)]
struct DailyMemory {
    date_key: String,
    relative_path: String,
    content: String,
    error: Option<String>,
}

/// Read the same Agent-scoped information the Node run-context builder puts
/// into `orgResourcesPrompt`. Goal has no project binding, so its project
/// attachment section is empty just as it is in the current Node workflow.
pub async fn load_goal_started_resources(
    pool: &PgPool,
    organization_id: &str,
    agent_id: &str,
    memory_dir: &Path,
) -> Result<GoalStartedResources, StoreError> {
    load_agent_startup_resources(
        pool,
        organization_id,
        agent_id,
        memory_dir,
        &serde_json::json!({}),
    )
    .await
}

/// Existing startup projection with current Issue/project-linked Chat scope.
/// The Goal wrapper supplies empty scope and preserves its original query.
pub async fn load_agent_startup_resources(
    pool: &PgPool,
    organization_id: &str,
    agent_id: &str,
    memory_dir: &Path,
    context: &serde_json::Value,
) -> Result<GoalStartedResources, StoreError> {
    let org = organization_id.to_ascii_lowercase();
    let agent = agent_id.to_ascii_lowercase();
    transaction::uuid(&org)?;
    transaction::uuid(&agent)?;

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(&org)
    .bind(&agent)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(StoreError::NotFound);
    }

    let automations = load_automations(&mut tx, &org, &agent).await?;
    let integration_tools = load_integration_tools(&mut tx, &org, &agent).await?;
    let issues = load_recent_issues(&mut tx, &org, &agent, context).await?;
    let chats = load_recent_chats(&mut tx, &org, &agent, context).await?;
    let (member_total, members) = load_organization_members(&mut tx, &org).await?;
    tx.commit().await?;

    let prompt = build_org_resources_prompt(&integration_tools, &automations);
    let today = OffsetDateTime::now_utc().date();
    let today_memory = read_daily_memory(memory_dir, today);
    let yesterday_memory = read_daily_memory(memory_dir, today - Duration::days(1));
    let recent_context = build_recent_context(
        today,
        today_memory.content.clone(),
        yesterday_memory.content.clone(),
        &issues,
        &chats,
        member_total,
        &members,
    );
    let startup_context = build_startup_context_value(
        &recent_context,
        &today_memory,
        &yesterday_memory,
        &issues,
        &chats,
        issues.len().saturating_sub(10),
        chats.len().saturating_sub(10),
    );
    let org_resources_prompt = join_sections([prompt.as_str(), recent_context.as_str()]);
    Ok(GoalStartedResources {
        org_resources_prompt,
        startup_context,
    })
}

async fn load_automations(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    agent: &str,
) -> Result<Vec<Automation>, StoreError> {
    let rows = sqlx::query(
        "SELECT id::text AS id,title,output_mode,
           to_char(last_triggered_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS last_triggered_at
         FROM automations
         WHERE org_id=$1::uuid AND assignee_agent_id=$2::uuid AND status<>'archived'
         ORDER BY title ASC,id ASC",
    )
    .bind(org)
    .bind(agent)
    .fetch_all(&mut **tx)
    .await?;
    let mut automations = rows
        .into_iter()
        .map(|row| {
            Ok(Automation {
                id: row.try_get("id")?,
                title: row.try_get("title")?,
                output_mode: row.try_get("output_mode")?,
                last_triggered_at: row.try_get("last_triggered_at")?,
                triggers: Vec::new(),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    if automations.is_empty() {
        return Ok(automations);
    }
    let ids = automations
        .iter()
        .map(|automation| automation.id.clone())
        .collect::<Vec<_>>();
    let triggers = sqlx::query(
        "SELECT automation_id::text AS automation_id,kind,label,enabled,
           to_char(next_run_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS next_run_at,
           to_char(last_fired_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS last_fired_at
         FROM automation_triggers
         WHERE org_id=$1::uuid AND automation_id=ANY($2::text[]::uuid[])
         ORDER BY created_at ASC,id ASC",
    )
    .bind(org)
    .bind(ids)
    .fetch_all(&mut **tx)
    .await?;
    for row in triggers {
        let owner: String = row.try_get("automation_id")?;
        if let Some(automation) = automations.iter_mut().find(|item| item.id == owner) {
            automation.triggers.push(Trigger {
                kind: row.try_get("kind")?,
                label: row.try_get("label")?,
                enabled: row.try_get("enabled")?,
                next_run_at: row.try_get("next_run_at")?,
                last_fired_at: row.try_get("last_fired_at")?,
            });
        }
    }
    Ok(automations)
}

async fn load_integration_tools(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    agent: &str,
) -> Result<Vec<IntegrationTool>, StoreError> {
    // Match `listRuntimeToolsForAgent`: only active integrations, active
    // bindings, and enabled active tools are presented. Credential fields are
    // deliberately not selected.
    let rows = sqlx::query(
        "SELECT i.display_name AS integration_name,i.kind,i.scope,
           t.rudder_tool_name AS tool_name,t.external_tool_name,t.description
         FROM agent_custom_integration_bindings b
         JOIN custom_integrations i ON i.id=b.integration_id AND i.org_id=b.org_id
         JOIN custom_integration_tools t ON t.integration_id=i.id AND t.org_id=i.org_id
         WHERE b.org_id=$1::uuid AND b.agent_id=$2::uuid
           AND i.status='active' AND b.status='active'
           AND t.status='active' AND t.enabled=true
           AND b.enabled_tool_ids ? t.id::text
         ORDER BY b.updated_at DESC,t.created_at ASC,t.id ASC",
    )
    .bind(org)
    .bind(agent)
    .fetch_all(&mut **tx)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(IntegrationTool {
                integration_name: row.try_get("integration_name")?,
                kind: row.try_get("kind")?,
                scope: row.try_get("scope")?,
                tool_name: row.try_get("tool_name")?,
                external_tool_name: row.try_get("external_tool_name")?,
                description: row.try_get("description")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(StoreError::from)
}

fn context_uuid<'a>(context: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    context[key]
        .as_str()
        .filter(|value| transaction::uuid(value).is_ok())
}

async fn load_recent_issues(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    agent: &str,
    context: &serde_json::Value,
) -> Result<Vec<RecentIssue>, StoreError> {
    let rows = sqlx::query(
        "SELECT id::text AS id,identifier,status,title,description,
           assignee_agent_id::text AS assignee_agent_id,assignee_user_id,
           reviewer_agent_id::text AS reviewer_agent_id,reviewer_user_id,
           created_by_agent_id::text AS created_by_agent_id,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
           to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at
         FROM issues
         WHERE org_id=$1::uuid AND (assignee_agent_id=$2::uuid OR reviewer_agent_id=$2::uuid OR created_by_agent_id=$2::uuid OR id=$3::uuid)
         ORDER BY updated_at DESC,created_at DESC,id DESC
         LIMIT 11",
    )
    .bind(org)
    .bind(agent)
    .bind(context_uuid(context,"issueId"))
    .fetch_all(&mut **tx)
    .await?;
    rows.into_iter()
        .map(|row| {
            let assignee_agent: Option<String> = row.try_get("assignee_agent_id")?;
            let assignee_user: Option<String> = row.try_get("assignee_user_id")?;
            let reviewer_agent: Option<String> = row.try_get("reviewer_agent_id")?;
            let reviewer_user: Option<String> = row.try_get("reviewer_user_id")?;
            let assignee =
                format_issue_principal(assignee_agent.as_deref(), assignee_user.as_deref());
            let reviewer =
                format_issue_principal(reviewer_agent.as_deref(), reviewer_user.as_deref());
            let role = if assignee_agent.as_deref() == Some(agent) {
                "assignee"
            } else if reviewer_agent.as_deref() == Some(agent) {
                "reviewer"
            } else if row
                .try_get::<Option<String>, _>("created_by_agent_id")?
                .as_deref()
                == Some(agent)
            {
                "creator"
            } else {
                "linked"
            };
            Ok(RecentIssue {
                id: row.try_get("id")?,
                identifier: row.try_get("identifier")?,
                status: row.try_get("status")?,
                role: role.to_owned(),
                assignee,
                reviewer,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
                title: row.try_get("title")?,
                summary: row.try_get("description")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(StoreError::from)
}

async fn load_recent_chats(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    agent: &str,
    context: &serde_json::Value,
) -> Result<Vec<RecentChat>, StoreError> {
    let rows = sqlx::query(
        "SELECT c.id::text AS id,c.title,c.summary,
           to_char(COALESCE(c.last_message_at,c.updated_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS activity_at,
           (SELECT m.body FROM chat_messages m
            WHERE m.conversation_id=c.id AND m.org_id=$1::uuid
              AND m.superseded_at IS NULL AND btrim(m.body)<>''
            ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS latest_message
         FROM chat_conversations c
         WHERE c.org_id=$1::uuid AND (
           c.preferred_agent_id=$2::uuid OR c.routed_agent_id=$2::uuid OR EXISTS(
             SELECT 1 FROM chat_context_links l
             WHERE l.org_id=$1::uuid AND l.conversation_id=c.id
               AND ((l.entity_type='agent' AND l.entity_id=$2::text) OR (l.entity_type='issue' AND l.entity_id=$3::text) OR (l.entity_type='project' AND l.entity_id=$4::text))
           ) OR ($6=false AND c.id=$5::uuid)
         ) AND ($6=false OR $5::uuid IS NULL OR c.id<>$5::uuid)
         ORDER BY COALESCE(c.last_message_at,c.updated_at) DESC,c.id DESC
         LIMIT 11",
    )
    .bind(org)
    .bind(agent)
    .bind(context_uuid(context,"issueId"))
    .bind(context_uuid(context,"projectId"))
    .bind(context_uuid(context,"chatConversationId"))
    .bind(context["scene"]=="chat" || context["rudderScene"]=="chat" || context["chatMode"]==true)
    .fetch_all(&mut **tx)
    .await?;
    rows.into_iter()
        .map(|row| {
            let latest: Option<String> = row.try_get("latest_message")?;
            let summary: Option<String> = row.try_get("summary")?;
            Ok(RecentChat {
                id: row.try_get("id")?,
                activity_at: row.try_get("activity_at")?,
                title: row.try_get("title")?,
                summary: latest.or(summary),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(StoreError::from)
}

async fn load_organization_members(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
) -> Result<(i64, Vec<OrganizationMember>), StoreError> {
    let predicate = "m.org_id=$1::uuid AND m.status='active' AND (
      (m.principal_type='user' AND m.principal_id<>'local-board' AND u.id IS NOT NULL) OR
      (m.principal_type='agent' AND a.id IS NOT NULL
       AND a.status NOT IN ('terminated','suspended','pending','pending_approval')
       AND COALESCE(a.metadata->>'hidden','false')<>'true'
       AND COALESCE(a.metadata->>'systemManaged','')<>'rudder_copilot'))";
    let count_sql = format!(
        "SELECT count(*) FROM organization_memberships m
         LEFT JOIN agents a ON m.principal_type='agent' AND a.id::text=m.principal_id AND a.org_id=m.org_id
           LEFT JOIN \"user\" u ON m.principal_type='user' AND u.id=m.principal_id
         WHERE {predicate}"
    );
    let total: i64 = sqlx::query_scalar(&count_sql)
        .bind(org)
        .fetch_one(&mut **tx)
        .await?;
    let query = format!(
        "SELECT m.principal_id,
           CASE WHEN m.principal_type='agent' THEN 'agent' ELSE 'human' END AS member_type,
           CASE WHEN m.principal_type='agent' THEN COALESCE(NULLIF(trim(a.name),''),'Agent')
             ELSE COALESCE(NULLIF(trim(op.nickname),''),NULLIF(trim(u.name),''),'Human') END AS member_name,
           CASE WHEN m.principal_type='agent' THEN COALESCE(NULLIF(trim(a.role),''),'agent')
             ELSE COALESCE(NULLIF(trim(m.membership_role),''),'member') END AS member_role
         FROM organization_memberships m
         LEFT JOIN agents a ON m.principal_type='agent' AND a.id::text=m.principal_id AND a.org_id=m.org_id
           LEFT JOIN \"user\" u ON m.principal_type='user' AND u.id=m.principal_id
         LEFT JOIN operator_profiles op ON op.user_id=u.id
         WHERE {predicate}
         ORDER BY member_name ASC,member_type ASC,m.principal_id ASC LIMIT 10"
    );
    let rows = sqlx::query(&query).bind(org).fetch_all(&mut **tx).await?;
    let members = rows
        .into_iter()
        .map(|row| {
            let id: String = row.try_get("principal_id")?;
            let kind: String = row.try_get("member_type")?;
            Ok(OrganizationMember {
                name: row.try_get("member_name")?,
                role: row.try_get("member_role")?,
                reference: short_reference(if kind == "agent" { "agt" } else { "usr" }, &id),
                kind,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    Ok((total, members))
}

fn build_org_resources_prompt(
    integration_tools: &[IntegrationTool],
    automations: &[Automation],
) -> String {
    let integrations = if integration_tools.is_empty() {
        String::new()
    } else {
        let mut lines = vec![
            "These tools are configured for this agent. Use only Rudder-mediated tool calls for them; never ask the operator for stored secrets or credentials.".to_owned(),
            String::new(),
        ];
        append_table(
            &mut lines,
            &[
                "Tool",
                "Integration",
                "Kind",
                "Scope",
                "External name",
                "Description",
            ],
            integration_tools
                .iter()
                .map(|tool| {
                    vec![
                        markdown_code_cell(&tool.tool_name),
                        markdown_table_cell(&tool.integration_name),
                        markdown_table_cell(&tool.kind.replace('_', " ")),
                        markdown_table_cell(&tool.scope),
                        markdown_code_cell(&tool.external_tool_name),
                        markdown_table_cell(tool.description.as_deref().unwrap_or("")),
                    ]
                })
                .collect(),
        );
        wrap_section("connected_custom_integration_tools", &lines.join("\n"))
    };
    let automations = if automations.is_empty() {
        String::new()
    } else {
        let mut lines = vec![
            "These are your current automations; use the ID to inspect details when needed."
                .to_owned(),
            String::new(),
        ];
        append_table(
            &mut lines,
            &["Automation", "ID", "Output", "Last run", "Triggers"],
            automations
                .iter()
                .map(|automation| {
                    vec![
                        markdown_table_cell(&automation.title),
                        markdown_code_cell(&automation.id),
                        markdown_table_cell(&format_output_mode(&automation.output_mode)),
                        markdown_table_cell(
                            automation.last_triggered_at.as_deref().unwrap_or("never"),
                        ),
                        markdown_table_cell(&format_triggers(&automation.triggers)),
                    ]
                })
                .collect(),
        );
        wrap_section("current_automations", &lines.join("\n"))
    };
    join_sections([integrations.as_str(), automations.as_str()])
}

fn build_recent_context(
    today: time::Date,
    today_memory: String,
    yesterday_memory: String,
    issues: &[RecentIssue],
    chats: &[RecentChat],
    member_total: i64,
    members: &[OrganizationMember],
) -> String {
    let today_key = today.to_string();
    let yesterday_key = (today - Duration::days(1)).to_string();
    let mut lines = vec![
        format!("#### today memory: {today_key}.md"),
        clip_markdown(&today_memory, MEMORY_FILE_LIMIT),
        String::new(),
        format!("#### yesterday memory: {yesterday_key}.md"),
        clip_markdown(&yesterday_memory, MEMORY_FILE_LIMIT),
        String::new(),
        "#### organization members".to_owned(),
    ];
    if member_total == 0 {
        lines.push("(none)".to_owned());
    } else if member_total >= 10 {
        lines.push(format!(
            "Organization has {member_total} active members. Use `rudder_organization_members_list` to query the member directory."
        ));
        lines.push("CLI fallback: `rudder org members --org-id <id>`. ".to_owned());
    } else {
        append_table(
            &mut lines,
            &["Name", "Type", "Role", "Ref"],
            members
                .iter()
                .map(|member| {
                    vec![
                        markdown_table_cell(&member.name),
                        markdown_table_cell(&member.kind),
                        markdown_table_cell(&member.role),
                        markdown_code_cell(&member.reference),
                    ]
                })
                .collect(),
        );
    }
    lines.extend([String::new(), "#### recent issues".to_owned()]);
    if issues.is_empty() {
        lines.push("(none)".to_owned());
    } else {
        append_table(
            &mut lines,
            &[
                "Issue", "Status", "Role", "Assignee", "Reviewer", "Created", "Updated", "Title",
                "Summary",
            ],
            issues
                .iter()
                .take(10)
                .map(|issue| {
                    vec![
                        markdown_code_cell(
                            issue
                                .identifier
                                .as_deref()
                                .unwrap_or(&short_reference("iss", &issue.id)),
                        ),
                        markdown_code_cell(&issue.status),
                        markdown_table_cell(&issue.role),
                        markdown_table_cell(issue.assignee.as_deref().unwrap_or("")),
                        markdown_table_cell(issue.reviewer.as_deref().unwrap_or("")),
                        markdown_table_cell(issue.created_at.as_deref().unwrap_or("unknown")),
                        markdown_table_cell(issue.updated_at.as_deref().unwrap_or("unknown")),
                        markdown_table_cell(&clip(&issue.title, 120)),
                        markdown_table_cell(&clip(
                            issue.summary.as_deref().unwrap_or(""),
                            ISSUE_SNIPPET_LIMIT,
                        )),
                    ]
                })
                .collect(),
        );
    }
    lines.extend([String::new(), "#### recent chats".to_owned()]);
    if chats.is_empty() {
        lines.push("(none)".to_owned());
    } else {
        append_table(
            &mut lines,
            &["Chat", "Last active", "Title", "Summary"],
            chats
                .iter()
                .take(10)
                .map(|chat| {
                    vec![
                        markdown_code_cell(&short_reference("cht", &chat.id)),
                        markdown_table_cell(chat.activity_at.as_deref().unwrap_or("unknown")),
                        markdown_table_cell(&clip(&chat.title, 120)),
                        markdown_table_cell(&clip(
                            chat.summary.as_deref().unwrap_or(""),
                            CHAT_SNIPPET_LIMIT,
                        )),
                    ]
                })
                .collect(),
        );
    }
    let body = lines.join("\n");
    let full = wrap_section("recent_rudder_context", &body);
    truncate_recent_context(&full)
}

fn build_startup_context_value(
    markdown: &str,
    today_memory: &DailyMemory,
    yesterday_memory: &DailyMemory,
    issues: &[RecentIssue],
    chats: &[RecentChat],
    omitted_issues: usize,
    omitted_chats: usize,
) -> serde_json::Value {
    let issue_refs = issues.iter().take(10).map(|issue| {
        let reference = issue
            .identifier
            .clone()
            .unwrap_or_else(|| short_reference("iss", &issue.id));
        serde_json::json!({
            "kind": "issue",
            "id": issue.id,
            "ref": reference,
        })
    });
    let chat_refs = chats.iter().take(10).map(|chat| {
        serde_json::json!({
            "kind": "chat",
            "id": chat.id,
            "ref": short_reference("cht", &chat.id),
        })
    });
    let mut source_refs = vec![
        serde_json::json!({"kind":"memory","id":today_memory.date_key,"ref":today_memory.relative_path}),
        serde_json::json!({"kind":"memory","id":yesterday_memory.date_key,"ref":yesterday_memory.relative_path}),
    ];
    source_refs.extend(issue_refs);
    source_refs.extend(chat_refs);

    let mut omissions = Vec::new();
    if let Some(error) = &today_memory.error {
        omissions.push(format!("{}: {error}", today_memory.relative_path));
    }
    if let Some(error) = &yesterday_memory.error {
        omissions.push(format!("{}: {error}", yesterday_memory.relative_path));
    }
    if omitted_issues > 0 {
        omissions.push(format!("{omitted_issues} older issues"));
    }
    if omitted_chats > 0 {
        omissions.push(format!("{omitted_chats} older chats"));
    }
    serde_json::json!({
        "version": "agent-startup-context/v1",
        "sections": ["daily_memory", "organization_members", "recent_issues", "recent_chats"],
        "sourceRefs": source_refs,
        "markdown": markdown,
        "metrics": {
            "version": "agent-startup-context/v1",
            "totalChars": js_string_length(markdown),
            "limitChars": RECENT_CONTEXT_LIMIT,
            "recentIssuesCount": issues.len().min(10),
            "recentChatsCount": chats.len().min(10),
            "omittedIssues": omitted_issues,
            "omittedChats": omitted_chats,
        },
        "omissions": omissions,
    })
}

fn read_daily_memory(memory_dir: &Path, date: time::Date) -> DailyMemory {
    let filename = format!("{date}.md");
    let relative_path = format!("memory/{filename}");
    let failed = |error: String| DailyMemory {
        date_key: date.to_string(),
        relative_path: relative_path.clone(),
        content: String::new(),
        error: Some(error),
    };
    if let Err(error) = fs::create_dir_all(memory_dir) {
        return failed(format!("mkdir failed: {error}"));
    }
    let path = memory_dir.join(&filename);
    if !path.exists()
        && let Err(error) = fs::write(&path, "")
    {
        return failed(format!("create failed: {error}"));
    }
    match fs::read_to_string(path) {
        Ok(content) => DailyMemory {
            date_key: date.to_string(),
            relative_path,
            content,
            error: None,
        },
        Err(error) => failed(format!("read failed: {error}")),
    }
}

fn format_triggers(triggers: &[Trigger]) -> String {
    if triggers.is_empty() {
        return "none configured".to_owned();
    }
    triggers
        .iter()
        .map(|trigger| {
            let label = trigger
                .label
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty())
                .map(|label| format!("{} ({})", format_single_line(label), trigger.kind))
                .unwrap_or_else(|| trigger.kind.clone());
            let next = if trigger.kind == "schedule" {
                format!(
                    "next trigger: {}",
                    trigger.next_run_at.as_deref().unwrap_or("not scheduled")
                )
            } else {
                "next trigger: event-driven".to_owned()
            };
            format!(
                "{label}; {}; {next}; last fired: {}",
                if trigger.enabled {
                    "enabled"
                } else {
                    "disabled"
                },
                trigger.last_fired_at.as_deref().unwrap_or("never")
            )
        })
        .collect::<Vec<_>>()
        .join(" / ")
}

fn format_output_mode(value: &str) -> String {
    match value {
        "track_issue" => "issue".to_owned(),
        "chat_output" => "chat".to_owned(),
        _ => format_single_line(value),
    }
}

fn format_issue_principal(agent_id: Option<&str>, user_id: Option<&str>) -> Option<String> {
    if let Some(id) = agent_id {
        Some(format!("agent:{}", short_reference("agt", id)))
    } else {
        user_id.map(|id| format!("user:{}", short_reference("usr", id)))
    }
}

fn short_reference(prefix: &str, id: &str) -> String {
    let compact = id
        .chars()
        .filter(|character| *character != '-')
        .take(8)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if compact.len() == 8 {
        format!("{prefix}_{compact}")
    } else {
        let fallback = id
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .take(8)
            .flat_map(char::to_lowercase)
            .collect::<String>();
        format!(
            "{prefix}_{}",
            if fallback.is_empty() {
                "unknown"
            } else {
                &fallback
            }
        )
    }
}

fn markdown_table_cell(value: &str) -> String {
    let compact = format_single_line(value);
    if compact.is_empty() {
        "empty".to_owned()
    } else {
        compact.replace('|', "\\|")
    }
}

fn markdown_code_cell(value: &str) -> String {
    let compact = markdown_table_cell(value);
    if compact == "empty" {
        compact
    } else {
        format!("`{}`", compact.replace('`', "'"))
    }
}

fn format_single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(value: &str, max_chars: usize) -> String {
    let compact = format_single_line(value);
    if js_string_length(&compact) <= max_chars {
        compact
    } else {
        format!(
            "{}...",
            js_slice_prefix(&compact, max_chars.saturating_sub(3)).trim_end()
        )
    }
}

fn clip_markdown(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "(empty)".to_owned();
    }
    if js_string_length(trimmed) <= max_chars {
        return trimmed.to_owned();
    }
    format!(
        "{}...",
        js_slice_prefix(trimmed, max_chars.saturating_sub(3)).trim_end()
    )
}

/// JavaScript's `String.length` and `slice` count UTF-16 code units. Preserve
/// that clipping contract for supplementary Unicode characters in user text.
fn js_string_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn js_slice_prefix(value: &str, code_units: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(code_units).collect::<Vec<_>>())
}

fn append_table(lines: &mut Vec<String>, headers: &[&str], rows: Vec<Vec<String>>) {
    lines.push(format!("| {} |", headers.join(" | ")));
    lines.push(format!("| {} |", vec!["---"; headers.len()].join(" | ")));
    for row in rows {
        lines.push(format!("| {} |", row.join(" | ")));
    }
}

fn wrap_section(tag: &str, content: &str) -> String {
    if content.trim().is_empty() {
        String::new()
    } else {
        format!("<{tag}>\n{content}\n</{tag}>")
    }
}

fn join_sections<'a>(sections: impl IntoIterator<Item = &'a str>) -> String {
    sections
        .into_iter()
        .map(str::trim)
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn truncate_recent_context(value: &str) -> String {
    if js_string_length(value) <= RECENT_CONTEXT_LIMIT {
        return value.to_owned();
    }
    let opening = "<recent_rudder_context>\n";
    let suffix = "...\n\n[Recent Rudder Context truncated by char limit]\n</recent_rudder_context>";
    let body_limit =
        RECENT_CONTEXT_LIMIT.saturating_sub(opening.chars().count() + suffix.chars().count());
    let body = value
        .strip_prefix(opening)
        .and_then(|value| value.strip_suffix("\n</recent_rudder_context>"))
        .unwrap_or(value);
    format!(
        "{opening}{}{suffix}",
        js_slice_prefix(body, body_limit).trim_end()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_prompt_uses_legacy_sections_tables_and_empty_member_context() {
        let tools = vec![IntegrationTool {
            integration_name: "Release Hub".into(),
            kind: "mcp_server".into(),
            scope: "organization".into(),
            tool_name: "custom.release.publish".into(),
            external_tool_name: "publish_release".into(),
            description: Some("Publish | verify releases".into()),
        }];
        let automations = vec![Automation {
            id: "00000000-0000-4000-8000-000000000001".into(),
            title: "Morning review".into(),
            output_mode: "track_issue".into(),
            last_triggered_at: None,
            triggers: vec![Trigger {
                kind: "schedule".into(),
                label: Some("Daily check".into()),
                enabled: true,
                next_run_at: Some("2026-10-26T08:00:00.000Z".into()),
                last_fired_at: None,
            }],
        }];
        let resources = build_org_resources_prompt(&tools, &automations);
        assert!(resources.contains("<connected_custom_integration_tools>"));
        assert!(resources.contains("| `custom.release.publish` | Release Hub | mcp server | organization | `publish_release` | Publish \\| verify releases |"));
        assert!(resources.contains("<current_automations>"));
        assert!(resources.contains("| Morning review | `00000000-0000-4000-8000-000000000001` | issue | never | Daily check (schedule); enabled; next trigger: 2026-10-26T08:00:00.000Z; last fired: never |"));
    }

    #[test]
    fn short_references_match_prompt_reference_prefixes() {
        assert_eq!(
            short_reference("agt", "50000000-0000-4000-8000-000000000001"),
            "agt_50000000"
        );
        assert_eq!(
            short_reference("iss", "40000000-0000-4000-8000-000000000001"),
            "iss_40000000"
        );
    }

    #[test]
    fn startup_context_matches_the_legacy_typescript_formatter_oracle() {
        let today = time::Date::from_calendar_date(2026, time::Month::October, 25).unwrap();
        let issues = vec![RecentIssue {
            id: "40000000-0000-4000-8000-000000000001".into(),
            identifier: Some("RUD-42".into()),
            status: "in_progress".into(),
            role: "assignee".into(),
            assignee: Some("agent:agt_50000000".into()),
            reviewer: Some("user:usr_60000000".into()),
            created_at: Some("2026-10-24T01:02:03.004Z".into()),
            updated_at: Some("2026-10-25T02:03:04.005Z".into()),
            title: "修复跨组织访问 🚧".into(),
            summary: Some("Preserve exact role, identifier, and Unicode summary.".into()),
        }];
        let chats = vec![RecentChat {
            id: "70000000-0000-4000-8000-000000000001".into(),
            activity_at: Some("2026-10-25T02:30:00.000Z".into()),
            title: "Goal context 🧭".into(),
            summary: Some("计划是：先读清楚，再做实现。".into()),
        }];
        let members = vec![
            OrganizationMember {
                name: "山田 太郎".into(),
                kind: "human".into(),
                role: "member".into(),
                reference: "usr_60000000".into(),
            },
            OrganizationMember {
                name: "Builder agent".into(),
                kind: "agent".into(),
                role: "engineer".into(),
                reference: "agt_50000000".into(),
            },
        ];
        let actual = build_recent_context(
            today,
            "- 今日：检查完成 ✅\n- owner says café; 🧭".into(),
            "昨日恢复 — keep it short".into(),
            &issues,
            &chats,
            2,
            &members,
        );
        let expected: String = serde_json::from_str(include_str!(
            "../tests/fixtures/goal-startup-context-typescript.json"
        ))
        .unwrap();
        assert_eq!(actual, expected);
        let today_memory = DailyMemory {
            date_key: today.to_string(),
            relative_path: format!("memory/{today}.md"),
            content: "- 今日：检查完成 ✅\n- owner says café; 🧭".into(),
            error: None,
        };
        let yesterday = today - Duration::days(1);
        let yesterday_memory = DailyMemory {
            date_key: yesterday.to_string(),
            relative_path: format!("memory/{yesterday}.md"),
            content: "昨日恢复 — keep it short".into(),
            error: None,
        };
        let startup_context = build_startup_context_value(
            &actual,
            &today_memory,
            &yesterday_memory,
            &issues,
            &chats,
            0,
            0,
        );
        assert_eq!(startup_context["markdown"], expected);
        assert_eq!(startup_context["version"], "agent-startup-context/v1");
        assert_eq!(
            startup_context["metrics"]["totalChars"],
            js_string_length(&expected)
        );
        assert_eq!(startup_context["metrics"]["recentIssuesCount"], 1);
        assert_eq!(startup_context["metrics"]["recentChatsCount"], 1);
        assert_eq!(
            startup_context["sourceRefs"][2],
            serde_json::json!({
                "kind":"issue",
                "id":"40000000-0000-4000-8000-000000000001",
                "ref":"RUD-42"
            })
        );
    }

    #[test]
    fn clips_match_javascript_utf16_length_for_supplementary_characters() {
        assert_eq!(clip("ab😀cd", 5), "ab...");
        assert_eq!(clip("ab😀cd", 4), "a...");
        assert_eq!(js_string_length("😀"), 2);
    }

    #[test]
    fn daily_memory_io_failure_is_preserved_as_a_startup_context_omission() {
        let directory = tempfile::tempdir().unwrap();
        let not_a_directory = directory.path().join("file");
        fs::write(&not_a_directory, "blocking memory path").unwrap();
        let today = time::Date::from_calendar_date(2026, time::Month::October, 25).unwrap();
        let yesterday = today - Duration::days(1);
        let today_memory = read_daily_memory(&not_a_directory, today);
        let yesterday_memory = DailyMemory {
            date_key: yesterday.to_string(),
            relative_path: format!("memory/{yesterday}.md"),
            content: String::new(),
            error: None,
        };
        let startup_context =
            build_startup_context_value("", &today_memory, &yesterday_memory, &[], &[], 0, 0);

        assert!(today_memory.content.is_empty());
        assert!(
            today_memory
                .error
                .as_deref()
                .unwrap()
                .starts_with("mkdir failed:")
        );
        assert_eq!(
            startup_context["omissions"][0]
                .as_str()
                .unwrap()
                .split(": ")
                .next(),
            Some("memory/2026-10-25.md")
        );
    }
}
