use super::*;
use rudder_d1_persistence::issue_comments::{
    IssueCommentActor, IssueCommentError, IssueCommentWrite,
    apply_issue_comment_write_with_native_auth, read_issue_comment_with_native_auth,
    read_issue_comments_with_native_auth,
};

struct CommentRequestContext {
    pool: sqlx::PgPool,
    identity: NativeIngressIdentity,
    actor: ActorIdentity,
    session_id: String,
    run_id: Option<String>,
    issue_id: String,
    org_id: String,
}

#[allow(clippy::result_large_err)]
async fn comment_request_context(
    state: &IngressState,
    request: &HttpRequest,
    issue_ref: &str,
) -> Result<CommentRequestContext, HttpResponse> {
    let (identity, actor, session_id, run_id) = public_issue_actor(state, request).await?;
    let Some(pool) = super::configured_pool(state).cloned() else {
        return Err(unavailable());
    };
    let lookup = super::resolve_issue_path_reference(
        &pool,
        issue_ref,
        super::actor_org_id(&identity),
        (actor.kind == "user").then_some(actor.id.as_str()),
        matches!(&identity, NativeIngressIdentity::LocalImplicit),
    )
    .await
    .map_err(|error| {
        tracing::warn!(%error, issue_ref, "Issue comment identity lookup failed");
        internal_error()
    })?;
    let (issue_id, org_id) = match lookup {
        super::IssuePathLookup::Found { issue_id, org_id } => (issue_id, org_id),
        super::IssuePathLookup::Missing => return Err(not_found("Issue not found")),
        super::IssuePathLookup::Ambiguous => {
            return Err(HttpResponse::Conflict().json(json!({
                "error":"Issue ID short reference is ambiguous in this organization. Use a longer typed ref."
            })));
        }
        super::IssuePathLookup::Invalid => {
            return Err(HttpResponse::UnprocessableEntity().json(json!({
                "error":"Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference"
            })));
        }
    };
    Ok(CommentRequestContext {
        pool,
        identity,
        actor,
        session_id,
        run_id,
        issue_id,
        org_id,
    })
}

pub(super) async fn list(
    state: web::Data<IngressState>,
    request: HttpRequest,
    issue_ref: &str,
) -> HttpResponse {
    let context = match comment_request_context(&state, &request, issue_ref).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(authorizer) = agent_core::native_authorizer(
        &context.identity,
        &context.actor,
        &context.session_id,
        &state,
    ) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let after = query_string_value(request.query_string(), "after")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            query_string_value(request.query_string(), "afterCommentId")
                .filter(|value| !value.trim().is_empty())
        });
    let order = query_string_value(request.query_string(), "order").unwrap_or_default();
    let limit = query_string_value(request.query_string(), "limit")
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor().min(500.0) as i64);
    match read_issue_comments_with_native_auth(
        &context.pool,
        &context.org_id,
        &context.issue_id,
        after.as_deref(),
        &order,
        limit,
        &authorizer,
    )
    .await
    {
        Ok(comments) => HttpResponse::Ok().json(comments),
        Err(error) => comment_error(error),
    }
}

pub(super) async fn get(
    state: web::Data<IngressState>,
    request: HttpRequest,
    issue_ref: &str,
    comment_ref: &str,
) -> HttpResponse {
    let context = match comment_request_context(&state, &request, issue_ref).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(authorizer) = agent_core::native_authorizer(
        &context.identity,
        &context.actor,
        &context.session_id,
        &state,
    ) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    match read_issue_comment_with_native_auth(
        &context.pool,
        &context.org_id,
        &context.issue_id,
        comment_ref,
        &authorizer,
    )
    .await
    {
        Ok(comment) => HttpResponse::Ok().json(comment),
        Err(error) => comment_error(error),
    }
}

pub(super) async fn create(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    issue_ref: &str,
) -> HttpResponse {
    let context = match comment_request_context(&state, &request, issue_ref).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(authorizer) = agent_core::native_authorizer(
        &context.identity,
        &context.actor,
        &context.session_id,
        &state,
    ) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(mut input) = parse_json_object(body) else {
        return HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid comment body"}));
    };
    if context.actor.kind == "agent"
        && let Some(comment_body) = input.get("body").and_then(Value::as_str)
        && let Ok(workspace_root) = agent_core::organization_workspace_root(&context.org_id)
    {
        input["body"] = Value::String(normalize_local_library_path_markdown(
            comment_body,
            std::path::Path::new(&workspace_root),
        ));
    }
    let comment_actor = IssueCommentActor {
        kind: &context.actor.kind,
        id: &context.actor.id,
        agent_id: (context.actor.kind == "agent").then_some(context.actor.id.as_str()),
        run_id: (context.actor.kind == "agent")
            .then_some(context.run_id.as_deref())
            .flatten(),
    };
    match apply_issue_comment_write_with_native_auth(
        &context.pool,
        &context.org_id,
        &context.issue_id,
        None,
        IssueCommentWrite::Create,
        comment_actor,
        &input,
        &authorizer,
    )
    .await
    {
        Ok(comment) => HttpResponse::Created().json(comment),
        Err(error) => comment_error(error),
    }
}

pub(super) async fn update(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    issue_ref: &str,
    comment_ref: &str,
) -> HttpResponse {
    let context = match comment_request_context(&state, &request, issue_ref).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    if context.actor.kind != "user" {
        return HttpResponse::Forbidden().json(json!({"error":"Board access required"}));
    }
    let Some(authorizer) = agent_core::native_authorizer(
        &context.identity,
        &context.actor,
        &context.session_id,
        &state,
    ) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(input) = parse_json_object(body) else {
        return HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid comment body"}));
    };
    match apply_issue_comment_write_with_native_auth(
        &context.pool,
        &context.org_id,
        &context.issue_id,
        Some(comment_ref),
        IssueCommentWrite::Update,
        IssueCommentActor {
            kind: &context.actor.kind,
            id: &context.actor.id,
            agent_id: None,
            run_id: None,
        },
        &input,
        &authorizer,
    )
    .await
    {
        Ok(comment) => HttpResponse::Ok().json(comment),
        Err(error) => comment_error(error),
    }
}

pub(super) async fn delete(
    state: web::Data<IngressState>,
    request: HttpRequest,
    issue_ref: &str,
    comment_ref: &str,
) -> HttpResponse {
    let context = match comment_request_context(&state, &request, issue_ref).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    if context.actor.kind != "user" {
        return HttpResponse::Forbidden().json(json!({"error":"Board access required"}));
    }
    let Some(authorizer) = agent_core::native_authorizer(
        &context.identity,
        &context.actor,
        &context.session_id,
        &state,
    ) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    match apply_issue_comment_write_with_native_auth(
        &context.pool,
        &context.org_id,
        &context.issue_id,
        Some(comment_ref),
        IssueCommentWrite::Delete,
        IssueCommentActor {
            kind: &context.actor.kind,
            id: &context.actor.id,
            agent_id: None,
            run_id: None,
        },
        &json!({}),
        &authorizer,
    )
    .await
    {
        Ok(comment) => HttpResponse::Ok().json(comment),
        Err(error) => comment_error(error),
    }
}

fn query_string_value(query: &str, key: &str) -> Option<String> {
    let values = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
        .collect::<Vec<_>>();
    (values.len() == 1)
        .then(|| values.into_iter().next())
        .flatten()
}

fn normalize_local_library_path_markdown(
    markdown: &str,
    workspace_root: &std::path::Path,
) -> String {
    let root = lexical_path(workspace_root);
    let root_text = root.to_string_lossy();
    if markdown.trim().is_empty() || !markdown.contains(root_text.as_ref()) {
        return markdown.to_owned();
    }
    split_markdown_code(markdown).into_iter().fold(
        String::new(),
        |mut output, (segment, protected)| {
            let segment = if protected {
                segment
            } else {
                let linked = normalize_markdown_link_paths(&segment, &root);
                normalize_bare_library_paths(&linked, &root)
            };
            output.push_str(&segment);
            output
        },
    )
}

fn split_markdown_code(markdown: &str) -> Vec<(String, bool)> {
    let mut segments = Vec::new();
    let mut cursor = 0;
    let mut plain_start = 0;
    while cursor < markdown.len() {
        let tail = &markdown[cursor..];
        let (marker, inline_ticks) = if tail.starts_with("```") {
            (Some("```"), None)
        } else if tail.starts_with("~~~") {
            (Some("~~~"), None)
        } else if tail.starts_with('`') {
            let run_length = tail.bytes().take_while(|byte| *byte == b'`').count();
            (Some("`"), Some(run_length))
        } else {
            (None, None)
        };
        let Some(marker) = marker else {
            let ch = tail.chars().next().expect("cursor is inside string");
            cursor += ch.len_utf8();
            continue;
        };
        if plain_start < cursor {
            segments.push((markdown[plain_start..cursor].to_owned(), false));
        }
        let opening_end = cursor + inline_ticks.unwrap_or(marker.len());
        let closing = if marker == "`" {
            let rest = &markdown[opening_end..];
            let line_len = rest.find('\n').unwrap_or(rest.len());
            rest[..line_len]
                .find('`')
                .map(|offset| {
                    let closing_start = opening_end + offset;
                    let closing_run = markdown[closing_start..]
                        .bytes()
                        .take_while(|byte| *byte == b'`')
                        .count();
                    closing_start + closing_run
                })
                .or_else(|| Some(opening_end + line_len))
        } else {
            markdown[opening_end..]
                .find(marker)
                .map(|offset| opening_end + offset + marker.len())
        };
        let protected_end = closing.unwrap_or(markdown.len());
        segments.push((markdown[cursor..protected_end].to_owned(), true));
        cursor = protected_end;
        plain_start = cursor;
    }
    if plain_start < markdown.len() {
        segments.push((markdown[plain_start..].to_owned(), false));
    }
    segments
}

fn normalize_markdown_link_paths(markdown: &str, root: &std::path::Path) -> String {
    let mut output = String::with_capacity(markdown.len());
    let mut cursor = 0;
    while let Some(link_end_start) = markdown[cursor..].find("](") {
        let close = cursor + link_end_start;
        let Some(open) = markdown[cursor..close]
            .rfind('[')
            .map(|offset| cursor + offset)
        else {
            output.push_str(&markdown[cursor..close + 2]);
            cursor = close + 2;
            continue;
        };
        let is_image = open > cursor && markdown.as_bytes()[open - 1] == b'!';
        let Some(end_offset) = markdown[close + 2..].find(')') else {
            break;
        };
        let end = close + 2 + end_offset;
        if markdown[close + 2..end].contains('\n') {
            output.push_str(&markdown[cursor..close + 2]);
            cursor = close + 2;
            continue;
        }
        output.push_str(&markdown[cursor..open]);
        let label = &markdown[open + 1..close];
        let href = &markdown[close + 2..end];
        if is_image {
            output.push_str(&markdown[open..end + 1]);
        } else if let Some((relative, basename)) = local_library_file(href, root) {
            let label = if label.trim().is_empty() {
                escape_markdown_label(&basename)
            } else {
                label.to_owned()
            };
            output.push('[');
            output.push_str(&label);
            output.push_str("](");
            output.push_str(&library_file_href(&relative));
            output.push(')');
        } else {
            output.push_str(&markdown[open..end + 1]);
        }
        cursor = end + 1;
    }
    output.push_str(&markdown[cursor..]);
    output
}

fn normalize_bare_library_paths(markdown: &str, root: &std::path::Path) -> String {
    let root_text = root.to_string_lossy();
    let mut output = String::with_capacity(markdown.len());
    let mut cursor = 0;
    loop {
        let next_root = markdown[cursor..]
            .find(root_text.as_ref())
            .map(|offset| cursor + offset);
        let next_link = markdown[cursor..].find("](").and_then(|offset| {
            let close_bracket = cursor + offset;
            let open_bracket = markdown[cursor..close_bracket]
                .rfind('[')
                .map(|offset| cursor + offset)?;
            let href_start = close_bracket + 2;
            let relative_end = markdown[href_start..].find(')')?;
            let end = href_start + relative_end;
            if markdown[href_start..end].contains('\n') {
                return None;
            }
            Some((open_bracket, end + 1))
        });
        if let Some((link_start, link_end)) = next_link
            && next_root.is_none_or(|root_start| link_start <= root_start)
        {
            output.push_str(&markdown[cursor..link_end]);
            cursor = link_end;
            continue;
        }
        let Some(start) = next_root else {
            output.push_str(&markdown[cursor..]);
            break;
        };
        output.push_str(&markdown[cursor..start]);
        let mut end = start + root_text.len();
        if markdown
            .as_bytes()
            .get(end)
            .is_none_or(|byte| !std::path::is_separator(char::from(*byte)))
        {
            output.push_str(&markdown[start..end]);
            cursor = end;
            continue;
        }
        while end < markdown.len()
            && !markdown.as_bytes()[end].is_ascii_whitespace()
            && !b"<>()[]{}'\"".contains(&markdown.as_bytes()[end])
        {
            end += 1;
        }
        let raw = &markdown[start..end];
        let trailing_len = raw
            .chars()
            .rev()
            .take_while(|ch| ".,;:!?".contains(*ch))
            .map(char::len_utf8)
            .sum::<usize>();
        let candidate = &raw[..raw.len() - trailing_len];
        if let Some((relative, basename)) = local_library_file(candidate, root) {
            output.push('[');
            output.push_str(&escape_markdown_label(&basename));
            output.push_str("](");
            output.push_str(&library_file_href(&relative));
            output.push(')');
            output.push_str(&raw[raw.len() - trailing_len..]);
        } else {
            output.push_str(raw);
        }
        cursor = end;
    }
    output
}

fn local_library_file(href: &str, root: &std::path::Path) -> Option<(String, String)> {
    let href = href.trim();
    if href.starts_with("library-file://") || href.starts_with("library-entry://") {
        return None;
    }
    let href = href
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix('>'))
        .unwrap_or(href);
    let decoded = percent_encoding::percent_decode_str(href)
        .decode_utf8_lossy()
        .into_owned();
    let candidate = lexical_path(std::path::Path::new(&decoded));
    let relative = candidate.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() || !candidate.is_file() {
        return None;
    }
    let portable = relative.to_string_lossy().replace('\\', "/");
    let basename = candidate.file_name()?.to_string_lossy().into_owned();
    Some((portable, basename))
}

fn lexical_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut normalized = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn escape_markdown_label(label: &str) -> String {
    label
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn library_file_href(path: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("p", path)
        .finish();
    format!("library-file://file?{query}")
}

fn comment_error(error: IssueCommentError) -> HttpResponse {
    match error {
        IssueCommentError::Http(status, message) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        IssueCommentError::HttpDetails(status, message, details) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message,"comment":details})),
        IssueCommentError::OwnershipRejected(status, message, _) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        IssueCommentError::Store(error) => {
            super::issue_core_read_error(IssueCoreReadError::Store(error))
        }
        IssueCommentError::Database(error) => {
            tracing::warn!(%error, "public Issue comment database operation failed");
            internal_error()
        }
        IssueCommentError::Json(error) => {
            tracing::warn!(%error, "public Issue comment JSON projection failed");
            internal_error()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_local_library_path_markdown;
    #[test]
    fn agent_comment_paths_are_normalized_outside_markdown_code() {
        let root = tempfile::tempdir().unwrap();
        let report = root.path().join("docs/product brief.md");
        std::fs::create_dir_all(report.parent().unwrap()).unwrap();
        std::fs::write(&report, "report").unwrap();
        let bare = root.path().join("bare.md");
        std::fs::write(&bare, "bare").unwrap();
        let image = root.path().join("image.png");
        std::fs::write(&image, "image").unwrap();

        let markdown = format!(
            "Summary: [report]({}) {} `{} ` and ``{}``\n\n```text\n{}\n```\n![image]({})",
            report.display(),
            bare.display(),
            report.display(),
            report.display(),
            report.display(),
            image.display(),
        );
        let normalized = normalize_local_library_path_markdown(&markdown, root.path());
        let expected_report = "library-file://file?p=docs%2Fproduct+brief.md";

        assert!(normalized.contains(&format!("[report]({expected_report})")));
        assert!(normalized.contains("[bare.md](library-file://file?p=bare.md)"));
        assert_eq!(normalized.matches("Summary: ").count(), 1);
        assert_eq!(normalized.matches("[report](").count(), 1);
        assert!(normalized.contains(&format!("`{} `", report.display())));
        assert!(normalized.contains(&format!("``{}``", report.display())));
        assert!(normalized.contains(&format!("```text\n{}\n```", report.display())));
        assert!(normalized.contains(&format!("![image]({})", image.display())));
    }
}
