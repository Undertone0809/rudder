use crate::{CollectorError, assertion::decode_identity_public_key};
use std::{
    env,
    net::{IpAddr, SocketAddr},
    str::FromStr,
};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4318;
const DEFAULT_SCHEMA: &str = "rudder_analytics";
const DEFAULT_RETENTION_DAYS: i64 = 90;
const DEFAULT_PRIVACY_THRESHOLD: i64 = 10;
const DEFAULT_ROLLUP_INTERVAL_MS: u64 = 15 * 60 * 1000;

#[derive(Clone, Debug)]
pub struct CollectorConfig {
    pub database_url: String,
    pub maintenance_database_url: String,
    pub report_database_url: String,
    pub database_role: Option<String>,
    pub expected_database_role: Option<String>,
    pub maintenance_database_role: Option<String>,
    pub report_database_role: Option<String>,
    pub schema: String,
    pub host: IpAddr,
    pub port: u16,
    pub identity_public_key: Vec<u8>,
    pub identity_issuer: String,
    pub identity_key_id: String,
    pub anonymous_authorization: Option<String>,
    pub report_secret: Option<String>,
    pub revoke_secret: Option<String>,
    pub consent_sync_secret: Option<String>,
    pub retention_days: i64,
    pub privacy_threshold: i64,
    pub rollup_interval_ms: u64,
}

impl CollectorConfig {
    pub fn from_env() -> Result<Self, CollectorError> {
        let schema = optional("RUDDER_TELEMETRY_COLLECTOR_SCHEMA")
            .unwrap_or_else(|| DEFAULT_SCHEMA.to_owned());
        if schema != DEFAULT_SCHEMA {
            return Err(CollectorError::Configuration(
                "invalid_rudder_telemetry_collector_schema".into(),
            ));
        }
        let host = optional("RUDDER_TELEMETRY_COLLECTOR_HOST")
            .unwrap_or_else(|| DEFAULT_HOST.to_owned())
            .parse::<IpAddr>()
            .map_err(|_| {
                CollectorError::Configuration("invalid_rudder_telemetry_collector_host".into())
            })?;
        let port = bounded_u16("RUDDER_TELEMETRY_COLLECTOR_PORT", DEFAULT_PORT, 1, u16::MAX)?;
        let retention_days = bounded_i64(
            "RUDDER_TELEMETRY_COLLECTOR_RETENTION_DAYS",
            DEFAULT_RETENTION_DAYS,
            1,
            3650,
        )?;
        let privacy_threshold = bounded_i64(
            "RUDDER_TELEMETRY_COLLECTOR_PRIVACY_THRESHOLD",
            DEFAULT_PRIVACY_THRESHOLD,
            2,
            100_000,
        )?;
        let rollup_interval_ms = bounded_u64(
            "RUDDER_TELEMETRY_COLLECTOR_ROLLUP_INTERVAL_MS",
            DEFAULT_ROLLUP_INTERVAL_MS,
            1000,
            24 * 60 * 60 * 1000,
        )?;
        Ok(Self {
            database_url: required("RUDDER_TELEMETRY_COLLECTOR_DATABASE_URL")?,
            maintenance_database_url: required(
                "RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_URL",
            )?,
            report_database_url: required("RUDDER_TELEMETRY_COLLECTOR_REPORT_DATABASE_URL")?,
            database_role: optional("RUDDER_TELEMETRY_COLLECTOR_DATABASE_ROLE"),
            expected_database_role: optional("RUDDER_TELEMETRY_COLLECTOR_EXPECTED_DATABASE_ROLE")
                .or_else(|| optional("RUDDER_TELEMETRY_COLLECTOR_DATABASE_ROLE")),
            maintenance_database_role: optional(
                "RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_ROLE",
            ),
            report_database_role: optional("RUDDER_TELEMETRY_COLLECTOR_REPORT_DATABASE_ROLE"),
            schema,
            host,
            port,
            identity_public_key: decode_identity_public_key(&required(
                "RUDDER_TELEMETRY_COLLECTOR_IDENTITY_PUBLIC_KEY",
            )?)?,
            identity_issuer: required("RUDDER_TELEMETRY_COLLECTOR_IDENTITY_ISSUER")?,
            identity_key_id: required("RUDDER_TELEMETRY_COLLECTOR_IDENTITY_KEY_ID")?,
            anonymous_authorization: optional("RUDDER_TELEMETRY_COLLECTOR_ANONYMOUS_AUTHORIZATION"),
            report_secret: optional("RUDDER_TELEMETRY_COLLECTOR_REPORT_SECRET"),
            revoke_secret: optional("RUDDER_TELEMETRY_COLLECTOR_REVOKE_SECRET"),
            consent_sync_secret: optional("RUDDER_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET"),
            retention_days,
            privacy_threshold,
            rollup_interval_ms,
        })
    }

    pub fn socket_addr(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }
}

#[derive(Clone, Debug)]
pub struct MigrationConfig {
    pub database_url: String,
    pub expected_role: Option<String>,
    pub collector_role: String,
    pub rollup_role: String,
    pub reader_role: String,
}

impl MigrationConfig {
    pub fn from_env() -> Result<Self, CollectorError> {
        Ok(Self {
            database_url: optional("RUDDER_TELEMETRY_COLLECTOR_MIGRATION_DATABASE_URL")
                .or_else(|| optional("DATABASE_URL"))
                .ok_or_else(|| {
                    CollectorError::Configuration(
                        "missing_rudder_telemetry_collector_migration_database_url".into(),
                    )
                })?,
            expected_role: optional("RUDDER_TELEMETRY_COLLECTOR_MIGRATION_ROLE"),
            collector_role: optional("TELEMETRY_COLLECTOR_USER")
                .unwrap_or_else(|| "rudder_analytics_collector".into()),
            rollup_role: optional("TELEMETRY_ROLLUP_USER")
                .unwrap_or_else(|| "rudder_analytics_rollup".into()),
            reader_role: optional("TELEMETRY_READER_USER")
                .unwrap_or_else(|| "rudder_analytics_reader".into()),
        })
    }
}

fn required(key: &'static str) -> Result<String, CollectorError> {
    optional(key)
        .ok_or_else(|| CollectorError::Configuration(format!("missing_{}", key.to_lowercase())))
}

fn optional(key: &str) -> Option<String> {
    env::var(key).ok().and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

fn bounded_u64(
    key: &'static str,
    fallback: u64,
    min: u64,
    max: u64,
) -> Result<u64, CollectorError> {
    let value = match optional(key) {
        None => fallback,
        Some(raw) => raw.parse::<u64>().map_err(|_| {
            CollectorError::Configuration(format!("invalid_{}", key.to_lowercase()))
        })?,
    };
    if value < min || value > max {
        return Err(CollectorError::Configuration(format!(
            "invalid_{}",
            key.to_lowercase()
        )));
    }
    Ok(value)
}

fn bounded_i64(
    key: &'static str,
    fallback: i64,
    min: i64,
    max: i64,
) -> Result<i64, CollectorError> {
    let value = match optional(key) {
        None => fallback,
        Some(raw) => raw.parse::<i64>().map_err(|_| {
            CollectorError::Configuration(format!("invalid_{}", key.to_lowercase()))
        })?,
    };
    if value < min || value > max {
        return Err(CollectorError::Configuration(format!(
            "invalid_{}",
            key.to_lowercase()
        )));
    }
    Ok(value)
}

fn bounded_u16(
    key: &'static str,
    fallback: u16,
    min: u16,
    max: u16,
) -> Result<u16, CollectorError> {
    let value = match optional(key) {
        None => fallback,
        Some(raw) => raw.parse::<u16>().map_err(|_| {
            CollectorError::Configuration(format!("invalid_{}", key.to_lowercase()))
        })?,
    };
    if value < min || value > max {
        return Err(CollectorError::Configuration(format!(
            "invalid_{}",
            key.to_lowercase()
        )));
    }
    Ok(value)
}

#[allow(dead_code)]
fn _socket_addr_from_text(host: &str, port: u16) -> Result<SocketAddr, CollectorError> {
    SocketAddr::from_str(&format!("{host}:{port}"))
        .map_err(|_| CollectorError::Configuration("invalid_listener_address".into()))
}
