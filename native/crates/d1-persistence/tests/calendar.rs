mod support;

use rudder_d1_persistence::calendar::execute_calendar;
use serde_json::{Value, json};
use std::env;
use support::{CEO, Database, FOREIGN_GOAL, ORG, OTHER};

async fn command(db: &Database, org: &str, request: Value) -> (u16, Value) {
    execute_calendar(&db.pool, org, "local-board", None, &request)
        .await
        .unwrap_or_else(|error| {
            panic!(
                "{} failed: {error:?}; request={request}",
                request["operation"]
            )
        })
}

fn event_window() -> Value {
    let now = time::OffsetDateTime::now_utc();
    json!({
        "start": (now - time::Duration::minutes(2)).format(&time::format_description::well_known::Rfc3339).unwrap(),
        "end": (now + time::Duration::minutes(4)).format(&time::format_description::well_known::Rfc3339).unwrap(),
        "agentIds": CEO,
        "sourceIds": "",
        "eventKinds": "agent_work_block",
        "statuses": "",
    })
}

#[tokio::test]
async fn calendar_sources_events_audit_and_derived_reads_use_postgres_authority() {
    let db = Database::start().await;
    let initial_name = db.name().await;
    let initial_brand_color = db.brand_color().await;
    let initial_counts = db.counts().await;

    let (status, source) = command(
        &db,
        ORG,
        json!({"operation":"source.create","input":{
            "name":"My Calendar",
            "syncCursorJson":{"accessToken":"secret-access","refreshToken":"secret-refresh","syncToken":"keep"}
        }}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(source["type"], "rudder_local");
    assert_eq!(source["syncCursorJson"]["accessToken"], "[redacted]");
    assert_eq!(source["syncCursorJson"]["refreshToken"], "[redacted]");
    assert_eq!(source["syncCursorJson"]["syncToken"], "keep");
    let source_id = source["id"].as_str().unwrap();

    let (status, updated_source) = command(
        &db,
        ORG,
        json!({"operation":"source.update","id":source_id,"input":{"name":"Renamed","syncCursorJson":null}}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(updated_source["name"], "Renamed");
    assert!(updated_source["syncCursorJson"].is_null());
    let cursor_is_sql_null: bool = sqlx::query_scalar(
        "SELECT sync_cursor_json IS NULL FROM calendar_sources WHERE id=$1::uuid",
    )
    .bind(source_id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(cursor_is_sql_null);

    sqlx::query("INSERT INTO instance_settings (singleton_key,general) VALUES ('default',$1::jsonb) ON CONFLICT (singleton_key) DO UPDATE SET general=EXCLUDED.general")
        .bind(r#"{"censorUsernameInLogs":true}"#)
        .execute(&db.pool)
        .await
        .unwrap();
    let current_username = env::var("USER").ok().filter(|value| !value.is_empty());
    let private_title = current_username
        .clone()
        .unwrap_or_else(|| "Private planning event".to_owned());

    let (status, event) = command(
        &db,
        ORG,
        json!({"operation":"event.create","input":{
            "sourceId":source_id,
            "eventKind":"human_event",
            "ownerType":"user",
            "title":private_title,
            "startAt":"2026-10-08T17:00:00.000Z",
            "endAt":"2026-10-08T18:00:00.000Z",
            "sourceMode":"manual"
        }}),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(event["eventStatus"], "planned");
    assert_eq!(event["timezone"], "UTC");
    assert_eq!(event["source"]["id"], source_id);
    assert_eq!(event["title"], private_title);
    let event_id = event["id"].as_str().unwrap();

    if let Some(username) = current_username {
        let masked = format!(
            "{}{}",
            username.chars().next().unwrap_or('*'),
            "*".repeat(username.chars().count().saturating_sub(1).max(1))
        );
        let logged_title: String = sqlx::query_scalar(
            "SELECT details->>'title' FROM activity_log WHERE org_id=$1::uuid AND action='calendar.event_created' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(ORG)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(logged_title, masked);
    }

    let (status, patched) = command(
        &db,
        ORG,
        json!({"operation":"event.update","id":event_id,"input":{"title":"Planning review","description":null}}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(patched["title"], "Planning review");
    assert!(patched["description"].is_null());
    assert_eq!(patched["createdByUserId"], "local-board");
    assert_eq!(patched["updatedByUserId"], "local-board");

    let (status, list) = command(
        &db,
        ORG,
        json!({"operation":"event.list","filters":{
            "start":"2026-10-08T16:00:00.000Z",
            "end":"2026-10-08T19:00:00.000Z",
            "agentIds":"",
            "sourceIds":"",
            "eventKinds":"human_event",
            "statuses":"planned"
        }}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(list["events"].as_array().unwrap().len(), 1);
    assert_eq!(list["events"][0]["id"], event_id);

    let (status, deleted) =
        command(&db, ORG, json!({"operation":"event.delete","id":event_id})).await;
    assert_eq!(status, 200);
    assert_eq!(deleted["ok"], true);
    assert_eq!(
        command(
            &db,
            OTHER,
            json!({"operation":"event.detail","id":event_id})
        )
        .await
        .0,
        404
    );

    let (status, imported) = command(
        &db,
        ORG,
        json!({"operation":"event.create","input":{
            "sourceId":source_id,
            "eventKind":"external_event",
            "ownerType":"system",
            "title":"Imported provider event",
            "startAt":"2026-10-08T17:00:00.000Z",
            "endAt":"2026-10-08T18:00:00.000Z",
            "sourceMode":"imported"
        }}),
    )
    .await;
    assert_eq!(status, 201);
    let imported_id = imported["id"].as_str().unwrap();
    let error = execute_calendar(
        &db.pool,
        ORG,
        "local-board",
        None,
        &json!({"operation":"event.update","id":imported_id,"input":{"title":"Must stay read-only"}}),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        error,
        rudder_d1_persistence::calendar::CalendarError::Http(409, ref message)
            if message == "Imported and derived calendar events are read-only"
    ));
    let derived_error = execute_calendar(
        &db.pool,
        ORG,
        "local-board",
        None,
        &json!({"operation":"event.create","input":{
            "eventKind":"human_event","ownerType":"user","title":"Forbidden derived event",
            "startAt":"2026-10-08T17:00:00.000Z","endAt":"2026-10-08T18:00:00.000Z",
            "sourceMode":"derived"
        }}),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        derived_error,
        rudder_d1_persistence::calendar::CalendarError::Http(403, ref message)
            if message == "Derived calendar events are read-only"
    ));

    let (status, source_list) = command(&db, ORG, json!({"operation":"source.list"})).await;
    assert_eq!(status, 200);
    assert_eq!(source_list.as_array().unwrap().len(), 1);

    db.sql(&format!(
        "UPDATE agents SET runtime_config='{{\"heartbeat\":{{\"enabled\":true,\"intervalSec\":60}}}}'::jsonb,last_heartbeat_at=now() WHERE id='{CEO}';\
         INSERT INTO heartbeat_runs (org_id,agent_id,status,started_at,trigger_detail,context_snapshot) VALUES ('{ORG}','{CEO}','running',now()-interval '30 seconds','calendar test','{{}}'::jsonb);"
    )).await;
    let (status, derived) = command(
        &db,
        ORG,
        json!({"operation":"event.list","filters":event_window()}),
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        derived["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["id"].as_str().unwrap().starts_with("run:"))
    );
    assert!(derived["events"].as_array().unwrap().iter().any(|event| {
        event["id"]
            .as_str()
            .unwrap()
            .starts_with("projected-heartbeat:")
    }));

    const OWNER_USER: &str = "calendar-sidechat-owner";
    const OTHER_USER: &str = "calendar-sidechat-other";
    const OWNER_CHAT: &str = "71000000-0000-4000-8000-000000000001";
    const OTHER_CHAT: &str = "71000000-0000-4000-8000-000000000002";
    const NORMAL_CHAT: &str = "71000000-0000-4000-8000-000000000003";
    const OWNER_RUN: &str = "72000000-0000-4000-8000-000000000001";
    const OTHER_RUN: &str = "72000000-0000-4000-8000-000000000002";
    const NORMAL_RUN: &str = "72000000-0000-4000-8000-000000000003";
    sqlx::query("INSERT INTO chat_conversations (id,org_id,conversation_kind,created_by_user_id,status,side_chat_state,title) VALUES ($1::uuid,$4::uuid,'side_chat',$2,'resolved','completed','Owner completed SideChat'),($3::uuid,$5::uuid,'side_chat',$6,'resolved','completed','Other completed SideChat'),($7::uuid,$4::uuid,'chat',$2,'active',NULL,'Normal chat')")
        .bind(OWNER_CHAT)
        .bind(OWNER_USER)
        .bind(OTHER_CHAT)
        .bind(ORG)
        .bind(ORG)
        .bind(OTHER_USER)
        .bind(NORMAL_CHAT)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO heartbeat_runs (id,org_id,agent_id,status,started_at,trigger_detail,context_snapshot,chat_conversation_id) VALUES ($1::uuid,$2::uuid,$3::uuid,'running',now()-interval '20 seconds','owner private','{\"scene\":\"side_chat\"}'::jsonb,$4::uuid),($5::uuid,$2::uuid,$3::uuid,'running',now()-interval '20 seconds','other private','{\"scene\":\"side_chat\"}'::jsonb,$6::uuid),($7::uuid,$2::uuid,$3::uuid,'running',now()-interval '20 seconds','normal conversation','{\"scene\":\"chat\"}'::jsonb,$8::uuid)")
        .bind(OWNER_RUN)
        .bind(ORG)
        .bind(CEO)
        .bind(OWNER_CHAT)
        .bind(OTHER_RUN)
        .bind(OTHER_CHAT)
        .bind(NORMAL_RUN)
        .bind(NORMAL_CHAT)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut private_filter = event_window();
    private_filter["statuses"] = json!("in_progress");
    let (owner_status, owner_view) = execute_calendar(
        &db.pool,
        ORG,
        OWNER_USER,
        None,
        &json!({"operation":"event.list","filters":private_filter}),
    )
    .await
    .unwrap();
    let (other_status, other_view) = execute_calendar(
        &db.pool,
        ORG,
        OTHER_USER,
        None,
        &json!({"operation":"event.list","filters":private_filter}),
    )
    .await
    .unwrap();
    assert_eq!(owner_status, 200);
    assert_eq!(other_status, 200);
    let ids = |view: &Value| {
        view["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|event| event["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    };
    let owner_ids = ids(&owner_view);
    let other_ids = ids(&other_view);
    let has = |events: &[String], id: &str| events.iter().any(|event| event == id);
    assert!(has(&owner_ids, "run:72000000-0000-4000-8000-000000000001"));
    assert!(!has(&owner_ids, "run:72000000-0000-4000-8000-000000000002"));
    assert!(has(&owner_ids, "run:72000000-0000-4000-8000-000000000003"));
    assert!(!has(&other_ids, "run:72000000-0000-4000-8000-000000000001"));
    assert!(has(&other_ids, "run:72000000-0000-4000-8000-000000000002"));
    assert!(has(&other_ids, "run:72000000-0000-4000-8000-000000000003"));
    let (owner_detail_status, _) = execute_calendar(
        &db.pool,
        ORG,
        OWNER_USER,
        None,
        &json!({"operation":"event.detail","id":format!("run:{OWNER_RUN}")}),
    )
    .await
    .unwrap();
    let (other_detail_status, _) = execute_calendar(
        &db.pool,
        ORG,
        OTHER_USER,
        None,
        &json!({"operation":"event.detail","id":format!("run:{OWNER_RUN}")}),
    )
    .await
    .unwrap();
    let (normal_detail_status, normal_detail) = execute_calendar(
        &db.pool,
        ORG,
        OTHER_USER,
        None,
        &json!({"operation":"event.detail","id":format!("run:{NORMAL_RUN}")}),
    )
    .await
    .unwrap();
    assert_eq!(owner_detail_status, 200);
    assert_eq!(other_detail_status, 404);
    assert_eq!(normal_detail_status, 200);
    assert_eq!(normal_detail["heartbeatRunId"], NORMAL_RUN);

    let error = execute_calendar(
        &db.pool,
        ORG,
        "local-board",
        None,
        &json!({"operation":"event.create","input":{
            "eventKind":"human_event","ownerType":"user","title":"Wrong org",
            "startAt":"2026-10-08T17:00:00.000Z","endAt":"2026-10-08T18:00:00.000Z",
            "goalId":FOREIGN_GOAL
        }}),
    )
    .await
    .unwrap_err();
    match error {
        rudder_d1_persistence::calendar::CalendarError::Http(status, message) => {
            assert_eq!(status, 422);
            assert_eq!(message, "Goal must belong to same organization");
        }
        other => panic!("expected scoped reference validation error, got {other:?}"),
    }

    let (activity_count, outbox_count): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid),(SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid)",
    )
    .bind(ORG)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(activity_count, 6);
    assert_eq!(outbox_count, 6);

    let (status, deleted_source) = command(
        &db,
        ORG,
        json!({"operation":"source.delete","id":source_id}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(deleted_source["ok"], true);
    // Calendar changes emit their own activity while preserving unrelated
    // organization branding and mutation-receipt authority state.
    assert_eq!(db.name().await, initial_name);
    assert_eq!(db.brand_color().await, initial_brand_color);
    let final_counts = db.counts().await;
    assert_eq!(final_counts.0, initial_counts.0);
    assert_eq!(final_counts.1, activity_count + 1);
    assert_eq!(final_counts.2, initial_counts.2);
}
