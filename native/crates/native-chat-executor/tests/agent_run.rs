//! Actual D1 claims, disposable PostgreSQL migrations and owned native I/O.
//! These fixtures never contact an operator's provider or user data.
#![cfg(unix)]
#[path = "agent_run/fixture.rs"]
mod fixture;
#[path = "agent_run/gateway.rs"]
mod gateway;
#[path = "agent_run/http.rs"]
mod http;
#[path = "agent_run/process.rs"]
mod process;
