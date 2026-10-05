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
    let scope = transaction::lock_branding_scope(tx, metadata).await?;
    if let Some(receipt) = transaction::branding_replay(tx, metadata).await? {
        return Ok(receipt);
    }
    metadata.check_fresh(scope.version, scope.fence_epoch)?;

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
    let view = command.as_integration_view()?;
    let requested_logo_asset_id = view.logo_asset_id().map(|value| value.map(str::to_owned));
    if let Some(Some(asset_id)) = view.logo_asset_id() {
        let asset_organization_id = sqlx::query_scalar::<_, String>(
            "SELECT org_id::text
             FROM assets
             WHERE id=$1::uuid
             FOR KEY SHARE",
        )
        .bind(asset_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(asset_organization_id) = asset_organization_id else {
            return Err(StoreError::NotFound);
        };
        if asset_organization_id != metadata.org {
            return Err(StoreError::InvalidInput);
        }
    }
    let details = branding_details(view);

    let mut state = OrganizationSettingsState::new(
        &metadata.org,
        scope.version,
        scope.fence_epoch,
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
         SET brand_color=$2, updated_at=now()
         WHERE id=$1::uuid",
    )
    .bind(&metadata.org)
    .bind(&next.brand_color)
    .execute(&mut **tx)
    .await?;

    match requested_logo_asset_id.as_ref() {
        Some(Some(asset_id)) => {
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
        Some(None) => {
            sqlx::query("DELETE FROM organization_logos WHERE org_id=$1::uuid")
                .bind(&metadata.org)
                .execute(&mut **tx)
                .await?;
        }
        None => {}
    }

    if requested_logo_asset_id.is_some() && current_logo.as_deref() != next.logo_asset_id.as_deref()
    {
        if let Some(previous_logo) = current_logo.as_deref() {
            // Keep the legacy replacement cleanup, constrained to this organization.
            sqlx::query("DELETE FROM assets WHERE id=$1::uuid AND org_id=$2::uuid")
                .bind(previous_logo)
                .bind(&metadata.org)
                .execute(&mut **tx)
                .await?;
        }
    }

    transaction::persist_branding(
        tx,
        metadata,
        &scope,
        transaction::Effect {
            version: next.version,
            fence_epoch: scope.fence_epoch,
            outcome: Outcome::Applied,
            result: ResultState::OrganizationBranding {
                state_integrity: transaction::branding_state_integrity(&next)?,
                state: next,
            },
            entity_id: metadata.org.clone(),
            activity_action: None,
            activity_entity_type: None,
            details,
        },
    )
    .await
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
