use super::{
    groups,
    protocol::{Anchor, Keep, Placement, Target},
    saved_views,
    store::*,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn conflict(message: &'static str) -> Error {
    Error::Http(409, message)
}
fn fingerprint(k: &Keep) -> String {
    let mut value = json!({"version":if k.primary_rail_pinned==Some(true){2}else{1},"target":k.target.value(),"title":k.title,"subtitle":k.subtitle,"favicon":k.favicon,"placement":k.placement});
    if k.primary_rail_pinned == Some(true) {
        value["primaryRailPinned"] = json!(true);
    }
    // serde_json's default map is key-sorted. All schema field names are ASCII,
    // so this is the existing stableJson + SHA256 durable receipt fingerprint.
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
async fn by_identity(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    identity: &str,
    by_mutation: bool,
) -> Result<Option<Value>> {
    let filter = if by_mutation {
        "client_mutation_id=$3::uuid"
    } else {
        "instance_id=$3"
    };
    let raw=sqlx::query_scalar::<_,String>(&format!("SELECT ({})::text FROM messenger_saved_views v WHERE org_id=$1::uuid AND user_id=$2 AND {filter} LIMIT 1",saved_views::PROJECTION))
        .bind(s.org).bind(s.user).bind(identity).fetch_optional(&mut **tx).await?;
    raw.as_deref().map(decode).transpose()
}
async fn receipt(tx: &mut Tx<'_>, s: &Scope<'_>, k: &Keep, fp: &str) -> Result<Option<String>> {
    let receipt=sqlx::query_scalar::<_,String>("SELECT jsonb_build_object('savedViewId',saved_view_id::text,'groupId',group_id::text,'requestFingerprint',request_fingerprint)::text FROM messenger_saved_view_mutations WHERE org_id=$1::uuid AND user_id=$2 AND client_mutation_id=$3::uuid LIMIT 1")
        .bind(s.org).bind(s.user).bind(&k.client_mutation_id).fetch_optional(&mut **tx).await?;
    let Some(receipt) = receipt else {
        return Ok(None);
    };
    let receipt = decode(&receipt)?;
    if field(&receipt, "requestFingerprint") != fp {
        return Err(conflict(
            "This Saved View mutation id was already used with different input",
        ));
    }
    let unavailable = || conflict("The result of this Saved View mutation is no longer available");
    let view = saved_views::find(&mut *tx, s, field(&receipt, "savedViewId"))
        .await?
        .ok_or_else(unavailable)?;
    let member = membership(&mut *tx, s, &format!("saved-view:{}", field(&view, "id"))).await?;
    let group = if receipt["groupId"].is_null() {
        if member.is_some() {
            return Err(unavailable());
        }
        Value::Null
    } else {
        let id = field(&receipt, "groupId");
        if member.as_deref() != Some(id) {
            return Err(unavailable());
        }
        let group = groups::find(&mut *tx, s, id).await.map_err(|e| match e {
            Error::Http(404, _) => unavailable(),
            e => e,
        })?;
        json!({"id":group["id"],"name":group["name"]})
    };
    Ok(Some(encode(&json!({"savedView":view,"group":group}))?))
}
async fn insert_receipt(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    k: &Keep,
    fp: &str,
    view: &Value,
    group: &Option<Value>,
) -> Result<()> {
    sqlx::query("INSERT INTO messenger_saved_view_mutations(org_id,user_id,client_mutation_id,saved_view_id,group_id,request_fingerprint) VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6)")
        .bind(s.org).bind(s.user).bind(&k.client_mutation_id).bind(field(view,"id")).bind(group.as_ref().map(|g|field(g,"id"))).bind(fp).execute(&mut **tx).await?;
    Ok(())
}
async fn placement(tx: &mut Tx<'_>, s: &Scope<'_>, k: &Keep) -> Result<Option<Value>> {
    let anchor = match &k.placement {
        Placement::Loose => return Ok(None),
        Placement::Group { group_id } => {
            return Ok(Some(groups::find(&mut *tx, s, group_id).await?));
        }
        Placement::Anchor { anchor } => anchor,
    };
    let (key, title) = match anchor {
        Anchor::Chat { conversation_id } => {
            let title=sqlx::query_scalar::<_,String>("SELECT title FROM chat_conversations WHERE id=$1::uuid AND org_id=$2::uuid AND messenger_visible=true AND status<>'archived'")
                .bind(conversation_id).bind(s.org).fetch_optional(&mut **tx).await?.ok_or(Error::Http(404,"Messenger Chat anchor not found"))?;
            (
                format!("chat:{conversation_id}"),
                if title.trim().is_empty() {
                    "Chat".into()
                } else {
                    title.trim().to_owned()
                },
            )
        }
        Anchor::Issue { issue_id } => {
            let title=sqlx::query_scalar::<_,String>("SELECT title FROM issues WHERE id=$1::uuid AND org_id=$2::uuid AND hidden_at IS NULL")
                .bind(issue_id).bind(s.org).fetch_optional(&mut **tx).await?.ok_or(Error::Http(404,"Messenger Issue anchor not found"))?;
            (
                format!("issue:{issue_id}"),
                if title.trim().is_empty() {
                    "Issue".into()
                } else {
                    title.trim().to_owned()
                },
            )
        }
    };
    if let Some(id) = membership(&mut *tx, s, &key).await? {
        return Ok(Some(groups::find(&mut *tx, s, &id).await.map_err(
            |e| match e {
                Error::Http(404, _) => conflict("Messenger anchor group is unavailable"),
                e => e,
            },
        )?));
    }
    // JavaScript slice(0,80) is UTF-16 based; preserve whole scalar values at
    // the boundary rather than persisting an invalid Unicode surrogate.
    let title = String::from_utf16_lossy(&title.encode_utf16().take(80).collect::<Vec<_>>());
    let id=sqlx::query_scalar::<_,String>("INSERT INTO messenger_custom_groups(org_id,user_id,name,sort_order,updated_at) SELECT $1::uuid,$2,$3,COALESCE(MAX(sort_order),-1)+1,current_setting('rudder.messenger_now')::timestamptz FROM messenger_custom_groups WHERE org_id=$1::uuid AND user_id=$2 RETURNING id::text")
        .bind(s.org).bind(s.user).bind(title).fetch_one(&mut **tx).await?;
    group_locks(tx, s, std::slice::from_ref(&id)).await?;
    sqlx::query("INSERT INTO messenger_custom_group_entries(org_id,user_id,group_id,thread_key,sort_order,updated_at) VALUES($1::uuid,$2,$3::uuid,$4,0,current_setting('rudder.messenger_now')::timestamptz)")
        .bind(s.org).bind(s.user).bind(&id).bind(key).execute(&mut **tx).await?;
    Ok(Some(groups::find(&mut *tx, s, &id).await?))
}
fn metadata_equal(row: &Value, k: &Keep) -> bool {
    row["targetPayload"] == k.target.value()
        && row["title"] == k.title
        && row["subtitle"] == json!(k.subtitle)
        && row["favicon"] == json!(k.favicon)
        && (k.primary_rail_pinned != Some(true) || !row["primaryRailPinnedAt"].is_null())
}
pub(super) async fn keep(tx: &mut Tx<'_>, s: &Scope<'_>, k: &Keep) -> Result<String> {
    let pinned = k.primary_rail_pinned == Some(true);
    if pinned && !matches!(k.target, Target::LocalApp { .. }) {
        return Err(Error::Http(
            400,
            "Only Local App Saved Views can be pinned to the Primary Rail",
        ));
    }
    if pinned && !matches!(k.placement, Placement::Loose) {
        return Err(Error::Http(
            400,
            "Local App Primary Rail pins must use loose placement",
        ));
    }
    let fp = fingerprint(k);
    if let Some(result) = receipt(tx, s, k, &fp).await? {
        return Ok(result);
    }
    let by_mutation = by_identity(tx, s, &k.client_mutation_id, true).await?;
    let by_instance = by_identity(tx, s, k.target.instance(), false).await?;
    let canonical = k.target.canonical();
    if let Some(row) = &by_mutation {
        if field(row, "instanceId") != k.target.instance() {
            return Err(conflict(
                "This Saved View mutation id was already used for a different view instance",
            ));
        }
        if field(row, "canonicalResourceKey") != canonical {
            return Err(conflict(
                "This Saved View mutation id was already used for a different target",
            ));
        }
        if by_instance
            .as_ref()
            .is_some_and(|other| other["id"] != row["id"])
        {
            return Err(conflict(
                "Saved View mutation and instance identities refer to different records",
            ));
        }
    }
    let existing = by_mutation.as_ref().or(by_instance.as_ref());
    if existing.is_some_and(|row| field(row, "canonicalResourceKey") != canonical) {
        return Err(conflict(
            "This view instance is already associated with a different target",
        ));
    }
    if pinned && existing.is_none_or(|row| row["primaryRailPinnedAt"].is_null()) {
        saved_views::pin_limit(tx, s).await?;
    }
    let group = placement(tx, s, k).await?;
    let old_group = if let Some(row) = existing {
        membership(&mut *tx, s, &format!("saved-view:{}", field(row, "id"))).await?
    } else {
        None
    };
    let new_group = group.as_ref().map(|g| field(g, "id"));
    let affected = old_group
        .iter()
        .cloned()
        .chain(new_group.map(str::to_owned))
        .collect::<Vec<_>>();
    group_locks(tx, s, &affected).await?;
    let same_placement = old_group.as_deref() == new_group;
    if let Some(row) = &by_mutation {
        if !metadata_equal(row, k) {
            return Err(conflict(
                "This Saved View mutation id was already used with different input",
            ));
        }
        if row["hiddenAt"].is_null() && same_placement {
            insert_receipt(tx, s, k, &fp, row, &group).await?;
            return encode(
                &json!({"savedView":row,"group":group.as_ref().map(|g|json!({"id":g["id"],"name":g["name"]}))}),
            );
        }
    }
    let (view, action) = if let Some(row) = existing {
        if row["hiddenAt"].is_null() && same_placement && metadata_equal(row, k) {
            (row.clone(), None)
        } else {
            sqlx::query("UPDATE messenger_saved_views SET target_kind=$4,target_payload=$5::jsonb,canonical_resource_key=$6,client_mutation_id=COALESCE(client_mutation_id,$7::uuid),title=$8,subtitle=$9,favicon=$10,hidden_at=NULL,primary_rail_pinned_at=CASE WHEN $11 THEN current_setting('rudder.messenger_now')::timestamptz ELSE primary_rail_pinned_at END,updated_at=current_setting('rudder.messenger_now')::timestamptz WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid")
                .bind(s.org).bind(s.user).bind(field(row,"id")).bind(field(&k.target.value(),"kind")).bind(k.target.value().to_string()).bind(&canonical).bind(&k.client_mutation_id).bind(&k.title).bind(&k.subtitle).bind(&k.favicon).bind(pinned).execute(&mut **tx).await?;
            (
                saved_views::find(&mut *tx, s, field(row, "id"))
                    .await?
                    .ok_or_else(missing_saved)?,
                Some(if row["hiddenAt"].is_null() {
                    "messenger.saved_view_updated"
                } else {
                    "messenger.saved_view_restored"
                }),
            )
        }
    } else {
        let id=sqlx::query_scalar::<_,String>("INSERT INTO messenger_saved_views(org_id,user_id,target_kind,target_payload,resource_key,instance_id,canonical_resource_key,client_mutation_id,title,subtitle,favicon,sort_order,primary_rail_pinned_at,updated_at) SELECT $1::uuid,$2,$3,$4::jsonb,$5,$6,$7,$8::uuid,$9,$10,$11,COALESCE(MAX(sort_order),-1)+1,CASE WHEN $12 THEN current_setting('rudder.messenger_now')::timestamptz ELSE NULL END,current_setting('rudder.messenger_now')::timestamptz FROM messenger_saved_views WHERE org_id=$1::uuid AND user_id=$2 RETURNING id::text")
            .bind(s.org).bind(s.user).bind(field(&k.target.value(),"kind")).bind(k.target.value().to_string()).bind(format!("view-instance:{}",k.target.instance())).bind(k.target.instance()).bind(&canonical).bind(&k.client_mutation_id).bind(&k.title).bind(&k.subtitle).bind(&k.favicon).bind(pinned).fetch_one(&mut **tx).await?;
        (
            saved_views::find(&mut *tx, s, &id)
                .await?
                .ok_or_else(missing_saved)?,
            Some("messenger.saved_view_created"),
        )
    };
    if let Some(action) = action {
        let mut extra = json!({"source":"keep"});
        if pinned {
            extra["primaryRailPinned"] = json!(true);
        }
        saved_activity(tx, s, action, &view, extra).await?;
    }
    let key = format!("saved-view:{}", field(&view, "id"));
    if let Some(old) = old_group.filter(|id| Some(id.as_str()) != new_group) {
        sqlx::query("DELETE FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid AND thread_key=$4")
            .bind(s.org).bind(s.user).bind(&old).bind(&key).execute(&mut **tx).await?;
        saved_activity(
            tx,
            s,
            "messenger.saved_view_group_removed",
            &view,
            json!({"groupId":old,"source":"keep"}),
        )
        .await?;
        delete_empty(tx, s, &old).await?;
    }
    if let Some(id) = new_group.filter(|_| !same_placement) {
        sqlx::query("INSERT INTO messenger_custom_group_entries(org_id,user_id,group_id,thread_key,sort_order,updated_at) SELECT $1::uuid,$2,$3::uuid,$4,COALESCE(MAX(sort_order),-1)+1,current_setting('rudder.messenger_now')::timestamptz FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid")
            .bind(s.org).bind(s.user).bind(id).bind(&key).execute(&mut **tx).await?;
        saved_activity(
            tx,
            s,
            "messenger.saved_view_group_assigned",
            &view,
            json!({"groupId":id,"source":"keep"}),
        )
        .await?;
    }
    insert_receipt(tx, s, k, &fp, &view, &group).await?;
    encode(
        &json!({"savedView":view,"group":group.as_ref().map(|g|json!({"id":g["id"],"name":g["name"]}))}),
    )
}
