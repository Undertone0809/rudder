//! Local PostgreSQL lifecycle owner implementation.

mod bootstrap;
mod constants;
mod database;
mod error;
mod lease;
mod owner;
mod platform;
mod postgres;
mod process;
mod protocol;

pub use error::{ErrorResponse, OwnerError};
pub use owner::OwnerSession;
pub use protocol::{
    PROTOCOL_SCHEMA, ReadyResponse, StartRequest, StopRequest, StoppedResponse, run_protocol,
};
