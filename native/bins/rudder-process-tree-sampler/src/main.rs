use std::collections::HashSet;
use std::env;
use std::io::{self, BufRead, Write};
use std::mem::{size_of, zeroed};
use std::process;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
const SAMPLER_QOS_CLASS: &str = "user_interactive";

#[cfg(target_os = "macos")]
fn configure_sampler_qos() -> io::Result<&'static str> {
    let result = unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0)
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }

    let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
    let mut priority = 0;
    let result = unsafe {
        libc::pthread_get_qos_class_np(
            libc::pthread_self(),
            &mut class as *mut libc::qos_class_t,
            &mut priority,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    if class as u32 != libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE as u32 || priority != 0 {
        return Err(io::Error::other(
            "sampler thread did not retain USER_INTERACTIVE QoS",
        ));
    }
    Ok(SAMPLER_QOS_CLASS)
}

#[cfg(not(target_os = "macos"))]
fn configure_sampler_qos() -> io::Result<&'static str> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree sampler QoS is currently admitted only on macOS",
    ))
}

#[derive(Clone)]
struct ProcessIdentity {
    pid: i32,
    ppid: i32,
    name: String,
}

#[derive(Clone)]
struct ProcessSample {
    identity: ProcessIdentity,
    rss_bytes: u64,
    cpu_ns: u64,
}

#[cfg(target_os = "macos")]
fn child_pids(parent_pid: i32) -> io::Result<Vec<i32>> {
    let pid_count = unsafe { libc::proc_listchildpids(parent_pid, std::ptr::null_mut(), 0) };
    if pid_count < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid_count == 0 {
        return Ok(Vec::new());
    }
    let mut pids = vec![0_i32; pid_count as usize + 16];
    let written = unsafe {
        libc::proc_listchildpids(
            parent_pid,
            pids.as_mut_ptr().cast(),
            (pids.len() * size_of::<i32>()) as i32,
        )
    };
    if written < 0 {
        return Err(io::Error::last_os_error());
    }
    pids.truncate(written as usize);
    Ok(pids.into_iter().filter(|pid| *pid > 0).collect())
}

#[cfg(target_os = "macos")]
fn process_identity(pid: i32) -> Option<ProcessIdentity> {
    let mut bsd: libc::proc_bsdinfo = unsafe { zeroed() };
    let bsd_size = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut bsd as *mut libc::proc_bsdinfo).cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if bsd_size != size_of::<libc::proc_bsdinfo>() as i32 {
        return None;
    }
    let name_end = bsd
        .pbi_name
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bsd.pbi_name.len());
    let name_bytes: Vec<u8> = bsd.pbi_name[..name_end]
        .iter()
        .map(|byte| *byte as u8)
        .collect();
    Some(ProcessIdentity {
        pid,
        ppid: bsd.pbi_ppid as i32,
        name: String::from_utf8_lossy(&name_bytes).into_owned(),
    })
}

#[cfg(not(target_os = "macos"))]
fn child_pids(_parent_pid: i32) -> io::Result<Vec<i32>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree sampler is currently admitted only on macOS",
    ))
}

#[cfg(not(target_os = "macos"))]
fn process_identity(_pid: i32) -> Option<ProcessIdentity> {
    None
}

fn process_tree(root_pid: i32, sampler_pid: i32) -> io::Result<Vec<ProcessSample>> {
    let mut included = HashSet::from([root_pid]);
    let mut pending = vec![root_pid];
    while let Some(parent) = pending.pop() {
        for child in child_pids(parent)? {
            if child != sampler_pid && included.insert(child) {
                pending.push(child);
            }
        }
    }
    let mut samples = Vec::with_capacity(included.len());
    for pid in &included {
        let Some(identity) = process_identity(*pid) else {
            continue;
        };
        if *pid != root_pid && !included.contains(&identity.ppid) {
            continue;
        }
        let mut task: libc::proc_taskinfo = unsafe { zeroed() };
        let task_size = unsafe {
            libc::proc_pidinfo(
                identity.pid,
                libc::PROC_PIDTASKINFO,
                0,
                (&mut task as *mut libc::proc_taskinfo).cast(),
                size_of::<libc::proc_taskinfo>() as i32,
            )
        };
        if task_size == size_of::<libc::proc_taskinfo>() as i32 {
            samples.push(ProcessSample {
                identity,
                rss_bytes: task.pti_resident_size,
                cpu_ns: task.pti_total_user.saturating_add(task.pti_total_system),
            });
        }
    }
    Ok(samples)
}

fn required_i32(value: Option<String>, label: &str) -> Result<i32, String> {
    value
        .ok_or_else(|| format!("missing {label}"))?
        .parse::<i32>()
        .map_err(|_| format!("invalid {label}"))
}

fn handle_metadata_args() -> bool {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("rudder-process-tree-sampler {}", env!("CARGO_PKG_VERSION"));
            true
        }
        Some("--protocol-version") => {
            println!("1");
            true
        }
        _ => false,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if handle_metadata_args() {
        return Ok(());
    }
    let mut args = env::args().skip(1);
    let root_pid = required_i32(args.next(), "root pid")?;
    let interval_ms = required_i32(args.next(), "interval ms")?;
    if root_pid <= 0 || interval_ms < 5 || args.next().is_some() {
        return Err("usage: rudder-process-tree-sampler <root-pid> <interval-ms>=5".into());
    }

    let stopped = Arc::new(AtomicBool::new(false));
    let input_stopped = Arc::clone(&stopped);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut line = String::new();
        while input.read_line(&mut line).is_ok_and(|bytes| bytes > 0) {
            if line.trim() == "stop" {
                break;
            }
            line.clear();
        }
        input_stopped.store(true, Ordering::Release);
    });

    let sampler_pid = process::id() as i32;
    let qos_class = configure_sampler_qos()?;
    let interval = Duration::from_millis(interval_ms as u64);
    let mut next_tick = Instant::now();
    let mut previous_sample_started: Option<Instant> = None;
    let stdout = io::stdout();
    let mut output = stdout.lock();
    writeln!(
        output,
        "{}",
        serde_json::json!({
            "type": "ready",
            "rootPid": root_pid,
            "samplerPid": sampler_pid,
            "intervalMs": interval_ms,
            "version": env!("CARGO_PKG_VERSION"),
            "protocolVersion": 1,
            "qosClass": qos_class,
            "source": "proc_listchildpids+PROC_PIDTBSDINFO+PROC_PIDTASKINFO"
        })
    )?;
    output.flush()?;

    while !stopped.load(Ordering::Acquire) {
        let started = Instant::now();
        let inter_sample_gap_ns = previous_sample_started
            .replace(started)
            .map(|previous| started.duration_since(previous).as_nanos());
        let epoch_ns = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        match process_tree(root_pid, sampler_pid) {
            Ok(processes) => {
                let duration_ns = started.elapsed().as_nanos();
                let tree_rss_bytes: u64 = processes.iter().map(|item| item.rss_bytes).sum();
                let tree_cpu_ns: u64 = processes.iter().map(|item| item.cpu_ns).sum();
                let rows: Vec<_> = processes
                    .iter()
                    .map(|item| {
                        serde_json::json!({
                            "pid": item.identity.pid,
                            "ppid": item.identity.ppid,
                            "name": item.identity.name,
                        "rssBytes": item.rss_bytes,
                        "cpuNs": item.cpu_ns.to_string(),
                        })
                    })
                    .collect();
                writeln!(
                    output,
                    "{}",
                    serde_json::json!({
                        "type": "sample",
                        "epochNs": epoch_ns.to_string(),
                        "interSampleGapNs": inter_sample_gap_ns.map(|value| value.to_string()),
                        "sampleDurationNs": duration_ns.to_string(),
                        "treeRssBytes": tree_rss_bytes,
                        "treeCpuNs": tree_cpu_ns.to_string(),
                        "processes": rows,
                    })
                )?;
                output.flush()?;
            }
            Err(error) => {
                writeln!(
                    output,
                    "{}",
                    serde_json::json!({ "type": "error", "message": error.to_string() })
                )?;
                output.flush()?;
                return Err(error.into());
            }
        }
        next_tick += interval;
        if let Some(delay) = next_tick.checked_duration_since(Instant::now()) {
            thread::sleep(delay);
        } else {
            next_tick = Instant::now();
        }
    }
    Ok(())
}
