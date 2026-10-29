//! Installed native host fixture; no provider, database or operator profile.
#![cfg(unix)]
use rudder_native_process_transport::{
    HostConnection, HostError, HostEvent, OwnedHost, read_unbound_cleanup_observation,
};
use rudder_native_protocol::{Command, ProtocolVersion};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, Instant},
};
struct FixtureRoot(PathBuf);
impl FixtureRoot {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fixture() -> (FixtureRoot, String, OwnedHost) {
    let root = FixtureRoot(std::env::temp_dir().join(format!(
            "rudder-unbound-cleanup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    std::fs::create_dir(&root.0).unwrap();
    std::fs::create_dir_all(root.path().join("runtime")).unwrap();
    let id = "90000000-0000-4000-8000-000000000001".to_owned();
    let executable = PathBuf::from(
        std::env::var_os("RUDDER_TEST_PROCESS_HOST").expect("prebuilt native host fixture"),
    );
    let host = OwnedHost::launch_external(
        HostConnection {
            request_id: id.clone(),
            attempt_id: id.clone(),
            run_id: id.clone(),
            owner_token: id.clone(),
        },
        &executable,
        None,
    )
    .unwrap();
    assert_eq!(host.connection_identity().connection_epoch(), None);
    host.send(Command::StartProcess {
        protocol_version: Some(ProtocolVersion::default()),
        request_id: Some(id.clone()),
        executable: "/bin/sh".into(),
        argv: vec!["-c".into(), "trap '' TERM; sleep 60 & wait".into()],
        cwd: root.path().to_string_lossy().into_owned(),
        env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        owner_token: Some(id.clone()),
        runtime_root: Some(root.path().join("runtime").to_string_lossy().into_owned()),
        stdin: None,
        interactive_stdin: false,
        grace_ms: Some(100),
    })
    .unwrap();
    (root, id, host)
}
fn spawned(host: &mut OwnedHost) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < deadline);
        match host.receive(Duration::from_millis(100)) {
            Ok(HostEvent::Lifecycle(v)) if v["type"] == "spawned" => {
                return v["pid"].as_i64().unwrap() as i32;
            }
            Err(HostError::Timeout) => (),
            Ok(_) => (),
            Err(e) => panic!("host ended before spawn: {e}"),
        }
    }
}
#[test]
#[ignore = "requires prebuilt RUDDER_TEST_PROCESS_HOST"]
fn unbound_stop_and_owner_eof_both_leave_exact_cleanup_observations() {
    for stop in [true, false] {
        let (root, id, mut host) = fixture();
        let pid = spawned(&mut host);
        if stop {
            host.send(Command::Stop {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(id.clone()),
                grace_ms: Some(100),
            })
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                assert!(Instant::now() < deadline);
                match host.receive(Duration::from_millis(100)) {
                    Ok(HostEvent::Lifecycle(v)) if v["type"] == "terminal" => break,
                    Err(HostError::Timeout) => (),
                    Ok(_) => (),
                    Err(e) => panic!("host ended without terminal: {e}"),
                }
            }
        }
        drop(host);
        let observation = read_unbound_cleanup_observation(&root.path().join("runtime"), &id, &id)
            .unwrap()
            .expect("fsync-backed exact receipt");
        assert_eq!(observation.process_id, Some(pid));
        assert!(
            read_unbound_cleanup_observation(
                &root.path().join("runtime"),
                &id,
                "90000000-0000-4000-8000-000000000002"
            )
            .unwrap()
            .is_none()
        );
    }
}
