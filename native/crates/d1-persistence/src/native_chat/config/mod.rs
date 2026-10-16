//! Trusted, read-only resolution of persisted Agent and Chat settings for the
//! local Codex runtime. These Rust-only types are not wire DTOs.

mod fingerprint;
mod host;
mod resolve;
mod runtime;

pub use host::LocalHostContext;
pub(crate) use resolve::resolve_codex_config;
pub use resolve::{ManagedCodexProfile, ResolvedCodexConfig, RuntimeBindingIdentity};

#[cfg(test)]
mod tests;

use super::{Error, http};

type Result<T> = std::result::Result<T, Error>;

fn unsupported(detail: &'static str) -> Error {
    http(
        409,
        format!("Native Codex Chat configuration is unsupported: {detail}"),
    )
}

fn invalid(detail: &'static str) -> Error {
    http(
        409,
        format!("Native Codex Chat configuration is invalid: {detail}"),
    )
}
