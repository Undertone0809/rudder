use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use projection::preview;

pub(super) async fn read(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    limit: Option<u32>,
    cursor: Option<&str>,
    include_detail: bool,
) -> Result<Value> {
    let entries = rows(
        tx,
        &include_str!("issue_entries.sql").replace(
            "/* VISIBLE_EXECUTION */",
            &crate::run_visibility::predicate("active_execution_run", 2),
        ),
        &[c.org, c.user],
    )
    .await?;
    let last = state(tx, c, "issues").await?["lastReadAt"].clone();
    let states=rows(tx,"SELECT (to_jsonb(s)||jsonb_build_object('_lastReadRaw',s.last_read_at))::text FROM messenger_thread_user_states s WHERE org_id=$1::uuid AND user_id=$2 AND thread_key LIKE 'issue:%'",&[c.org,c.user]).await?;
    let mut count = 0;
    for entry in &entries {
        let own = states
            .iter()
            .find(|s| text(s, "threadKey") == format!("issue:{}", text(entry, "id")));
        let attention = nanos(&entry["_attentionRaw"]);
        if attention.is_some_and(|at| {
            millis(&last).is_none_or(|read| at > read * 1_000_000)
                && own
                    .and_then(|s| nanos(&s["_lastReadRaw"]))
                    .is_none_or(|read| at > read)
        }) {
            count += 1
        }
    }
    let mut summary_preview = Value::Null;
    if let Some(entry) = entries.first() {
        summary_preview = attention_preview(entry, c);
        if summary_preview.is_null() {
            summary_preview =
                issue_preview(entry, Some(&activity_preview(entry, "latestActivity", c)));
        }
    }
    let summary = summary(
        "issues",
        "Issues",
        entries.len(),
        entries
            .first()
            .map(|e| e["latestActivityAt"].clone())
            .unwrap_or(Value::Null),
        last,
        count,
        "No tracked issues yet",
        summary_preview,
    );
    let mut data = json!({"summary":summary,"itemCount":entries.len(),"_entries":entries});
    if include_detail {
        let mut selected = data["_entries"].as_array().unwrap().clone();
        if let Some(raw) = cursor.filter(|s| !s.is_empty()) {
            let cursor = ordering::decode(raw)
                .filter(|v| millis(&v["activityAt"]).is_some() && !text(v, "issueId").is_empty())
                .ok_or_else(|| http(409, "Messenger issues cursor is invalid or expired"))?;
            let at = millis(&cursor["activityAt"]).unwrap();
            let id = text(&cursor, "issueId");
            selected.retain(|entry| {
                let stamp = entry
                    .get("_activityCursorRaw")
                    .unwrap_or(&entry["latestActivityAt"]);
                let ns = stamp
                    .as_str()
                    .and_then(|s| {
                        time::OffsetDateTime::parse(
                            s,
                            &time::format_description::well_known::Rfc3339,
                        )
                        .ok()
                    })
                    .map(|d| d.unix_timestamp_nanos());
                ns.is_some_and(|ns| {
                    ns < at * 1_000_000 || (ns == at * 1_000_000 && text(entry, "id") > id)
                })
            });
        }
        let limit = limit.unwrap_or(50).clamp(1, 100) as usize;
        let more = selected.len() > limit;
        selected.truncate(limit);
        let next = if more {
            selected.last().map(|e| {
                URL_SAFE_NO_PAD.encode(
                    json!({"activityAt":e["latestActivityAt"],"issueId":e["id"]}).to_string(),
                )
            })
        } else {
            None
        };
        let mut cards = Vec::new();
        for entry in selected {
            cards.push(card(tx, c, &entry).await?)
        }
        cards.sort_by(|a, b| {
            millis(&a["latestActivityAt"])
                .cmp(&millis(&b["latestActivityAt"]))
                .then_with(|| c.collator.compare(text(a, "id"), text(b, "id")))
        });
        let mut detail = projection::detail(
            &data["summary"],
            "Followed issues, issues I created, issues assigned to me, and issues ready for my review",
            cards,
        );
        detail["pageInfo"] = json!({"limit":limit,"nextCursor":next,"hasMore":more});
        data["detail"] = detail;
    }
    Ok(data)
}
fn body(entry: &Value, c: &Context<'_>) -> String {
    let mut flags = Vec::new();
    if truth(entry, "followed") {
        flags.push("followed")
    }
    if text(entry, "createdByUserId") == c.user {
        flags.push("created by me")
    }
    if text(entry, "assigneeUserId") == c.user {
        flags.push("assigned to me")
    }
    if text(entry, "reviewerUserId") == c.user && text(entry, "status") == "in_review" {
        flags.push("review requested")
    }
    let mut result = [
        text(entry, "status").replace('_', " "),
        text(entry, "priority").replace('_', " "),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    if !flags.is_empty() {
        result.push_str(&format!(" · {}", flags.join(" · ")))
    }
    result
}
fn issue_preview(entry: &Value, preview_text: Option<&Value>) -> Value {
    let label = if text(entry, "identifier").is_empty() {
        text(entry, "title").to_owned()
    } else {
        format!("{} · {}", text(entry, "identifier"), text(entry, "title"))
    };
    let normalized = preview(preview_text.and_then(Value::as_str), 120);
    normalized
        .as_str()
        .filter(|p| *p != label)
        .map(|p| preview(Some(&format!("{label} — {p}")), 180))
        .unwrap_or_else(|| preview(Some(&label), 180))
}
fn activity_preview(entry: &Value, prefix: &str, c: &Context<'_>) -> Value {
    let action = text(entry, &format!("{prefix}Action"));
    let details = &entry[format!("{prefix}Details")];
    let value = match action {
        "issue.updated" => {
            if let Some(status) = details["status"].as_str() {
                match status {
                    "done" => "Completed".into(),
                    "cancelled" => "Cancelled".into(),
                    _ => format!("Status changed to {}", status.replace('_', " ")),
                }
            } else if details.get("assigneeUserId").is_some()
                || details.get("assigneeAgentId").is_some()
            {
                "Assignment changed".into()
            } else if details.get("reviewerUserId").is_some()
                || details.get("reviewerAgentId").is_some()
            {
                "Reviewer changed".into()
            } else {
                object_keys(details)
                    .into_iter()
                    .find(|key| {
                        ![
                            "identifier",
                            "issueIdentifier",
                            "_previous",
                            "_references",
                            "source",
                            "reopened",
                            "reopenedFrom",
                            "normalizedFromStatus",
                            "normalizedReason",
                            "executionWorkspaceId",
                            "executionWorkspacePreference",
                            "executionWorkspaceSettings",
                            "currentExecutionWorkspace",
                            "runWorkspaceId",
                            "runWorkspacePreference",
                            "runWorkspaceSettings",
                            "currentRunWorkspace",
                        ]
                        .contains(key)
                    })
                    .map(|key| format!("{} changed", humanize(key)))
                    .unwrap_or_else(|| "Issue details changed".into())
            }
        }
        "issue.followed" => "Followed".into(),
        "automation.issue_created_notification" => "Automation created issue".into(),
        "agent.issue_created_notification" => "Agent created issue".into(),
        "issue.approval_linked" => "Approval linked".into(),
        "issue.work_product_created" => "Work product created".into(),
        "issue.work_product_updated" => "Work product updated".into(),
        "issue.work_product_deleted" => "Work product removed".into(),
        "issue.attachment_added" => "Attachment added".into(),
        "issue.attachment_removed" => "Attachment removed".into(),
        "issue.document_deleted" => "Document removed".into(),
        "heartbeat.cancelled" => "Run cancelled".into(),
        "heartbeat.retried" => "Run retried".into(),
        "" => body(entry, c),
        _ => format!("{} updated", text(entry, "title")),
    };
    json!(value)
}
fn humanize(key: &str) -> String {
    match key {
        "assigneeAgentId" | "assigneeUserId" => "assignee".into(),
        "reviewerAgentId" | "reviewerUserId" => "reviewer".into(),
        "executionWorkspaceId" => "run workspace".into(),
        "executionWorkspacePreference" => "run workspace preference".into(),
        "executionWorkspaceSettings" => "run workspace settings".into(),
        "assigneeAgentRuntimeOverrides" => "assignee runtime overrides".into(),
        "parentId" => "parent issue".into(),
        "hiddenAt" => "visibility".into(),
        "labelIds" => "labels".into(),
        _ => {
            let key = key.trim_end_matches("Id");
            let mut result = String::new();
            for ch in key.chars() {
                if ch.is_uppercase() {
                    result.push(' ');
                    result.extend(ch.to_lowercase())
                } else {
                    result.push(ch)
                }
            }
            result
        }
    }
}
fn attention_preview(entry: &Value, c: &Context<'_>) -> Value {
    if entry["attentionActivityAt"].is_null() {
        return Value::Null;
    }
    let comment = millis(&entry["latestExternalCommentCreatedAt"]);
    let activity = millis(&entry["latestExternalActivityCreatedAt"]);
    let value = if comment.is_some() && comment >= activity {
        preview(entry["latestExternalCommentBody"].as_str(), 140)
    } else if !text(entry, "latestExternalActivityId").is_empty() {
        activity_preview(entry, "latestExternalActivity", c)
    } else {
        json!(body(entry, c))
    };
    issue_preview(entry, Some(&value))
}
pub(super) async fn card(tx: &mut Tx<'_>, c: &Context<'_>, entry: &Value) -> Result<Value> {
    let comments=rows(tx,"SELECT (to_jsonb(m)||jsonb_build_object('author_agent_name',a.name,'author_user_name',u.name))::text FROM issue_comments m LEFT JOIN agents a ON a.id=m.author_agent_id AND a.org_id=m.org_id LEFT JOIN \"user\" u ON u.id=m.author_user_id WHERE m.org_id=$1::uuid AND m.issue_id=$3::uuid AND m.deleted_at IS NULL AND (m.author_user_id IS NULL OR m.author_user_id<>$2) ORDER BY m.created_at DESC,m.id DESC LIMIT 1",&[c.org,c.user,text(entry,"id")]).await?;
    let comment = comments.first().filter(|comment| {
        millis(&comment["createdAt"]) >= millis(&entry["latestActivityCreatedAt"])
    });
    let preview = comment
        .map(|comment| projection::preview(comment["body"].as_str(), 140))
        .unwrap_or_else(|| {
            if text(entry, "latestActivityId").is_empty() {
                Value::Null
            } else {
                activity_preview(entry, "latestActivity", c)
            }
        });
    let body = preview
        .clone()
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| body(entry, c));
    let id = text(entry, "id");
    let reference = entry["identifier"].as_str().unwrap_or(id);
    let title = if text(entry, "identifier").is_empty() {
        text(entry, "title").to_owned()
    } else {
        format!("{} · {}", text(entry, "identifier"), text(entry, "title"))
    };
    let label = comment.map(|comment| {
        if !text(comment, "authorAgentId").is_empty() {
            string(comment, "authorAgentName")
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "Agent {}",
                        projection::short("agt", text(comment, "authorAgentId"))
                    )
                })
        } else if !text(comment, "authorUserId").is_empty() {
            if text(comment, "authorUserId") == c.user {
                "You".into()
            } else {
                string(comment, "authorUserName")
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| {
                        format!(
                            "User {}",
                            projection::short("usr", text(comment, "authorUserId"))
                        )
                    })
            }
        } else {
            "System".into()
        }
    });
    let mut metadata = json!({"issueId":id,"issueIdentifier":entry["identifier"],"status":entry["status"],"priority":entry["priority"],"followed":truth(entry,"followed"),"createdByMe":text(entry,"createdByUserId")==c.user,"assignedToMe":text(entry,"assigneeUserId")==c.user,"reviewerForMe":text(entry,"reviewerUserId")==c.user&&text(entry,"status")=="in_review"});
    if truth(entry, "hasActiveExecutionRun") && !text(entry, "executionRunId").is_empty() {
        metadata["activeExecutionRunId"] = entry["executionRunId"].clone()
    }
    if !text(entry, "assigneeAgentId").is_empty() {
        metadata["assigneeAgentId"] = entry["assigneeAgentId"].clone()
    }
    if !text(entry, "projectId").is_empty() {
        metadata["projectId"] = entry["projectId"].clone();
        metadata["projectName"] = entry["projectName"]
            .as_str()
            .map(|s| json!(s))
            .unwrap_or_else(|| entry["projectId"].clone());
        metadata["projectColor"] = entry["projectColor"].clone()
    }
    if let Some(comment) = comment {
        metadata["sourceCommentAuthorKind"] =
            json!(if !text(comment, "authorAgentId").is_empty() {
                "agent"
            } else if !text(comment, "authorUserId").is_empty() {
                "user"
            } else {
                "system"
            });
        metadata["sourceCommentByMe"] = json!(text(comment, "authorUserId") == c.user);
        metadata["sourceCommentAuthorLabel"] = json!(label)
    }
    let activity = &entry["latestActivityDetails"];
    let status_allowed = comment.is_none_or(|comment| {
        text(activity, "source") == "comment"
            && millis(&comment["createdAt"])
                .zip(millis(&entry["latestActivityCreatedAt"]))
                .is_some_and(|(a, b)| (a - b).abs() <= 5000)
    });
    if status_allowed
        && text(entry, "latestActivityAction") == "issue.updated"
        && activity["status"].is_string()
    {
        metadata["statusChange"] =
            json!({"from":activity["_previous"]["status"],"to":activity["status"]})
    }
    Ok(
        json!({"id":id,"threadKey":"issues","kind":"issues","title":title,"subtitle":body,"body":body,"preview":preview,"href":format!("/issues/{reference}"),"latestActivityAt":entry["latestActivityAt"],"actions":[action("Open issue",json!(format!("/issues/{reference}")),"GET"),action("Quick comment",json!(format!("/issues/{reference}/comments")),"POST")],"metadata":metadata,"issueId":id,"issueIdentifier":entry["identifier"],"sourceCommentId":comment.map(|v|v["id"].clone()),"sourceCommentAuthorLabel":label,"sourceCommentBody":comment.map(|v|v["body"].clone())}),
    )
}
pub(super) async fn split(tx: &mut Tx<'_>, c: &Context<'_>, data: &Value) -> Result<Vec<Value>> {
    let mut items = Vec::new();
    for entry in data["_entries"].as_array().into_iter().flatten().take(100) {
        let card = card(tx, c, entry).await?;
        let key = format!("issue:{}", text(entry, "id"));
        let state = state(tx, c, &key).await?;
        let last = latest(&[&data["summary"]["lastReadAt"], &state["lastReadAt"]]);
        let unread = millis(&entry["attentionActivityAt"])
            .is_some_and(|at| millis(&last).is_none_or(|read| at > read));
        let mut metadata = card["metadata"].clone();
        metadata["splitIssue"] = json!(true);
        metadata["description"] = entry["description"].clone();
        items.push(json!({"threadKey":key,"kind":"issues","title":card["title"],"subtitle":card["subtitle"],"preview":card["preview"].as_str().map(|v|json!(v)).unwrap_or_else(||card["body"].clone()),"latestActivityAt":card["latestActivityAt"],"lastReadAt":last,"unreadCount":usize::from(unread),"needsAttention":unread,"isPinned":!state["pinnedAt"].is_null(),"href":format!("/messenger/issues/{}{}",entry["identifier"].as_str().unwrap_or(text(entry,"id")),card["sourceCommentId"].as_str().map(|id|format!("#comment-{id}")).unwrap_or_default()),"metadata":metadata}));
    }
    Ok(items)
}
