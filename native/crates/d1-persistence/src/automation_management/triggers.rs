use super::*;
fn material(api: &str, public: &str, secret: &str) -> Value {
    json!({"webhookUrl":format!("{api}/api/automation-triggers/public/{public}/fire"),"webhookSecret":secret})
}
pub(super) async fn create(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    automation: &Value,
    input: &Value,
    api: &str,
) -> Result<Value> {
    let automation_id = text(automation, "id").unwrap();
    let kind = text(input, "kind").unwrap();
    let mut row = json!({"automationId":automation_id,"kind":kind,"label":input["label"],"enabled":input["enabled"],"cronExpression":null,"timezone":null,"nextRunAt":null,"publicId":null,"secretId":null,"signingMode":null,"replayWindowSec":null,"lastRotatedAt":null});
    let mut secret_material = Value::Null;
    if kind == "schedule" {
        let zone = text(input, "timezone").unwrap_or("UTC");
        row["cronExpression"] = input["cronExpression"].clone();
        row["timezone"] = json!(zone);
        row["nextRunAt"] = json!(
            schedule::next_tick(text(input, "cronExpression").unwrap(), zone, now_ms())?
                .map(schedule::stamp)
                .transpose()?
        );
    }
    if kind == "webhook" {
        let public = random_hex(12)?;
        let (id, secret) = secrets::create(tx, org, automation_id, actor).await?;
        row["publicId"] = json!(public);
        row["secretId"] = json!(id);
        row["signingMode"] = input["signingMode"].clone();
        row["replayWindowSec"] = input["replayWindowSec"].clone();
        row["lastRotatedAt"] = json!(schedule::stamp(now_ms())?);
        secret_material = material(api, &public, &secret);
    }
    row.as_object_mut()
        .unwrap()
        .extend(actor_fields(actor, true).as_object().unwrap().clone());
    let id = projection::write(tx, org, None, true, &row).await?;
    let trigger = projection::trigger(tx, &id, false)
        .await?
        .ok_or_else(|| http(500, "Internal server error"))?;
    audit(
        tx,
        org,
        actor,
        "automation.trigger_created",
        "automation_trigger",
        &id,
        json!({"automationId":automation_id,"kind":kind}),
    )
    .await?;
    Ok(json!({"trigger":trigger,"secretMaterial":secret_material}))
}
pub(super) async fn update(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    automation: &Value,
    old: &Value,
    input: &Value,
) -> Result<Value> {
    let mut value = json!({"label":input.get("label").unwrap_or(&old["label"]),"enabled":input.get("enabled").unwrap_or(&old["enabled"]),"cronExpression":old["cronExpression"],"timezone":old["timezone"],"nextRunAt":old["nextRunAt"],"signingMode":input.get("signingMode").unwrap_or(&old["signingMode"]),"replayWindowSec":input.get("replayWindowSec").unwrap_or(&old["replayWindowSec"])});
    if old["kind"] == "schedule" {
        for key in ["cronExpression", "timezone"] {
            if let Some(v) = input.get(key) {
                if v.is_null() {
                    return Err(http(422, format!("Scheduled triggers require {key}")));
                }
                value[key] = v.clone();
            }
        }
        if let (Some(expression), Some(zone)) =
            (text(&value, "cronExpression"), text(&value, "timezone"))
        {
            value["nextRunAt"] = json!(
                schedule::next_tick(expression, zone, now_ms())?
                    .map(schedule::stamp)
                    .transpose()?
            );
        }
    }
    value
        .as_object_mut()
        .unwrap()
        .extend(actor_fields(actor, false).as_object().unwrap().clone());
    value["updatedAt"] = json!(schedule::stamp(now_ms())?);
    let id = text(old, "id").unwrap();
    projection::write(tx, org, Some(id), true, &value).await?;
    let trigger = projection::trigger(tx, id, false)
        .await?
        .ok_or_else(|| http(404, "Automation trigger not found"))?;
    audit(
        tx,
        org,
        actor,
        "automation.trigger_updated",
        "automation_trigger",
        id,
        json!({"automationId":automation["id"],"kind":trigger["kind"]}),
    )
    .await?;
    Ok(trigger)
}
pub(super) async fn delete(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    automation: &Value,
    old: &Value,
) -> Result<()> {
    let id = text(old, "id").unwrap();
    sqlx::query("DELETE FROM automation_triggers WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(id)
        .bind(org)
        .execute(&mut **tx)
        .await?;
    audit(
        tx,
        org,
        actor,
        "automation.trigger_deleted",
        "automation_trigger",
        id,
        json!({"automationId":automation["id"],"kind":old["kind"]}),
    )
    .await
}
pub(super) async fn rotate(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    automation: &Value,
    old: &Value,
    api: &str,
) -> Result<Value> {
    let (Some(public), Some(secret_id)) = (text(old, "publicId"), text(old, "secretId")) else {
        return Err(http(422, "Only webhook triggers can rotate secrets"));
    };
    if old["kind"] != "webhook" {
        return Err(http(422, "Only webhook triggers can rotate secrets"));
    }
    let secret = secrets::rotate(tx, org, secret_id, actor).await?;
    let mut value = actor_fields(actor, false);
    value["lastRotatedAt"] = json!(schedule::stamp(now_ms())?);
    value["updatedAt"] = value["lastRotatedAt"].clone();
    let id = text(old, "id").unwrap();
    projection::write(tx, org, Some(id), true, &value).await?;
    let trigger = projection::trigger(tx, id, false)
        .await?
        .ok_or_else(|| http(404, "Automation trigger not found"))?;
    audit(
        tx,
        org,
        actor,
        "automation.trigger_secret_rotated",
        "automation_trigger",
        id,
        json!({"automationId":automation["id"]}),
    )
    .await?;
    Ok(json!({"trigger":trigger,"secretMaterial":material(api,public,&secret)}))
}
