//! Automation-owned use of existing local-encrypted secret material. Node's
//! Automation secret operations have no separate secret.* activity event.
use super::*;
pub(super) async fn create(
    tx: &mut Tx<'_>,
    org: &str,
    automation: &str,
    actor: &Actor<'_>,
) -> Result<(String, String)> {
    let value = random_hex(24)?;
    let name = format!("automation-{automation}-{}", random_hex(6)?);
    let (material, digest) = crate::secrets::encrypt_value(&value)?;
    let agent = (actor.kind == "agent").then_some(actor.id);
    let user = (actor.kind == "user").then_some(actor.id);
    let id=sqlx::query_scalar::<_,String>("INSERT INTO organization_secrets(org_id,name,provider,purpose,latest_version,description,created_by_agent_id,created_by_user_id) VALUES($1::uuid,$2,'local_encrypted','user_managed',1,$3,$4::uuid,$5) RETURNING id::text").bind(org).bind(name).bind(format!("Webhook auth for automation {automation}")).bind(agent).bind(user).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_agent_id,created_by_user_id) VALUES($1::uuid,1,$2::jsonb,$3,$4::uuid,$5)").bind(&id).bind(material.to_string()).bind(digest).bind(agent).bind(user).execute(&mut **tx).await?;
    Ok((id, value))
}
pub(super) async fn rotate(
    tx: &mut Tx<'_>,
    org: &str,
    id: &str,
    actor: &Actor<'_>,
) -> Result<String> {
    let row=sqlx::query_as::<_,(i32,String)>("SELECT latest_version,provider FROM organization_secrets WHERE id=$1::uuid AND org_id=$2::uuid AND purpose='user_managed' FOR UPDATE").bind(id).bind(org).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Secret not found"))?;
    if row.1 != "local_encrypted" {
        return Err(http(
            422,
            format!("{} provider is not configured in this deployment", row.1),
        ));
    }
    let version = row
        .0
        .checked_add(1)
        .ok_or_else(|| http(500, "Internal server error"))?;
    let value = random_hex(24)?;
    let (material, digest) = crate::secrets::encrypt_value(&value)?;
    sqlx::query("INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_agent_id,created_by_user_id) VALUES($1::uuid,$2,$3::jsonb,$4,$5::uuid,$6)").bind(id).bind(version).bind(material.to_string()).bind(digest).bind((actor.kind=="agent").then_some(actor.id)).bind((actor.kind=="user").then_some(actor.id)).execute(&mut **tx).await?;
    sqlx::query("UPDATE organization_secrets SET latest_version=$3,external_ref=NULL,updated_at=clock_timestamp() WHERE id=$1::uuid AND org_id=$2::uuid").bind(id).bind(org).bind(version).execute(&mut **tx).await?;
    Ok(value)
}
