use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Request {
    pub input: Command,
    pub audit_context: AuditContext,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct AuditContext {
    pub user_names: Vec<String>,
    pub home_dirs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Command {
    SavedViewList {
        query: ListQuery,
    },
    SavedViewGet {
        id: String,
    },
    SavedViewKeep {
        input: Keep,
    },
    SavedViewUpdate {
        id: String,
        patch: SavedPatch,
    },
    SavedViewDelete {
        id: String,
    },
    SavedViewReorder {
        ids: Vec<String>,
    },
    GroupCreate {
        name: String,
        icon: Option<String>,
    },
    GroupUpdate {
        #[serde(rename = "groupId")]
        group_id: String,
        patch: GroupPatch,
    },
    GroupDelete {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    GroupSeparate {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    GroupEntryRemove {
        #[serde(rename = "itemKey")]
        item_key: String,
    },
    ThreadUserState {
        #[serde(rename = "threadKey")]
        thread_key: String,
        pinned: Option<bool>,
    },
}
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct ListQuery {
    pub visibility: Option<Visibility>,
    pub limit: Option<u32>,
    pub offset: Option<u64>,
    pub primary_rail_pinned: Option<bool>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Visibility {
    Visible,
    Hidden,
    All,
}

// Option<Value> would collapse explicit null into omission. Preserve nullable
// patch fields with a dedicated missing/null/value representation.
#[derive(Debug, Default)]
pub(super) enum Nullable<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(d)? {
            Some(v) => Self::Value(v),
            None => Self::Null,
        })
    }
}
impl<T> Nullable<T> {
    pub fn present(&self) -> bool {
        !matches!(self, Self::Missing)
    }
    pub fn value(&self) -> Option<&T> {
        if let Self::Value(v) = self {
            Some(v)
        } else {
            None
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct SavedPatch {
    pub target: Option<Target>,
    pub title: Option<String>,
    #[serde(default)]
    pub subtitle: Nullable<String>,
    #[serde(default)]
    pub favicon: Nullable<String>,
    pub hidden: Option<bool>,
    pub primary_rail_pinned: Option<bool>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct GroupPatch {
    pub name: Option<String>,
    #[serde(default)]
    pub icon: Nullable<String>,
    pub collapsed: Option<bool>,
    pub pinned: Option<bool>,
    pub sort_order: Option<i32>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Keep {
    pub target: Target,
    pub title: String,
    pub subtitle: Option<String>,
    pub favicon: Option<String>,
    pub client_mutation_id: String,
    pub primary_rail_pinned: Option<bool>,
    pub placement: Placement,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Target {
    Browser {
        tab_id: String,
        url: String,
        view_instance_id: String,
    },
    Automation {
        automation_id: String,
        view_instance_id: String,
    },
    LibraryDocument {
        document_id: String,
        view_instance_id: String,
    },
    LibraryEntry {
        entry_id: String,
        path: String,
        view_instance_id: String,
    },
    LibraryFile {
        file_path: String,
        view_instance_id: String,
    },
    LibraryDirectory {
        directory_path: String,
        view_instance_id: String,
    },
    LocalApp {
        desktop_installation_id: String,
        app_public_id: String,
        local_binding_id: String,
        view_instance_id: String,
    },
}
impl Target {
    pub fn value(&self) -> Value {
        serde_json::to_value(self).expect("target serializes")
    }
    pub fn instance(&self) -> &str {
        match self {
            Self::Browser {
                view_instance_id, ..
            }
            | Self::Automation {
                view_instance_id, ..
            }
            | Self::LibraryDocument {
                view_instance_id, ..
            }
            | Self::LibraryEntry {
                view_instance_id, ..
            }
            | Self::LibraryFile {
                view_instance_id, ..
            }
            | Self::LibraryDirectory {
                view_instance_id, ..
            }
            | Self::LocalApp {
                view_instance_id, ..
            } => view_instance_id,
        }
    }
    pub fn canonical(&self) -> String {
        match self {
            Self::Browser { tab_id, .. } => format!("browser:{tab_id}"),
            Self::Automation { automation_id, .. } => format!("automation:{automation_id}"),
            Self::LibraryDocument { document_id, .. } => format!("library-document:{document_id}"),
            Self::LibraryEntry { entry_id, .. } => format!("library-entry:{entry_id}"),
            Self::LibraryFile { file_path, .. } => format!("library-file:{file_path}"),
            Self::LibraryDirectory { directory_path, .. } => {
                format!("library-directory:{directory_path}")
            }
            Self::LocalApp {
                desktop_installation_id,
                app_public_id,
                local_binding_id,
                ..
            } => format!(
                "local-app:{}",
                serde_json::json!([desktop_installation_id, app_public_id, local_binding_id])
            ),
        }
    }
    fn valid(&self) -> bool {
        if !text(self.instance(), 1, 1000) {
            return false;
        }
        match self {
            Self::Browser { tab_id, url, .. } => {
                text(tab_id, 1, 240)
                    && text(url, 1, 8192)
                    && url::Url::parse(url).is_ok_and(|u| {
                        matches!(u.scheme(), "http" | "https") && u.host_str().is_some()
                    })
            }
            Self::Automation { automation_id, .. } => uuid(automation_id),
            Self::LibraryDocument { document_id, .. } => uuid(document_id),
            Self::LibraryEntry { entry_id, path, .. } => uuid(entry_id) && portable(path, false),
            Self::LibraryFile { file_path, .. } => portable(file_path, false),
            Self::LibraryDirectory { directory_path, .. } => portable(directory_path, true),
            Self::LocalApp {
                desktop_installation_id,
                app_public_id,
                local_binding_id,
                ..
            } => [desktop_installation_id, app_public_id, local_binding_id]
                .iter()
                .all(|v| text(v, 1, 240)),
        }
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Placement {
    Loose,
    Group { group_id: String },
    Anchor { anchor: Anchor },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Anchor {
    Chat { conversation_id: String },
    Issue { issue_id: String },
}

pub(super) fn uuid(v: &str) -> bool {
    uuid::Uuid::parse_str(v).is_ok()
}
fn text(v: &str, min: usize, max: usize) -> bool {
    v == v.trim() && (min..=max).contains(&v.encode_utf16().count())
}
fn portable(v: &str, root: bool) -> bool {
    if root && v.is_empty() {
        return true;
    }
    text(v, 1, 4096)
        && !v.starts_with('/')
        && !v.contains('\\')
        && !v
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == ".." || s.starts_with('~'))
        && !v.split(':').next().is_some_and(|s| {
            v.contains(':')
                && !s.is_empty()
                && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        })
}
impl Request {
    pub fn validate(&self) -> bool {
        if self.audit_context.user_names.len() > 16
            || self.audit_context.home_dirs.len() > 64
            || self
                .audit_context
                .user_names
                .iter()
                .chain(&self.audit_context.home_dirs)
                .any(|s| s.len() > 8192)
        {
            return false;
        }
        match &self.input {
            Command::SavedViewList { query } => {
                query.limit.is_none_or(|n| (1..=100).contains(&n))
                    && query.offset.is_none_or(|n| n <= i64::MAX as u64)
            }
            Command::SavedViewGet { id } | Command::SavedViewDelete { id } => uuid(id),
            Command::SavedViewReorder { ids } => {
                ids.len() <= 500
                    && ids.iter().all(|id| uuid(id))
                    && ids.iter().collect::<HashSet<_>>().len() == ids.len()
            }
            Command::SavedViewKeep { input: k } => {
                k.target.valid()
                    && text(&k.title, 1, 240)
                    && k.subtitle.as_ref().is_none_or(|s| text(s, 0, 1000))
                    && k.favicon.as_ref().is_none_or(|s| text(s, 0, 65536))
                    && uuid(&k.client_mutation_id)
                    && k.primary_rail_pinned != Some(false)
                    && match &k.placement {
                        Placement::Loose => true,
                        Placement::Group { group_id } => uuid(group_id),
                        Placement::Anchor { anchor } => match anchor {
                            Anchor::Chat { conversation_id } => uuid(conversation_id),
                            Anchor::Issue { issue_id } => uuid(issue_id),
                        },
                    }
            }
            Command::SavedViewUpdate { id, patch: p } => {
                uuid(id)
                    && p.target.as_ref().is_none_or(Target::valid)
                    && p.title.as_ref().is_none_or(|s| text(s, 1, 240))
                    && p.subtitle.value().is_none_or(|s| text(s, 0, 1000))
                    && p.favicon.value().is_none_or(|s| text(s, 0, 65536))
                    && (p.target.is_some()
                        || p.title.is_some()
                        || p.subtitle.present()
                        || p.favicon.present()
                        || p.hidden.is_some()
                        || p.primary_rail_pinned.is_some())
            }
            Command::GroupCreate { name, icon } => {
                text(name, 1, 80) && icon.as_ref().is_none_or(|s| text(s, 1, 24))
            }
            Command::GroupUpdate { patch: p, .. } => {
                p.name.as_ref().is_none_or(|s| text(s, 1, 80))
                    && p.icon.value().is_none_or(|s| text(s, 1, 24))
                    && p.sort_order.is_none_or(|n| n >= 0)
            }
            Command::GroupDelete { .. } | Command::GroupSeparate { .. } => true,
            Command::GroupEntryRemove { .. } => true,
            Command::ThreadUserState { .. } => true,
        }
    }
}
