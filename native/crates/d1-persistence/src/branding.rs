use crate::transaction::{self, Effect, Metadata, Tx};
use crate::{AuthorizedActor, CommittedMutation, Outcome, ResultState, StoreError};
use rudder_organization_mutation_core::{OrganizationBrandingCommand, OrganizationSettingsState};
use serde_json::{Map, Value, json};
use sqlx::Row;

pub(crate) async fn apply(
    tx: &mut Tx<'_>,
    actor: &AuthorizedActor,
    command: OrganizationBrandingCommand,
    meta: &Metadata,
) -> Result<CommittedMutation, StoreError> {
    let (version, fence) = transaction::lock(tx, actor, meta).await?;
    if let Some(receipt) = transaction::replay(tx, meta).await? {
        return Ok(receipt);
    }
    meta.check_fresh(version, fence)?;
    let row =
        sqlx::query("SELECT name,description,brand_color FROM organizations WHERE id=$1::uuid")
            .bind(&meta.org)
            .fetch_one(&mut **tx)
            .await?;
    let logo: Option<String> = sqlx::query_scalar(
        "SELECT asset_id::text FROM organization_logos WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(&meta.org)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(id) = &logo {
        asset(tx, &meta.org, id).await?;
    }
    if let Some(Some(id)) = &command.logo_asset_id {
        asset(tx, &meta.org, id).await?;
    }
    let details = details(&command);
    let mut state = OrganizationSettingsState::new(
        &meta.org,
        version,
        fence,
        row.try_get::<String, _>("name")?,
    );
    state.description = row.try_get("description")?;
    state.brand_color = row.try_get("brand_color")?;
    state.logo_asset_id = logo.clone();
    let outcome = state.apply(command)?;
    let next = outcome.state().clone();
    transaction::signed(next.version)?; // Reject BIGINT overflow before the first write.
    transaction::validate_branding_snapshot(&next)?;
    sqlx::query("UPDATE organizations SET name=$2,description=$3,brand_color=$4,updated_at=now() WHERE id=$1::uuid")
        .bind(&meta.org).bind(&next.name).bind(&next.description).bind(&next.brand_color).execute(&mut **tx).await?;
    if logo != next.logo_asset_id {
        match &next.logo_asset_id {
            Some(id) => {
                sqlx::query("INSERT INTO organization_logos (org_id,asset_id) VALUES ($1::uuid,$2::uuid) ON CONFLICT (org_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,updated_at=now()")
                    .bind(&meta.org).bind(id).execute(&mut **tx).await?;
            }
            None => {
                sqlx::query("DELETE FROM organization_logos WHERE org_id=$1::uuid")
                    .bind(&meta.org)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        if let Some(previous) = &logo {
            // Matches the existing Node transaction; filesystem deletion is not owned here.
            sqlx::query("DELETE FROM assets WHERE id=$1::uuid AND org_id=$2::uuid")
                .bind(previous)
                .bind(&meta.org)
                .execute(&mut **tx)
                .await?;
        }
    }
    transaction::persist(
        tx,
        actor,
        meta,
        Effect {
            version: next.version,
            fence,
            outcome: Outcome::Applied,
            result: ResultState::OrganizationBranding { state: next },
            entity_id: meta.org.clone(),
            details,
        },
    )
    .await
}
async fn asset(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<(), StoreError> {
    let found =
        sqlx::query("SELECT id FROM assets WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE")
            .bind(id)
            .bind(org)
            .fetch_optional(&mut **tx)
            .await?;
    if found.is_none() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}
fn details(command: &OrganizationBrandingCommand) -> Value {
    let mut map = Map::new();
    if let Some(name) = &command.name {
        map.insert("name".into(), json!(name));
    }
    for (key, value) in [
        ("description", &command.description),
        ("brandColor", &command.brand_color),
        ("logoAssetId", &command.logo_asset_id),
    ] {
        if let Some(value) = value {
            map.insert(key.into(), json!(value));
        }
    }
    Value::Object(map)
}
