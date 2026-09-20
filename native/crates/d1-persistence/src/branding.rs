use crate::{CommittedMutation, Outcome, ResultState, StoreError, transaction};
use rudder_organization_mutation_core::{
    MutationOutcome, OrganizationBrandingCommand, OrganizationSettingsState,
};
use serde_json::{Map, Value, json};
use sqlx::Row;

pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: OrganizationBrandingCommand,
    metadata: &transaction::Metadata,
) -> Result<CommittedMutation, StoreError> {
    let (version, fence_epoch) = transaction::lock_scope(tx, metadata).await?;
    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        return Ok(receipt);
    }
    metadata.check_fresh(version, fence_epoch)?;

    let row = sqlx::query(
        "SELECT name, description, brand_color
         FROM organizations
         WHERE id=$1::uuid",
    )
    .bind(&metadata.org)
    .fetch_one(&mut **tx)
    .await?;
    let current_logo: Option<String> = sqlx::query_scalar(
        "SELECT asset_id::text
         FROM organization_logos
         WHERE org_id=$1::uuid
         FOR UPDATE",
    )
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(asset_id) = &current_logo {
        asset(tx, &metadata.org, asset_id).await?;
    }

    let details = {
        let view = command.as_integration_view()?;
        if let Some(Some(asset_id)) = view.logo_asset_id() {
            asset(tx, &metadata.org, asset_id).await?;
        }
        branding_details(view)
    };

    let mut state = OrganizationSettingsState::new(
        &metadata.org,
        version,
        fence_epoch,
        row.try_get::<String, _>("name")?,
    );
    state.description = row.try_get("description")?;
    state.brand_color = row.try_get("brand_color")?;
    state.logo_asset_id = current_logo.clone();
    let outcome = state.apply(command)?;
    let next = match outcome {
        MutationOutcome::Applied { state, .. } => state,
        MutationOutcome::AlreadyApplied { .. } => return Err(StoreError::InvalidReceipt),
    };
    transaction::signed(next.version)?;

    sqlx::query(
        "UPDATE organizations
         SET name=$2, description=$3, brand_color=$4, updated_at=now()
         WHERE id=$1::uuid",
    )
    .bind(&metadata.org)
    .bind(&next.name)
    .bind(&next.description)
    .bind(&next.brand_color)
    .execute(&mut **tx)
    .await?;

    if current_logo != next.logo_asset_id {
        match &next.logo_asset_id {
            Some(asset_id) => {
                sqlx::query(
                    "INSERT INTO organization_logos (org_id, asset_id)
                     VALUES ($1::uuid, $2::uuid)
                     ON CONFLICT (org_id) DO UPDATE
                     SET asset_id=EXCLUDED.asset_id, updated_at=now()",
                )
                .bind(&metadata.org)
                .bind(asset_id)
                .execute(&mut **tx)
                .await?;
            }
            None => {
                sqlx::query(
                    "DELETE FROM organization_logos
                     WHERE org_id=$1::uuid",
                )
                .bind(&metadata.org)
                .execute(&mut **tx)
                .await?;
            }
        }
        if let Some(previous) = &current_logo {
            sqlx::query(
                "DELETE FROM assets
                 WHERE id=$1::uuid AND org_id=$2::uuid",
            )
            .bind(previous)
            .bind(&metadata.org)
            .execute(&mut **tx)
            .await?;
        }
    }

    transaction::persist(
        tx,
        metadata,
        transaction::Effect {
            version: next.version,
            fence_epoch,
            outcome: Outcome::Applied,
            result: ResultState::OrganizationBranding { state: next },
            entity_id: metadata.org.clone(),
            details,
        },
    )
    .await
}

async fn asset(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    asset_id: &str,
) -> Result<(), StoreError> {
    let found = sqlx::query(
        "SELECT id
         FROM assets
         WHERE id=$1::uuid AND org_id=$2::uuid
         FOR UPDATE",
    )
    .bind(asset_id)
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    if found.is_none() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

fn branding_details(
    view: rudder_organization_mutation_core::OrganizationBrandingCommandView<'_>,
) -> Value {
    let mut map = Map::new();
    if let Some(name) = view.name() {
        map.insert("name".to_owned(), json!(name));
    }
    for (key, value) in [
        ("description", view.description()),
        ("brandColor", view.brand_color()),
        ("logoAssetId", view.logo_asset_id()),
    ] {
        if let Some(value) = value {
            map.insert(key.to_owned(), json!(value));
        }
    }
    Value::Object(map)
}
