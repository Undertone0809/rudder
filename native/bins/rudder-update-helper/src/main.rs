use rudder_update_helper_core::{UpdateRequest, bundle_manifest_digest, execute};
use std::fs;
use std::io::{self, Read};

fn main() {
    let mut args = std::env::args().skip(1);
    if let Some(flag) = args.next() {
        if flag == "--version" {
            println!(
                "rudder-update-helper {} protocol=1",
                env!("CARGO_PKG_VERSION")
            );
            return;
        }
        if flag == "--digest" {
            let Some(path) = args.next() else {
                print_error("--digest requires an extracted App bundle path");
                std::process::exit(2);
            };
            match bundle_manifest_digest(path.as_ref()) {
                Ok(digest) => println!("{digest}"),
                Err(error) => {
                    print_error(&error.to_string());
                    std::process::exit(2);
                }
            }
            return;
        }
    }
    if std::env::args().any(|arg| arg == "--version") {
        println!(
            "rudder-update-helper {} protocol=1",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    let request_path = std::env::args()
        .skip(1)
        .collect::<Vec<_>>()
        .windows(2)
        .find(|args| args[0] == "--request")
        .map(|args| args[1].clone());
    let input = match read_request() {
        Ok(input) => input,
        Err(error) => {
            remove_request_file(request_path.as_deref());
            print_error(&error.to_string());
            std::process::exit(2);
        }
    };
    let request: UpdateRequest = match serde_json::from_slice(&input) {
        Ok(request) => request,
        Err(error) => {
            remove_request_file(request_path.as_deref());
            print_error(&format!("invalid request JSON: {error}"));
            std::process::exit(2);
        }
    };
    let result = execute(&request);
    remove_request_file(request_path.as_deref());
    match result {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string(&result).expect("helper result serializes")
            );
            if !result.ok && result.recovery_required {
                std::process::exit(4);
            }
            if !result.ok && result.rolled_back {
                std::process::exit(3);
            }
        }
        Err(error) => {
            print_error(&error.to_string());
            std::process::exit(2);
        }
    }
}

fn remove_request_file(path: Option<&str>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

fn read_request() -> Result<Vec<u8>, io::Error> {
    let mut args = std::env::args().skip(1);
    if let Some(flag) = args.next() {
        if flag == "--request" {
            let path = args.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "--request requires a path")
            })?;
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "request path must be a regular file",
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if metadata.uid() != unsafe { libc::getuid() }
                    || metadata.permissions().mode() & 0o7777 != 0o600
                {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "request owner or mode mismatch",
                    ));
                }
            }
            return fs::read(path);
        }
        if flag != "--stdin" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "use --request <path> or --stdin",
            ));
        }
    }
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    Ok(input)
}

fn print_error(message: &str) {
    println!("{}", serde_json::json!({ "ok": false, "error": message }));
}
