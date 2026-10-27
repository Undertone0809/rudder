use super::*;
#[test]
fn exact_twenty_one_entries_are_reserved_and_decode_static_case() {
    for (method, path) in [
        (Method::POST, "/api/orgs/o/messenger/saved-views/keep"),
        (Method::POST, "/api/orgs/o/messenger/saved-views"),
        (Method::PATCH, "/api/orgs/o/messenger/saved-views/reorder"),
        (Method::PATCH, "/api/orgs/o/messenger/saved-views/v"),
        (Method::DELETE, "/api/orgs/o/messenger/saved-views/v"),
        (Method::POST, "/api/orgs/o/messenger/groups"),
        (Method::PATCH, "/api/orgs/o/messenger/groups/g"),
        (Method::POST, "/api/orgs/o/messenger/groups/g/separate"),
        (Method::DELETE, "/api/orgs/o/messenger/groups/g"),
        (
            Method::DELETE,
            "/api/orgs/o/messenger/groups/entries/chat%3Aid",
        ),
        (
            Method::POST,
            "/api/orgs/o/messenger/threads/chat%3Aid/user-state",
        ),
        (Method::POST, "/api/issues/id/follow"),
        (Method::DELETE, "/api/issues/id/follow"),
        (Method::POST, "/api/orgs/o/messenger/groups/merge"),
        (Method::PATCH, "/api/orgs/o/messenger/groups/reorder"),
        (Method::POST, "/api/orgs/o/messenger/groups/g/entries"),
        (
            Method::PATCH,
            "/api/orgs/o/messenger/groups/g/entries/reorder",
        ),
        (
            Method::POST,
            "/api/orgs/o/messenger/groups/g/title/regenerate",
        ),
        (Method::POST, "/api/orgs/o/messenger/threads/chat%3Aid/read"),
        (Method::POST, "/api/orgs/o/messenger/unreads/dismiss"),
        (Method::POST, "/api/issues/id/read"),
    ] {
        assert!(is_reserved_path(path, &method), "{method} {path}");
        assert!(is_reserved_path(
            &format!("{}/", path.to_uppercase()),
            &method
        ));
        assert!(!is_reserved_path(path, &Method::GET));
        assert!(!is_reserved_path(path, &Method::HEAD));
    }
    assert_eq!(decode("org%2Done").unwrap(), "org-one");
    assert!(!is_reserved_path("/api/issues/id/approvals", &Method::POST));
    assert!(!is_reserved_path(
        "/api/orgs/o/messenger/groups/g/entries/extra",
        &Method::POST
    ));
}
#[test]
fn public_normalization_matches_current_node_schema_goldens() {
    let cases: Value = serde_json::from_str(include_str!("validation-cases.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let result = validation::normalize(
            case["operation"].as_str().unwrap(),
            if case["missing"] == true {
                None
            } else {
                Some(&case["raw"])
            },
        );
        if case["ok"] == true {
            assert_eq!(result.unwrap(), case["value"], "{}", case["name"]);
        } else {
            assert_eq!(result.unwrap_err(), case["issues"], "{}", case["name"]);
        }
    }
}
