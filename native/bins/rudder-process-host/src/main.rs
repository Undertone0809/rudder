use rudder_native_protocol::{
    CAPABILITIES, Command, PROTOCOL_MAJOR, PROTOCOL_MINOR, PROTOCOL_VERSION,
};
use rudder_process_host::{
    HostInput, LifecycleEvent, LifecycleSink, MAX_FRAME_BYTES, WriterLifecycleSink, run_host,
};
use serde_json::{Value, json};
use std::io::{self, BufReader, Read};
use std::sync::{Arc, mpsc};
use std::thread;

mod stdio_mux;

fn main() {
    if handle_metadata_args() {
        return;
    }

    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--stdio-mux")) {
        std::process::exit(stdio_mux::run());
    }

    let lifecycle = match unsafe_fd(3) {
        Ok(writer) => Arc::new(WriterLifecycleSink::new(writer)) as Arc<dyn LifecycleSink>,
        Err(error) => {
            eprintln!("rudder-process-host: lifecycle channel unavailable: {error}");
            std::process::exit(2);
        }
    };
    let stdout = match unsafe_fd(4) {
        Ok(writer) => writer,
        Err(error) => {
            emit_startup_error(
                lifecycle.as_ref(),
                "stdout channel unavailable",
                "channel_unavailable",
            );
            eprintln!("rudder-process-host: stdout channel unavailable: {error}");
            std::process::exit(1);
        }
    };
    let stderr = match unsafe_fd(5) {
        Ok(writer) => writer,
        Err(error) => {
            emit_startup_error(
                lifecycle.as_ref(),
                "stderr channel unavailable",
                "channel_unavailable",
            );
            eprintln!("rudder-process-host: stderr channel unavailable: {error}");
            std::process::exit(1);
        }
    };

    let (input_tx, input_rx) = mpsc::sync_channel(1);
    thread::spawn(move || read_commands(input_tx));
    std::process::exit(run_host(
        input_rx,
        lifecycle,
        Box::new(stdout),
        Box::new(stderr),
    ));
}

fn handle_metadata_args() -> bool {
    let argument = std::env::args().nth(1);
    match argument.as_deref() {
        Some("--version") => {
            println!("rudder-process-host {}", env!("CARGO_PKG_VERSION"));
            true
        }
        Some("--protocol-version") => {
            println!("{PROTOCOL_VERSION}");
            true
        }
        Some("--capabilities") => {
            println!(
                "{}",
                serde_json::to_string(CAPABILITIES).expect("static capabilities serialize")
            );
            true
        }
        _ => false,
    }
}

fn read_commands(sender: mpsc::SyncSender<HostInput>) {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    loop {
        match read_bounded_frame(&mut reader) {
            Ok(Some(frame)) => match serde_json::from_slice::<Command>(&frame) {
                Ok(command) => {
                    if sender.send(HostInput::Command(command)).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(HostInput::Invalid("invalid_command"));
                    return;
                }
            },
            Err(FrameError::TooLarge) => {
                let _ = sender.send(HostInput::Invalid("command_too_large"));
                return;
            }
            Err(FrameError::Io) => {
                let _ = sender.send(HostInput::Invalid("command_read_failed"));
                return;
            }
            Ok(None) => break,
        }
    }
    let _ = sender.send(HostInput::Eof);
}

#[derive(Debug)]
enum FrameError {
    TooLarge,
    Io,
}

fn read_bounded_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, FrameError> {
    let mut frame = Vec::with_capacity(MAX_FRAME_BYTES.min(1024));
    let mut byte = [0_u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) if frame.is_empty() => return Ok(None),
            Ok(0) => return Err(FrameError::Io),
            Ok(1) if byte[0] == b'\n' => {
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                return Ok(Some(frame));
            }
            Ok(1) => {
                if frame.len() >= MAX_FRAME_BYTES {
                    return Err(FrameError::TooLarge);
                }
                frame.push(byte[0]);
            }
            Ok(_) => unreachable!(),
            Err(_) => return Err(FrameError::Io),
        }
    }
}

fn emit_startup_error(sink: &dyn LifecycleSink, message: &str, code: &str) {
    let mut event = json!({
        "type": "terminal",
        "status": "failed",
        "errorCode": code,
        "message": message,
        "metrics": {"elapsedMs": 0, "bytesRead": 0, "bytesWritten": 0, "peakBufferedBytes": 0},
    });
    event["protocolVersion"] = json!({"major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR});
    event["requestId"] = Value::String("bootstrap".to_string());
    let _ = sink.emit(LifecycleEvent::new(event));
}

#[cfg(unix)]
fn unsafe_fd(fd: i32) -> io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    // The parent owns these inherited descriptors and closes them when the
    // host exits. File::from_raw_fd transfers that ownership to this process.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(windows)]
fn unsafe_fd(fd: i32) -> io::Result<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, GetLastError, HANDLE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // Node passes extra stdio entries through the MSVC CRT fd table. The fd
    // number is not itself a Windows HANDLE, so duplicate the CRT handle
    // before giving ownership to File. This also prevents the CRT cleanup
    // from closing the handle owned by File at process shutdown.
    let handle = unsafe { libc::get_osfhandle(fd) };
    if handle == -1 {
        return Err(io::Error::last_os_error());
    }
    let mut duplicate: HANDLE = std::ptr::null_mut();
    let current = unsafe { GetCurrentProcess() };
    let duplicated = unsafe {
        DuplicateHandle(
            current,
            handle as HANDLE,
            current,
            &mut duplicate,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if duplicated == 0 {
        return Err(io::Error::from_raw_os_error(unsafe {
            GetLastError() as i32
        }));
    }
    Ok(unsafe { std::fs::File::from_raw_handle(duplicate) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdin_frame_reader_preserves_unicode_and_adjacent_frame_boundaries() {
        let commands = [
            json!({
                "type": "writeStdin",
                "protocolVersion": { "major": 1, "minor": 0 },
                "requestId": "test",
                "ownerToken": "operation",
                "writeId": "unicode",
                "data": "你好🌱\n",
            }),
            json!({
                "type": "closeStdin",
                "protocolVersion": { "major": 1, "minor": 0 },
                "requestId": "test",
                "ownerToken": "operation",
                "closeId": "close",
            }),
        ];
        let mut frames = Vec::new();
        for command in commands {
            frames.extend(serde_json::to_vec(&command).unwrap());
            frames.push(b'\n');
        }
        let mut reader = io::Cursor::new(frames);
        let first = read_bounded_frame(&mut reader).unwrap().unwrap();
        let first: Command = serde_json::from_slice(&first).unwrap();
        assert!(matches!(first, Command::WriteStdin { ref data, .. } if data == "你好🌱\n"));
        assert_eq!(first.validate(), Ok(()));
        let second = read_bounded_frame(&mut reader).unwrap().unwrap();
        let second: Command = serde_json::from_slice(&second).unwrap();
        assert!(matches!(second, Command::CloseStdin { .. }));
        assert_eq!(second.validate(), Ok(()));
        assert!(read_bounded_frame(&mut reader).unwrap().is_none());
    }
}
