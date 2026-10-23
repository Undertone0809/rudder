#[cfg(unix)]
mod unix_tests {
    use serde_json::{Value, json};
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::Stdio,
        time::Duration,
    };
    use tempfile::TempDir;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        process::Command,
        time::timeout,
    };

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }

    fn write_script(path: &Path, source: &str) {
        fs::write(path, source).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn fake_runtime(
        root: &TempDir,
        initdb_behavior: &str,
        postgres_behavior: &str,
    ) -> (PathBuf, PathBuf) {
        let bin = root.path().join("bin");
        let share = root.path().join("share");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&share).unwrap();
        fs::write(share.join("postgres.bki"), "test template").unwrap();
        fs::write(share.join("postgresql.conf.sample"), "test template").unwrap();

        let initdb = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'initdb (PostgreSQL) 18.4\\n'; exit 0; fi\n{initdb_behavior}\n"
        );
        let postgres = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'postgres (PostgreSQL) 18.4\\n'; exit 0; fi\n{postgres_behavior}\n"
        );
        write_script(&bin.join("initdb"), &initdb);
        write_script(&bin.join("postgres"), &postgres);
        write_script(
            &bin.join("pg_ctl"),
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'pg_ctl (PostgreSQL) 18.4\\n'; exit 0; fi\nexit 1\n",
        );
        let sysv_marker = root.path().join("sysv-cleanup-called");
        for utility in ["ipcs", "ipcrm"] {
            write_script(
                &bin.join(utility),
                &format!(
                    "#!/bin/sh\nprintf '{utility}\\n' >> {}\nexit 0\n",
                    shell_quote(&sysv_marker)
                ),
            );
        }
        (bin, sysv_marker)
    }

    async fn start_owner(bin: &Path, data_dir: &Path) -> (Value, std::process::ExitStatus) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
            .env("PATH", bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let request = json!({
            "schema": "rudder.postgres-owner.v1",
            "op": "start",
            "instance_id": "diagnostic-test",
            "data_dir": data_dir,
            "port": 0,
            "bin_dir": bin,
            "database": "rudder_diagnostic_test",
            "user": "rudder",
            "password": "diagnostic-password",
            "fallback_passwords": [],
            "parent_pid": null
        });
        let mut frame = serde_json::to_vec(&request).unwrap();
        frame.push(b'\n');
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&frame)
            .await
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut response = String::new();
        timeout(Duration::from_secs(30), reader.read_line(&mut response))
            .await
            .expect("owner must return either ready or a structured startup error")
            .unwrap();
        let frame: Value = serde_json::from_str(response.trim()).unwrap();
        let status = timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("failed fake runtime should leave no owner process")
            .unwrap();
        (frame, status)
    }

    #[tokio::test]
    async fn initdb_failure_returns_bounded_redacted_tail_without_publishing_data_or_retrying() {
        let root = tempfile::tempdir().unwrap();
        let calls = root.path().join("initdb-calls");
        let initdb_behavior = format!(
            "printf 'attempt\\n' >> {}\ni=0\nwhile [ \"$i\" -lt 2000 ]; do printf 'older initdb output line %s\\n' \"$i\" >&2; i=$((i + 1)); done\nprintf 'FATAL: password=diagnostic-password\ntoken=token-secret\npostgres://rudder:url-secret@localhost/rudder' >&2\nexit 7",
            shell_quote(&calls)
        );
        let (bin, sysv_marker) = fake_runtime(&root, &initdb_behavior, "exit 0");
        let instance_dir = root.path().join("profile");
        fs::create_dir_all(&instance_dir).unwrap();
        let data_dir = instance_dir.join("db");

        let (response, status) = start_owner(&bin, &data_dir).await;

        assert_eq!(response["op"], "error");
        assert_eq!(response["code"], "postgres_command_failed");
        assert_eq!(status.code(), Some(1));
        let message = response["message"].as_str().unwrap();
        assert!(message.contains("FATAL: password=[REDACTED]"));
        assert!(message.contains("token=[REDACTED]"));
        assert!(message.contains("postgres://[REDACTED]@localhost/rudder"));
        assert!(!message.contains("diagnostic-password"));
        assert!(!message.contains("token-secret"));
        assert!(!message.contains("url-secret"));
        assert!(!message.contains("older initdb output line 0"));
        assert!(
            message.len() <= 9 * 1024,
            "structured error tail must remain bounded"
        );
        assert_eq!(fs::read_to_string(calls).unwrap(), "attempt\n");
        assert!(
            !data_dir.exists(),
            "failed initdb staging must not publish canonical PGDATA"
        );
        assert!(
            !sysv_marker.exists(),
            "startup must not invoke broad ipcs/ipcrm cleanup"
        );
    }

    #[tokio::test]
    async fn postgres_ready_text_cannot_override_nonzero_child_exit() {
        let root = tempfile::tempdir().unwrap();
        let initdb_calls = root.path().join("initdb-calls");
        let postgres_calls = root.path().join("postgres-calls");
        let initdb_behavior = format!(
            "printf 'attempt\\n' >> {}\ndata_dir=''\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = \"-D\" ]; then shift; data_dir=\"$1\"; fi; shift; done\nprintf '18\\n' > \"$data_dir/PG_VERSION\"\nexit 0",
            shell_quote(&initdb_calls)
        );
        let postgres_behavior = format!(
            "printf 'attempt\\n' >> {}\nprintf 'database system is ready to accept connections password=diagnostic-password' >&2\nexit 9",
            shell_quote(&postgres_calls)
        );
        let (bin, sysv_marker) = fake_runtime(&root, &initdb_behavior, &postgres_behavior);
        let instance_dir = root.path().join("profile");
        fs::create_dir_all(&instance_dir).unwrap();
        let data_dir = instance_dir.join("db");

        let (response, status) = start_owner(&bin, &data_dir).await;

        assert_eq!(response["op"], "error");
        assert_eq!(response["code"], "postgres_start_failed");
        assert_eq!(status.code(), Some(1));
        let message = response["message"].as_str().unwrap();
        assert!(message.contains("PostgreSQL exited during startup"));
        assert!(message.contains("database system is ready to accept connections"));
        assert!(message.contains("password=[REDACTED]"));
        assert!(!message.contains("diagnostic-password"));
        assert_eq!(fs::read_to_string(initdb_calls).unwrap(), "attempt\n");
        assert_eq!(fs::read_to_string(postgres_calls).unwrap(), "attempt\n");
        assert!(data_dir.join("PG_VERSION").is_file());
        assert!(
            !sysv_marker.exists(),
            "startup must not invoke broad ipcs/ipcrm cleanup"
        );
    }
}
