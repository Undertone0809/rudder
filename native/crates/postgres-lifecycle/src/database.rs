use crate::{
    bootstrap::{parse_postgres_version, same_path},
    constants::{POLL_INTERVAL, POSTGRES_MAJOR},
    error::OwnerError,
    platform::ParentMonitor,
    protocol::{PROTOCOL_SCHEMA, ReadyResponse, StartRequest},
};
use sqlx::{Connection, postgres::PgConnectOptions};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::watch;
use tokio::time::{Instant, sleep, timeout};

pub(crate) struct VerifiedConnection {
    pub(crate) connection: sqlx::PgConnection,
    pub(crate) password: String,
    pub(crate) server_version: String,
}

pub(crate) struct ConnectionConfig<'a> {
    pub(crate) port: u16,
    pub(crate) data_dir: &'a Path,
    pub(crate) user: &'a str,
    pub(crate) password: &'a str,
    pub(crate) fallbacks: &'a [String],
    pub(crate) normalize_fallback: bool,
}

fn connect_options(port: u16, user: &str, password: &str) -> PgConnectOptions {
    PgConnectOptions::new()
        .host("127.0.0.1")
        .port(port)
        .username(user)
        .password(password)
        .database("postgres")
        .application_name("rudder-postgres-owner")
}

pub(crate) async fn connect_verified(
    config: ConnectionConfig<'_>,
    parent: Option<&ParentMonitor>,
    cancellation: Option<&mut watch::Receiver<bool>>,
) -> Result<VerifiedConnection, OwnerError> {
    let ConnectionConfig {
        port,
        data_dir,
        user,
        password,
        fallbacks,
        normalize_fallback,
    } = config;
    if cancellation
        .as_ref()
        .is_some_and(|receiver| *receiver.borrow())
    {
        return Err(OwnerError::new(
            "protocol_start_cancelled",
            "owner input closed before PostgreSQL became ready",
        ));
    }
    let mut candidates = vec![password.to_owned()];
    for fallback in fallbacks {
        if !candidates.contains(fallback) && !fallback.is_empty() {
            candidates.push(fallback.clone());
        }
    }
    for candidate in candidates {
        let mut connection = match timeout(
            Duration::from_secs(2),
            sqlx::PgConnection::connect_with(&connect_options(port, user, &candidate)),
        )
        .await
        {
            Ok(Ok(connection)) => connection,
            Ok(Err(_error)) => {
                continue;
            }
            Err(_) => continue,
        };
        if cancellation
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
        {
            return Err(OwnerError::new(
                "protocol_start_cancelled",
                "owner input closed before PostgreSQL became ready",
            ));
        }
        let actual: String = sqlx::query_scalar("SELECT current_setting('data_directory')")
            .fetch_one(&mut connection)
            .await
            .map_err(|_| {
                OwnerError::new(
                    "server_identity_query_failed",
                    "connected server did not return its data directory",
                )
            })?;
        if !same_path(Path::new(&actual), data_dir) {
            return Err(OwnerError::new(
                "server_identity_mismatch",
                "reachable PostgreSQL server uses a different data directory",
            ));
        }
        let server_version: String = sqlx::query_scalar("SHOW server_version")
            .fetch_one(&mut connection)
            .await
            .map_err(|_| {
                OwnerError::new(
                    "server_version_query_failed",
                    "connected server did not return its version",
                )
            })?;
        if parse_postgres_version(&server_version)
            .and_then(|value| value.split('.').next()?.parse::<u32>().ok())
            != Some(POSTGRES_MAJOR)
        {
            return Err(OwnerError::new(
                "incompatible_server",
                "verified PostgreSQL server has an incompatible major version",
            ));
        }
        if candidate != password && normalize_fallback {
            if cancellation
                .as_ref()
                .is_some_and(|receiver| *receiver.borrow())
            {
                return Err(OwnerError::new(
                    "protocol_start_cancelled",
                    "owner input closed before PostgreSQL became ready",
                ));
            }
            if let Some(parent) = parent {
                parent.ensure_alive()?;
            }
            let escaped_user = user.replace('"', "\"\"");
            let escaped_password = candidate_literal(password);
            let alter = format!("ALTER ROLE \"{escaped_user}\" WITH PASSWORD '{escaped_password}'");
            sqlx::raw_sql(&alter)
                .execute(&mut connection)
                .await
                .map_err(|_| {
                    OwnerError::new(
                        "credential_normalization_failed",
                        "could not normalize the verified local PostgreSQL role password",
                    )
                })?;
            drop(connection);
            if let Some(parent) = parent {
                parent.ensure_alive()?;
            }
            let mut connection =
                sqlx::PgConnection::connect_with(&connect_options(port, user, password))
                    .await
                    .map_err(|_| {
                        OwnerError::new(
                            "credential_normalization_failed",
                            "preferred PostgreSQL credentials failed after normalization",
                        )
                    })?;
            let actual: String = sqlx::query_scalar("SELECT current_setting('data_directory')")
                .fetch_one(&mut connection)
                .await
                .map_err(|_| {
                    OwnerError::new(
                        "credential_normalization_failed",
                        "cannot verify normalized PostgreSQL credentials",
                    )
                })?;
            if !same_path(Path::new(&actual), data_dir) {
                return Err(OwnerError::new(
                    "server_identity_mismatch",
                    "normalized credentials reached a different data directory",
                ));
            }
            return Ok(VerifiedConnection {
                connection,
                password: password.to_owned(),
                server_version,
            });
        }
        return Ok(VerifiedConnection {
            connection,
            password: candidate,
            server_version,
        });
    }
    Err(OwnerError::new(
        "server_not_verified",
        "PostgreSQL server did not accept configured credentials or could not be verified",
    ))
}

pub(crate) async fn connect_verified_until_ready(
    config: ConnectionConfig<'_>,
    parent: &ParentMonitor,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<VerifiedConnection, OwnerError> {
    let ConnectionConfig {
        port,
        data_dir,
        user,
        password,
        fallbacks,
        normalize_fallback,
    } = config;
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        parent.ensure_alive()?;
        if *cancellation.borrow() {
            return Err(OwnerError::new(
                "protocol_start_cancelled",
                "owner input closed before PostgreSQL became ready",
            ));
        }
        match connect_verified(
            ConnectionConfig {
                port,
                data_dir,
                user,
                password,
                fallbacks,
                normalize_fallback,
            },
            Some(parent),
            Some(cancellation),
        )
        .await
        {
            Ok(verified) => return Ok(verified),
            Err(error)
                if matches!(
                    error.code,
                    "server_identity_mismatch"
                        | "incompatible_server"
                        | "credential_normalization_failed"
                ) =>
            {
                return Err(error);
            }
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(error) if error.code == "protocol_start_cancelled" => return Err(error),
            Err(_) => {
                tokio::select! {
                    _ = sleep(POLL_INTERVAL) => {}
                    changed = cancellation.changed() => {
                        if changed.is_ok() && *cancellation.borrow() {
                            return Err(OwnerError::new(
                                "protocol_start_cancelled",
                                "owner input closed before PostgreSQL became ready",
                            ));
                        }
                    }
                }
            }
        }
    }
}

fn candidate_literal(value: &str) -> String {
    value.replace('\'', "''")
}

pub(crate) async fn ensure_database(
    connection: &mut sqlx::PgConnection,
    database: &str,
) -> Result<bool, OwnerError> {
    let exists = database_exists(connection, database).await?;
    if exists {
        return Ok(false);
    }
    // validate_request restricts names to a conservative identifier alphabet.
    let sql = format!(
        "CREATE DATABASE \"{database}\" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"
    );
    sqlx::raw_sql(&sql)
        .execute(&mut *connection)
        .await
        .map_err(|_| {
            OwnerError::new(
                "database_create_failed",
                "could not create the requested local PostgreSQL database",
            )
        })?;
    Ok(true)
}

pub(crate) async fn database_exists(
    connection: &mut sqlx::PgConnection,
    database: &str,
) -> Result<bool, OwnerError> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)")
        .bind(database)
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| {
            OwnerError::new(
                "database_check_failed",
                "could not inspect the local PostgreSQL database",
            )
        })
}

pub(crate) struct ReadyDetails<'a> {
    pub(crate) lease_id: &'a str,
    pub(crate) data_dir: PathBuf,
    pub(crate) bin_dir: PathBuf,
    pub(crate) port: u16,
    pub(crate) server_version: String,
    pub(crate) password: String,
    pub(crate) cluster_created: bool,
    pub(crate) owned: bool,
    pub(crate) database_created: bool,
}

pub(crate) fn make_ready(
    request: &StartRequest,
    details: ReadyDetails<'_>,
) -> Result<ReadyResponse, OwnerError> {
    let mut url = url::Url::parse("postgresql://127.0.0.1/").map_err(|_| {
        OwnerError::new(
            "connection_string_failed",
            "cannot create PostgreSQL connection string",
        )
    })?;
    url.set_username(&request.user).map_err(|_| {
        OwnerError::new(
            "connection_string_failed",
            "cannot encode PostgreSQL username",
        )
    })?;
    url.set_password(Some(&details.password)).map_err(|_| {
        OwnerError::new(
            "connection_string_failed",
            "cannot encode PostgreSQL password",
        )
    })?;
    url.set_port(Some(details.port))
        .map_err(|_| OwnerError::new("connection_string_failed", "cannot set PostgreSQL port"))?;
    url.set_path(&format!("/{}", request.database));
    Ok(ReadyResponse {
        schema: PROTOCOL_SCHEMA,
        op: "ready",
        instance_id: request.instance_id.clone(),
        lease_id: details.lease_id.to_owned(),
        data_dir: details.data_dir,
        port: details.port,
        postgres_version: details.server_version,
        connection_string: url.to_string(),
        bin_dir: details.bin_dir,
        cluster_created: details.cluster_created,
        database_created: details.database_created,
        owned: details.owned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_sql_literal_escapes_single_quotes() {
        assert_eq!(candidate_literal("a'b"), "a''b");
    }
}
