//! Pure, organization-scoped legacy Project projections. Reads deliberately do
//! not consult mutation ownership or provision Library directories. The public
//! adapter authenticates the actor before calling this private capability.

use crate::{
    StoreError,
    legacy_read_json::parse_legacy_read_json,
    project_creations::{normalize_key, normalize_policy},
    transaction,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::collections::HashMap;

const PROJECTS_SQL: &str = r#"
SELECT (to_jsonb(p) || jsonb_build_object(
  'created_at', to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updated_at', to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'paused_at', to_char(p.paused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'archived_at', to_char(p.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
))::text
FROM projects p WHERE p.org_id=$1::uuid AND ($2::uuid IS NULL OR p.id=$2::uuid)
"#;

const RESOURCES_SQL: &str = r#"
SELECT (to_jsonb(a) || jsonb_build_object(
  'created_at', to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updated_at', to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text AS attachment,
 (to_jsonb(r) || jsonb_build_object(
  'created_at', to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updated_at', to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text AS resource
FROM project_resource_attachments a
JOIN organization_resources r ON r.id=a.resource_id AND r.org_id=a.org_id
WHERE a.org_id=$1::uuid AND a.project_id=ANY($2::text[]::uuid[])
ORDER BY a.sort_order, a.created_at
"#;

const WORKSPACES_SQL: &str = r#"
SELECT (to_jsonb(w) || jsonb_build_object(
  'created_at', to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updated_at', to_char(w.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text
FROM project_workspaces w WHERE w.org_id=$1::uuid AND w.project_id=ANY($2::text[]::uuid[])
ORDER BY w.is_primary DESC, w.created_at, w.id
"#;

const RUNTIME_SERVICES_SQL: &str = r#"
SELECT (to_jsonb(s) || jsonb_build_object(
  'created_at', to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updated_at', to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'last_used_at', to_char(s.last_used_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'started_at', to_char(s.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'stopped_at', to_char(s.stopped_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text
FROM workspace_runtime_services s
WHERE s.org_id=$1::uuid AND s.project_workspace_id=ANY($2::text[]::uuid[])
ORDER BY s.updated_at DESC, s.created_at DESC
"#;

/// Preserve the existing complete list/detail/resources shape for every Project,
/// including Node-owned and imported rows. A read-only snapshot prevents linked
/// rows from disappearing midway through a response, without taking write locks.
/// `organization_workspace_root` is a signed host-derived display path only.
pub async fn read_projects(
    pool: &PgPool,
    organization_id: &str,
    project_id: Option<&str>,
    resources_only: bool,
    organization_workspace_root: &str,
) -> Result<Value, StoreError> {
    let org = organization_id.to_ascii_lowercase();
    transaction::uuid(&org)?;
    let project = project_id.map(str::to_ascii_lowercase);
    if let Some(id) = &project {
        transaction::uuid(id)?;
    }
    if resources_only && project.is_none() {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    // The old public list has no ordering/filter/pagination contract. Do not
    // introduce one as part of moving the capability across the bridge.
    let raw: Vec<String> = sqlx::query_scalar(PROJECTS_SQL)
        .bind(&org)
        .bind(&project)
        .fetch_all(&mut *tx)
        .await?;
    if project.is_some() && raw.is_empty() {
        return Err(StoreError::NotFound);
    }
    let mut projects = raw
        .iter()
        .map(|raw| read_row(raw))
        .collect::<Result<Vec<_>, _>>()?;
    if projects.is_empty() {
        tx.commit().await?;
        return Ok(json!([]));
    }
    let ids = projects
        .iter()
        .map(|row| required_text(row, "id").map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    let mut resources = HashMap::<String, Vec<Value>>::new();
    for row in sqlx::query(RESOURCES_SQL)
        .bind(&org)
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?
    {
        let mut attachment = read_row(&row.try_get::<String, _>("attachment")?)?;
        let mut resource = read_row(&row.try_get::<String, _>("resource")?)?;
        if resource["sourceType"].is_null() {
            resource["sourceType"] = json!("external");
        }
        attachment["resource"] = resource;
        let id = required_text(&attachment, "projectId")?.to_owned();
        resources.entry(id).or_default().push(attachment);
    }
    if resources_only {
        tx.commit().await?;
        return Ok(json!(resources.remove(&ids[0]).unwrap_or_default()));
    }
    let mut goals = HashMap::<String, Vec<Value>>::new();
    // Deliberately preserve join order instead of reordering the legacy goalIds
    // projection by primary goal or UUID. Do not read mutation state here.
    for row in sqlx::query(
        "SELECT pg.project_id::text, g.id::text AS goal_id, g.title FROM project_goals pg
         JOIN goals g ON g.id=pg.goal_id AND g.org_id=pg.org_id
         WHERE pg.org_id=$1::uuid AND pg.project_id=ANY($2::text[]::uuid[])",
    )
    .bind(&org)
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?
    {
        let id: String = row.try_get("goal_id")?;
        goals.entry(row.try_get("project_id")?).or_default().push(json!({
            "id": id, "shortRef": format!("gol_{}", &id[..8]), "title": row.try_get::<String, _>("title")?,
        }));
    }
    let workspace_rows: Vec<String> = sqlx::query_scalar(WORKSPACES_SQL)
        .bind(&org)
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
    let mut workspace_values = workspace_rows
        .iter()
        .map(|row| read_row(row))
        .collect::<Result<Vec<_>, _>>()?;
    let workspace_ids = workspace_values
        .iter()
        .map(|row| required_text(row, "id").map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    let mut services = HashMap::<String, Vec<Value>>::new();
    if !workspace_ids.is_empty() {
        let rows: Vec<String> = sqlx::query_scalar(RUNTIME_SERVICES_SQL)
            .bind(&org)
            .bind(&workspace_ids)
            .fetch_all(&mut *tx)
            .await?;
        for raw in rows {
            let service = read_row(&raw)?;
            services
                .entry(required_text(&service, "projectWorkspaceId")?.to_owned())
                .or_default()
                .push(service);
        }
    }
    let mut workspaces = HashMap::<String, Vec<Value>>::new();
    for workspace in &mut workspace_values {
        let id = required_text(workspace, "id")?.to_owned();
        normalize_workspace(workspace, services.remove(&id).unwrap_or_default());
        workspaces
            .entry(required_text(workspace, "projectId")?.to_owned())
            .or_default()
            .push(workspace.take());
    }
    for row in &mut projects {
        let id = required_text(row, "id")?.to_owned();
        enrich_project(
            row,
            organization_workspace_root,
            goals.remove(&id).unwrap_or_default(),
            resources.remove(&id).unwrap_or_default(),
            workspaces.remove(&id).unwrap_or_default(),
        )?;
    }
    tx.commit().await?;
    if project.is_some() {
        Ok(projects.remove(0))
    } else {
        Ok(Value::Array(projects))
    }
}

// Legacy PostgreSQL JSON decoding used JavaScript numbers before Express
// serialized the response. Keep that wire behavior for read-only metadata;
// do not change mutation receipt parsing or persisted PostgreSQL values.
fn read_row(raw: &str) -> Result<Value, StoreError> {
    let source = parse_legacy_read_json(raw).map_err(|_| StoreError::InvalidReceipt)?;
    let Value::Object(source) = source else {
        return Err(StoreError::InvalidReceipt);
    };
    let mut result = serde_json::Map::new();
    for (key, value) in source {
        let mut parts = key.split('_');
        let mut camel = parts.next().unwrap_or_default().to_owned();
        for part in parts {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                camel.extend(first.to_uppercase());
            }
            camel.extend(chars);
        }
        result.insert(camel, value);
    }
    Ok(Value::Object(result))
}

fn required_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, StoreError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidReceipt)
}

// String.trim() compatibility matters for persisted legacy paths: Rust also
// trims U+0085 while JavaScript does not, and JavaScript additionally trims BOM.
fn trim_ecmascript_whitespace(value: &str) -> &str {
    value.trim_matches(|ch| {
        matches!(ch,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

fn normalize_workspace(workspace: &mut Value, services: Vec<Value>) {
    let cwd = workspace["cwd"]
        .as_str()
        .map(trim_ecmascript_whitespace)
        .filter(|cwd| !cwd.is_empty() && *cwd != "/__paperclip_repo_only__");
    workspace["cwd"] = json!(cwd);
    if workspace["defaultRef"].is_null() {
        workspace["defaultRef"] = workspace["repoRef"].clone();
    }
    workspace["runtimeServices"] = Value::Array(services);
}

fn enrich_project(
    project: &mut Value,
    root: &str,
    goals: Vec<Value>,
    resources: Vec<Value>,
    workspaces: Vec<Value>,
) -> Result<(), StoreError> {
    let id = required_text(project, "id")?.to_owned();
    let name = required_text(project, "name")?;
    let url_key = normalize_key(name).unwrap_or_else(|| id.clone());
    if project["icon"].is_null() {
        project["icon"] = json!("folder");
    }
    project["shortRef"] = json!(format!("prj_{}", &id[..8]));
    project["urlKey"] = json!(url_key);
    project["goalIds"] = json!(goals.iter().map(|goal| &goal["id"]).collect::<Vec<_>>());
    project["goals"] = Value::Array(goals);
    project["executionWorkspacePolicy"] = normalize_policy(&project["executionWorkspacePolicy"]);
    project["resources"] = Value::Array(resources);
    // SQL orders explicit primaries first, then createdAt/id, matching Node.
    project["primaryWorkspace"] = workspaces.first().cloned().unwrap_or(Value::Null);
    project["workspaces"] = Value::Array(workspaces);
    project["codebase"] = json!({
        "configured": true, "scope": "organization", "workspaceId": null,
        "repoUrl": null, "repoRef": null, "defaultRef": null, "repoName": null,
        "localFolder": root, "managedFolder": root, "effectiveLocalFolder": root,
        "origin": "local_folder",
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_projection_preserves_legacy_fields_without_provisioning() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("does-not-exist");
        let id = "20000000-0000-4000-8000-000000000001";
        let mut project = json!({"id":id,"name":"東京","icon":null,"goalId":null,
            "targetDate":"2026-10-04","pausedAt":null,
            "executionWorkspacePolicy":{"enabled":true,"defaultMode":"project_primary",
                "workspaceStrategy":{"type":"git_worktree","baseRef":"main","ignored":true},
                "cleanupPolicy":{"after":"merge"},"ignored":"value"}});
        let goals = vec![
            json!({"id":"goal-2","title":"Second"}),
            json!({"id":"goal-1","title":"First"}),
        ];
        let workspace = json!({"id":"workspace","isPrimary":true});
        enrich_project(
            &mut project,
            root.to_str().unwrap(),
            goals.clone(),
            vec![],
            vec![workspace.clone()],
        )
        .unwrap();
        assert_eq!(project["urlKey"], id);
        assert_eq!(project["shortRef"], "prj_20000000");
        assert_eq!(project["icon"], "folder");
        assert_eq!(project["targetDate"], "2026-10-04");
        assert_eq!(project["goalId"], Value::Null);
        assert_eq!(project["goalIds"], json!(["goal-2", "goal-1"]));
        assert_eq!(project["goals"], json!(goals));
        assert_eq!(project["primaryWorkspace"], workspace);
        assert_eq!(project["codebase"]["localFolder"], root.to_str().unwrap());
        assert_eq!(
            project["executionWorkspacePolicy"],
            json!({"enabled":true,
            "defaultMode":"shared_workspace","workspaceStrategy":{"type":"git_worktree","baseRef":"main"},
            "cleanupPolicy":{"after":"merge"}})
        );
        assert!(!root.exists(), "pure reads must not create a Library tree");
    }

    #[test]
    fn project_nullable_defaults_and_ascii_url_key_match_legacy_projection() {
        let mut project = json!({"id":"20000000-0000-4000-8000-000000000001", "name":" A_B / C! ",
            "icon":"", "goalId":"legacy-only-goal", "targetDate":null, "pausedAt":null,
            "description":null, "executionWorkspacePolicy":[]});
        enrich_project(&mut project, "/display-only", vec![], vec![], vec![]).unwrap();
        assert_eq!(project["urlKey"], "a-b-c");
        assert_eq!(project["icon"], "");
        assert_eq!(project["goalId"], "legacy-only-goal");
        assert_eq!(project["goalIds"], json!([]));
        assert_eq!(project["executionWorkspacePolicy"], Value::Null);
        assert_eq!(project["description"], Value::Null);
        assert_eq!(project["primaryWorkspace"], Value::Null);
        assert_eq!(project["resources"], json!([]));
    }

    #[test]
    fn row_conversion_preserves_nested_json_and_utc_timestamp_strings() {
        let row = read_row(r#"{"created_at":"2026-10-04T01:02:03.456Z","stopped_at":null,"metadata":{"snake_key":true},"source_type":"external"}"#).unwrap();
        assert_eq!(
            row,
            json!({"createdAt":"2026-10-04T01:02:03.456Z", "stoppedAt":null,
            "metadata":{"snake_key":true}, "sourceType":"external"})
        );
    }

    #[test]
    fn read_metadata_matches_javascript_numbers_without_touching_strings() {
        let row = read_row(r#"{"metadata":{"overflow":1e400,"negative":-1e400,"rounded":9007199254740993,"tiny":1e-400,"text":"1e400","nested":[-0,1.5,{"n":1e400}]}}"#).unwrap();
        assert_eq!(
            row["metadata"],
            json!({
                "overflow": null, "negative": null, "rounded": 9007199254740992_u64,
                "tiny": 0, "text": "1e400", "nested": [0, 1.5, {"n": null}],
            })
        );
    }

    #[test]
    fn read_numbers_do_not_round_again_during_projection_decode() {
        let row = read_row(r#"{"stop_policy":{"finite":[1.0790143258645723e-180,1.7976931348623157e308,5e-324,0.84551240822557006]}}"#).unwrap();
        let expected = [
            1.0790143258645723e-180,
            f64::MAX,
            f64::from_bits(1),
            0.8455124082255701,
        ];
        for (index, expected) in expected.into_iter().enumerate() {
            assert_eq!(
                row["stopPolicy"]["finite"][index]
                    .as_f64()
                    .unwrap()
                    .to_bits(),
                expected.to_bits()
            );
        }
    }

    #[test]
    fn workspace_projection_keeps_runtime_data_and_normalizes_only_legacy_cwd() {
        for (input, expected) in [
            (Some(" /__paperclip_repo_only__ "), None),
            (Some("  "), None),
            (None, None),
            (Some(" /work/repo "), Some("/work/repo")),
            (Some("\u{feff}/work/repo\u{feff}"), Some("/work/repo")),
            (
                Some("\u{0085}/work/repo\u{0085}"),
                Some("\u{0085}/work/repo\u{0085}"),
            ),
        ] {
            let mut workspace =
                json!({"cwd":input,"defaultRef":null,"repoRef":"main","metadata":{"legacy":true}});
            let services = vec![json!({"id":"service","stoppedAt":null})];
            normalize_workspace(&mut workspace, services.clone());
            assert_eq!(workspace["cwd"], json!(expected));
            assert_eq!(workspace["defaultRef"], "main");
            assert_eq!(workspace["runtimeServices"], json!(services));
            assert_eq!(workspace["metadata"], json!({"legacy":true}));
        }
        let mut workspace = json!({"cwd":null,"defaultRef":"","repoRef":"fallback"});
        normalize_workspace(&mut workspace, vec![]);
        assert_eq!(workspace["defaultRef"], "");
    }
}
