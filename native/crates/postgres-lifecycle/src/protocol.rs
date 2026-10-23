use crate::{error::OwnerError, owner::OwnerSession};
use serde::{Deserialize, Serialize};
use std::{future::Future, io, path::PathBuf};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader},
    sync::watch,
};

pub const PROTOCOL_SCHEMA: &str = "rudder.postgres-owner.v1";
const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct StartRequest {
    pub schema: String,
    pub op: String,
    pub instance_id: String,
    pub data_dir: PathBuf,
    pub port: u16,
    pub bin_dir: PathBuf,
    pub database: String,
    pub user: String,
    pub password: String,
    #[serde(default)]
    pub fallback_passwords: Vec<String>,
    #[serde(default)]
    pub parent_pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct StopRequest {
    pub schema: String,
    pub op: String,
    pub lease_id: String,
}

#[derive(Debug, Serialize)]
pub struct ReadyResponse {
    pub schema: &'static str,
    pub op: &'static str,
    pub instance_id: String,
    pub lease_id: String,
    pub data_dir: PathBuf,
    pub port: u16,
    pub postgres_version: String,
    pub connection_string: String,
    pub bin_dir: PathBuf,
    pub cluster_created: bool,
    pub database_created: bool,
    pub owned: bool,
}

#[derive(Debug, Serialize)]
pub struct StoppedResponse {
    pub schema: &'static str,
    pub op: &'static str,
    pub lease_id: String,
}

#[derive(Debug, Serialize)]
struct SignalStoppedResponse {
    schema: &'static str,
    op: &'static str,
    signal: &'static str,
    instance_id: String,
    lease_id: String,
    data_dir: PathBuf,
    port: u16,
    owner_pid: u32,
}

struct TerminationSignal {
    #[cfg(unix)]
    inner: tokio::signal::unix::Signal,
}

impl TerminationSignal {
    fn register() -> io::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self {
                inner: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
            })
        }

        #[cfg(not(unix))]
        {
            Ok(Self {})
        }
    }

    async fn wait(&mut self) {
        #[cfg(unix)]
        {
            let _ = self.inner.recv().await;
        }

        #[cfg(not(unix))]
        {
            std::future::pending::<()>().await;
        }
    }
}

/// Process a start request and then one or more stop requests. EOF before
/// readiness cancels startup; EOF after readiness stops the owned process.
pub async fn run_protocol() -> i32 {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut input = AsyncBufReader::new(stdin);
    let mut output = tokio::io::BufWriter::new(stdout);
    let mut termination = match TerminationSignal::register() {
        Ok(signal) => signal,
        Err(error) => {
            let _ = write_error(
                &mut output,
                OwnerError::io(
                    "signal_handler_unavailable",
                    "cannot register PostgreSQL owner termination handler",
                    error,
                ),
            )
            .await;
            return 2;
        }
    };
    let mut frame = String::new();
    enum InitialReadEvent {
        Signal,
        Input(Result<Option<usize>, OwnerError>),
    }
    let initial_read = tokio::select! {
        biased;
        _ = termination.wait() => InitialReadEvent::Signal,
        result = read_frame(&mut input, &mut frame) => InitialReadEvent::Input(result),
    };
    match initial_read {
        InitialReadEvent::Signal => {
            let _ = write_error(
                &mut output,
                OwnerError::new(
                    "protocol_start_cancelled",
                    "owner received SIGTERM before a start request; no PostgreSQL process was started",
                ),
            )
            .await;
            return 1;
        }
        InitialReadEvent::Input(Ok(Some(_))) => {}
        InitialReadEvent::Input(Ok(None)) => {
            let _ = write_error(
                &mut output,
                OwnerError::new("protocol_missing_start", "expected a start request"),
            )
            .await;
            return 2;
        }
        InitialReadEvent::Input(Err(error)) => {
            let _ = write_error(&mut output, error).await;
            return 2;
        }
    }
    let request: StartRequest = match serde_json::from_str(frame.trim_end()) {
        Ok(request) => request,
        Err(_) => {
            let _ = write_error(
                &mut output,
                OwnerError::new("protocol_invalid_json", "start request is not valid JSON"),
            )
            .await;
            return 2;
        }
    };
    let (cancel_sender, cancel_receiver) = watch::channel(false);
    let mut startup = Box::pin(start_or_cancel(
        request,
        &mut input,
        cancel_sender.clone(),
        cancel_receiver,
    ));
    enum StartupEvent {
        Signal,
        Completed(Box<Result<OwnerSession, OwnerError>>),
    }
    let startup_event = tokio::select! {
        biased;
        _ = termination.wait() => StartupEvent::Signal,
        result = &mut startup => StartupEvent::Completed(Box::new(result)),
    };
    let startup_result = match startup_event {
        StartupEvent::Signal => {
            let _ = cancel_sender.send(true);
            match startup.as_mut().await {
                Ok(mut session) => {
                    if write_json_line(&mut output, session.ready()).await.is_err() {
                        let _ = session.stop_for_parent_exit().await;
                        return 1;
                    }
                    return stop_for_signal(&mut session, &mut output).await;
                }
                Err(error) => {
                    let _ = write_error(&mut output, error).await;
                    return 1;
                }
            }
        }
        StartupEvent::Completed(result) => *result,
    };
    drop(startup);
    let mut session = match startup_result {
        Ok(session) => session,
        Err(error) => {
            let _ = write_error(&mut output, error).await;
            return 1;
        }
    };
    match write_ready_or_signal(session.ready(), &mut output, termination.wait()).await {
        Ok(true) => return stop_for_signal(&mut session, &mut output).await,
        Ok(false) => {}
        Err(_) => {
            let _ = session.stop_for_parent_exit().await;
            return 1;
        }
    }

    loop {
        frame.clear();
        enum InputEvent {
            Signal,
            Input(Result<Option<usize>, OwnerError>),
        }
        let input_event = tokio::select! {
            biased;
            _ = termination.wait() => InputEvent::Signal,
            result = session.wait_for_input_or_parent(&mut input, &mut frame) => InputEvent::Input(result),
        };
        let input_result = match input_event {
            InputEvent::Signal => return stop_for_signal(&mut session, &mut output).await,
            InputEvent::Input(result) => result,
        };
        match input_result {
            Ok(Some(0)) => match session.stop(&session.ready.lease_id.clone()).await {
                Ok(()) => {
                    let response = session.stopped_response();
                    let _ = write_json_line(&mut output, &response).await;
                    return 0;
                }
                Err(error) => {
                    let _ = write_error(&mut output, error).await;
                    return 1;
                }
            },
            Ok(None) => {
                if session.stopped {
                    let response = session.stopped_response();
                    let _ = write_json_line(&mut output, &response).await;
                    return 0;
                }
            }
            Ok(Some(_)) => {
                let request: StopRequest = match serde_json::from_str(frame.trim_end()) {
                    Ok(request) => request,
                    Err(_) => {
                        if write_error(
                            &mut output,
                            OwnerError::new(
                                "protocol_invalid_json",
                                "stop request is not valid JSON",
                            ),
                        )
                        .await
                        .is_err()
                        {
                            return 2;
                        }
                        continue;
                    }
                };
                if request.schema != PROTOCOL_SCHEMA || request.op != "stop" {
                    if write_error(
                        &mut output,
                        OwnerError::new(
                            "protocol_invalid_operation",
                            "expected a stop request with the supported schema",
                        ),
                    )
                    .await
                    .is_err()
                    {
                        return 2;
                    }
                    continue;
                }
                match session.stop(&request.lease_id).await {
                    Ok(()) => {
                        let response = session.stopped_response();
                        if write_json_line(&mut output, &response).await.is_err() {
                            return 0;
                        }
                        return 0;
                    }
                    Err(error) => {
                        if write_error(&mut output, error).await.is_err() {
                            return 1;
                        }
                    }
                }
            }
            Err(error) => {
                if write_error(&mut output, error).await.is_err() {
                    let _ = session.stop_for_parent_exit().await;
                    return 1;
                }
                if session.parent_exited() {
                    return 1;
                }
            }
        }
        if session.stopped {
            let response = session.stopped_response();
            let _ = write_json_line(&mut output, &response).await;
            return 0;
        }
    }
}

async fn start_or_cancel<R: AsyncBufReadExt + Unpin>(
    request: StartRequest,
    input: &mut R,
    cancel_sender: watch::Sender<bool>,
    cancel_receiver: watch::Receiver<bool>,
) -> Result<OwnerSession, OwnerError> {
    let mut startup = Box::pin(OwnerSession::start(request, cancel_receiver));
    let mut premature_frame = String::new();
    tokio::select! {
        result = &mut startup => result,
        frame = read_frame(input, &mut premature_frame) => match frame {
            Ok(None) => {
                let _ = cancel_sender.send(true);
                match startup.await {
                    Ok(mut session) => {
                        session.stop_for_parent_exit().await.map_err(|error| {
                            OwnerError::new(
                                "protocol_start_cancel_cleanup_failed",
                                format!("startup completed during cancellation but cleanup failed ({})", error.code),
                            )
                        })?;
                        Err(OwnerError::new(
                            "protocol_start_cancelled",
                            "owner input closed before PostgreSQL became ready; startup resources were cleaned up",
                        ))
                    }
                    Err(error) => Err(error),
                }
            }
            Ok(Some(_)) => {
                let _ = cancel_sender.send(true);
                match startup.await {
                    Ok(mut session) => {
                        session.stop_for_parent_exit().await.map_err(|error| {
                            OwnerError::new(
                                "protocol_start_cancel_cleanup_failed",
                                format!("startup completed while an unexpected frame arrived and cleanup failed ({})", error.code),
                            )
                        })?;
                        Err(OwnerError::new(
                            "protocol_invalid_operation",
                            "received another protocol frame before PostgreSQL became ready",
                        ))
                    }
                    Err(error) if error.code == "protocol_start_cancelled" => Err(OwnerError::new(
                        "protocol_invalid_operation",
                        "received another protocol frame before PostgreSQL became ready",
                    )),
                    Err(error) => Err(error),
                }
            }
            Err(error) => {
                let _ = cancel_sender.send(true);
                match startup.await {
                    Ok(mut session) => {
                        session.stop_for_parent_exit().await.map_err(|cleanup| {
                            OwnerError::new(
                                "protocol_start_cancel_cleanup_failed",
                                format!("protocol read failed and startup cleanup failed ({})", cleanup.code),
                            )
                        })?;
                        Err(error)
                    }
                    Err(cleanup) if cleanup.code == "protocol_start_cancel_cleanup_failed" => {
                        Err(cleanup)
                    }
                    Err(_) => Err(error),
                }
            }
        }
    }
}

fn signal_stopped_response(session: &OwnerSession) -> SignalStoppedResponse {
    SignalStoppedResponse {
        schema: PROTOCOL_SCHEMA,
        op: "signal_stopped",
        signal: "SIGTERM",
        instance_id: session.ready.instance_id.clone(),
        lease_id: session.ready.lease_id.clone(),
        data_dir: session.ready.data_dir.clone(),
        port: session.ready.port,
        owner_pid: std::process::id(),
    }
}

async fn write_ready_or_signal<W, F>(
    ready: &ReadyResponse,
    output: &mut W,
    signal: F,
) -> io::Result<bool>
where
    W: tokio::io::AsyncWrite + Unpin,
    F: Future<Output = ()>,
{
    write_json_line_unflushed(output, ready).await?;
    let flush = output.flush();
    tokio::pin!(flush);
    tokio::select! {
        biased;
        _ = signal => {
            flush.await?;
            Ok(true)
        },
        result = &mut flush => result.map(|()| false),
    }
}

async fn stop_for_signal<W: tokio::io::AsyncWrite + Unpin>(
    session: &mut OwnerSession,
    output: &mut W,
) -> i32 {
    match session.stop_for_parent_exit().await {
        Ok(()) => {
            let response = signal_stopped_response(session);
            if write_json_line(output, &response).await.is_ok() {
                0
            } else {
                1
            }
        }
        Err(error) => {
            let _ = write_error(output, error).await;
            1
        }
    }
}

async fn read_frame<R: AsyncBufReadExt + Unpin>(
    input: &mut R,
    frame: &mut String,
) -> Result<Option<usize>, OwnerError> {
    let read = input.read_line(frame).await.map_err(|error| {
        OwnerError::io("protocol_read_failed", "cannot read owner protocol", error)
    })?;
    if read > MAX_FRAME_BYTES {
        return Err(OwnerError::new(
            "protocol_frame_too_large",
            "owner protocol frame exceeds the size limit",
        ));
    }
    Ok((read > 0).then_some(read))
}

async fn write_error<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    error: OwnerError,
) -> io::Result<()> {
    write_json_line(output, &error.response()).await
}

async fn write_json_line<W: tokio::io::AsyncWrite + Unpin, T: Serialize>(
    output: &mut W,
    value: &T,
) -> io::Result<()> {
    write_json_line_unflushed(output, value).await?;
    output.flush().await
}

async fn write_json_line_unflushed<W: tokio::io::AsyncWrite + Unpin, T: Serialize>(
    output: &mut W,
    value: &T,
) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    output.write_all(&bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn ready_response() -> ReadyResponse {
        ReadyResponse {
            schema: PROTOCOL_SCHEMA,
            op: "ready",
            instance_id: "signal-race-test".into(),
            lease_id: "lease-race-test".into(),
            data_dir: PathBuf::from("/tmp/rudder-owner-race"),
            port: 54321,
            postgres_version: "18.4".into(),
            connection_string: "postgres://rudder@127.0.0.1:54321/rudder".into(),
            bin_dir: PathBuf::from("/tmp/postgres/bin"),
            cluster_created: false,
            database_created: false,
            owned: true,
        }
    }

    #[tokio::test]
    async fn signal_during_ready_write_waits_for_the_complete_flushed_frame() {
        let ready = ready_response();
        let (mut writer, mut reader) = tokio::io::duplex(8);
        let (signal_sender, signal_receiver) = tokio::sync::oneshot::channel();
        let writer_task = tokio::spawn(async move {
            write_ready_or_signal(&ready, &mut writer, async {
                let _ = signal_receiver.await;
            })
            .await
            .unwrap()
        });

        tokio::task::yield_now().await;
        signal_sender.send(()).unwrap();
        let mut frame = Vec::new();
        reader.read_to_end(&mut frame).await.unwrap();
        assert!(writer_task.await.unwrap());
        assert_eq!(frame.last(), Some(&b'\n'));
        let response: serde_json::Value =
            serde_json::from_slice(&frame[..frame.len() - 1]).unwrap();
        assert_eq!(response["op"], "ready");
        assert_eq!(response["instance_id"], "signal-race-test");
    }
}
