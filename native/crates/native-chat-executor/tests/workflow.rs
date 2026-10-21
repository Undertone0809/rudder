#![cfg(unix)]

#[path = "workflow/control.rs"]
mod control;
#[path = "workflow/dispatch_guards.rs"]
mod dispatch_guards;
#[path = "workflow/failures.rs"]
mod failures;
#[path = "workflow/finalization.rs"]
mod finalization;
#[path = "workflow/finalization_guards.rs"]
mod finalization_guards;
#[path = "workflow/fixture.rs"]
mod fixture;
#[path = "workflow/g6_lease_and_cancel.rs"]
mod g6_lease_and_cancel;
#[path = "workflow/happy_path.rs"]
mod happy_path;
#[path = "workflow/resume.rs"]
mod resume;
#[path = "workflow/resume_fixture.rs"]
mod resume_fixture;

#[path = "workflow/live_stop.rs"]
mod live_stop;

#[path = "workflow/hermes_progress.rs"]
mod hermes_progress;

#[path = "workflow/browser_principal.rs"]
mod browser_principal;
