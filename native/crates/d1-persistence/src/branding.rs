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
    let details = branding_details(command.as_integration_view()?);

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
