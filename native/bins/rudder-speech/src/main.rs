use rudder_speech_core::{MAX_INPUT_BYTES, SpeechErrorCode, normalize_pcm_f32_le, transcribe};
use serde::Serialize;
use std::io::{self, Read};
use std::path::PathBuf;

const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    ok: bool,
    protocol_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

fn response_ok(text: String, language: Option<String>) -> Response {
    Response {
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        text: Some(text),
        language,
        error_code: None,
    }
}

fn response_error(code: SpeechErrorCode) -> Response {
    Response {
        ok: false,
        protocol_version: PROTOCOL_VERSION,
        text: None,
        language: None,
        error_code: Some(code.as_str().into()),
    }
}

fn required_arg(
    args: &mut impl Iterator<Item = String>,
    name: &str,
) -> Result<String, SpeechErrorCode> {
    args.next()
        .ok_or(SpeechErrorCode::InvalidAudio)
        .and_then(|value| {
            if value.is_empty() {
                Err(SpeechErrorCode::InvalidAudio)
            } else {
                let _ = name;
                Ok(value)
            }
        })
}

fn read_pcm() -> Result<Vec<u8>, SpeechErrorCode> {
    let mut input = Vec::with_capacity(MAX_INPUT_BYTES.min(64 * 1024));
    let mut limited = io::stdin().take((MAX_INPUT_BYTES + 1) as u64);
    limited
        .read_to_end(&mut input)
        .map_err(|_| SpeechErrorCode::InvalidAudio)?;
    if input.len() > MAX_INPUT_BYTES {
        return Err(SpeechErrorCode::InvalidAudio);
    }
    Ok(input)
}

fn run() -> Result<Response, SpeechErrorCode> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("transcribe") => {
            let model_flag = required_arg(&mut args, "model_flag")?;
            if model_flag != "--model" {
                return Err(SpeechErrorCode::InvalidAudio);
            }
            let model_path = PathBuf::from(required_arg(&mut args, "model_path")?);
            let sample_rate_flag = required_arg(&mut args, "sample_rate_flag")?;
            if sample_rate_flag != "--sample-rate" {
                return Err(SpeechErrorCode::InvalidAudio);
            }
            let sample_rate = required_arg(&mut args, "sample_rate")?
                .parse::<u32>()
                .map_err(|_| SpeechErrorCode::InvalidAudio)?;
            let channels_flag = required_arg(&mut args, "channels_flag")?;
            if channels_flag != "--channels" {
                return Err(SpeechErrorCode::InvalidAudio);
            }
            let channels = required_arg(&mut args, "channels")?
                .parse::<u16>()
                .map_err(|_| SpeechErrorCode::InvalidAudio)?;
            if args.next().is_some() {
                return Err(SpeechErrorCode::InvalidAudio);
            }
            let input = read_pcm()?;
            let normalized =
                normalize_pcm_f32_le(&input, sample_rate, channels).map_err(|error| error.code)?;
            let transcript =
                transcribe(&model_path, &normalized.samples).map_err(|error| error.code)?;
            Ok(response_ok(transcript.text, transcript.language))
        }
        _ => Err(SpeechErrorCode::InvalidAudio),
    }
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("rudder-speech {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("--capabilities") => {
            println!(
                "{}",
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": ["transcribe"],
                    "engine": "whisper-rs"
                })
            );
            return;
        }
        _ => {}
    }
    match run() {
        Ok(response) => {
            println!(
                "{}",
                serde_json::to_string(&response).expect("speech response serializes")
            );
        }
        Err(code) => {
            println!(
                "{}",
                serde_json::to_string(&response_error(code))
                    .expect("speech error response serializes")
            );
            eprintln!("rudder-speech: {}", code.as_str());
            std::process::exit(2);
        }
    }
}
