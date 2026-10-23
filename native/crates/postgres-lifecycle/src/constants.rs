use std::time::Duration;

pub(crate) const POSTGRES_MAJOR: u32 = 18;
pub(crate) const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const INITDB_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
pub(crate) const STOP_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(100);
