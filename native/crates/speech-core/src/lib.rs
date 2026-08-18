use serde::Serialize;
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const WHISPER_SAMPLE_RATE: u32 = 16_000;
pub const MIN_INPUT_SAMPLE_RATE: u32 = 8_000;
pub const MAX_INPUT_SAMPLE_RATE: u32 = 48_000;
pub const MAX_INPUT_SECONDS: u32 = 60;
pub const MAX_INPUT_BYTES: usize =
    MAX_INPUT_SAMPLE_RATE as usize * MAX_INPUT_SECONDS as usize * std::mem::size_of::<f32>();
const SILENCE_RMS_THRESHOLD: f32 = 0.0001;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechErrorCode {
    InvalidAudio,
    EmptyAudio,
    ModelUnavailable,
    EngineFailed,
    Cancelled,
}

impl SpeechErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidAudio => "invalid_audio",
            Self::EmptyAudio => "empty_audio",
            Self::ModelUnavailable => "model_unavailable",
            Self::EngineFailed => "engine_failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechError {
    pub code: SpeechErrorCode,
}

impl SpeechError {
    pub const fn new(code: SpeechErrorCode) -> Self {
        Self { code }
    }
}

impl From<SpeechErrorCode> for SpeechError {
    fn from(code: SpeechErrorCode) -> Self {
        Self::new(code)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedPcm {
    pub samples: Vec<f32>,
    pub source_sample_rate: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
}

pub fn normalize_pcm_f32_le(
    bytes: &[u8],
    sample_rate: u32,
    channels: u16,
) -> Result<NormalizedPcm, SpeechError> {
    if channels != 1
        || !(MIN_INPUT_SAMPLE_RATE..=MAX_INPUT_SAMPLE_RATE).contains(&sample_rate)
        || bytes.is_empty()
        || bytes.len() > MAX_INPUT_BYTES
        || bytes.len() as u64
            > sample_rate as u64 * MAX_INPUT_SECONDS as u64 * std::mem::size_of::<f32>() as u64
        || !bytes.len().is_multiple_of(std::mem::size_of::<f32>())
    {
        return Err(SpeechErrorCode::InvalidAudio.into());
    }

    let mut samples = Vec::with_capacity(bytes.len() / std::mem::size_of::<f32>());
    for chunk in bytes.chunks_exact(std::mem::size_of::<f32>()) {
        let sample = f32::from_le_bytes(chunk.try_into().expect("f32 chunks are four bytes"));
        if !sample.is_finite() {
            return Err(SpeechErrorCode::InvalidAudio.into());
        }
        samples.push(sample.clamp(-1.0, 1.0));
    }

    if samples.is_empty() || is_silent(&samples) {
        return Err(SpeechErrorCode::EmptyAudio.into());
    }

    let samples = if sample_rate == WHISPER_SAMPLE_RATE {
        samples
    } else {
        resample_linear(&samples, sample_rate, WHISPER_SAMPLE_RATE)
    };

    if samples.is_empty() {
        return Err(SpeechErrorCode::EmptyAudio.into());
    }

    Ok(NormalizedPcm {
        samples,
        source_sample_rate: sample_rate,
    })
}

fn is_silent(samples: &[f32]) -> bool {
    let mean_square =
        samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32;
    mean_square.sqrt() <= SILENCE_RMS_THRESHOLD
}

fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    let output_len = ((samples.len() as u64 * target_rate as u64) / source_rate as u64) as usize;
    if output_len == 0 {
        return Vec::new();
    }
    let source_scale = source_rate as f64 / target_rate as f64;
    (0..output_len)
        .map(|index| {
            let source_position = index as f64 * source_scale;
            let left = source_position.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let fraction = (source_position - left as f64) as f32;
            samples[left.min(samples.len() - 1)] * (1.0 - fraction) + samples[right] * fraction
        })
        .collect()
}

pub fn transcribe(model_path: &Path, audio: &[f32]) -> Result<Transcript, SpeechError> {
    if !model_path.is_file() {
        return Err(SpeechErrorCode::ModelUnavailable.into());
    }
    if audio.is_empty() {
        return Err(SpeechErrorCode::EmptyAudio.into());
    }

    let mut context_parameters = WhisperContextParameters::default();
    context_parameters.use_gpu(false);
    let context = WhisperContext::new_with_params(model_path, context_parameters)
        .map_err(|_| SpeechErrorCode::ModelUnavailable)?;
    let mut state = context
        .create_state()
        .map_err(|_| SpeechErrorCode::EngineFailed)?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(None);
    params.set_detect_language(true);
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_single_segment(false);
    params.set_translate(false);
    state
        .full(params, audio)
        .map_err(|_| SpeechErrorCode::EngineFailed)?;

    let mut text = String::new();
    for segment in state.as_iter() {
        let segment_text = segment
            .to_str_lossy()
            .map_err(|_| SpeechErrorCode::EngineFailed)?
            .trim()
            .to_string();
        if segment_text.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&segment_text);
    }

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(SpeechErrorCode::EmptyAudio.into());
    }
    let language = whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_string);
    Ok(Transcript { text, language })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(samples: &[f32]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    #[test]
    fn rejects_invalid_pcm_metadata_and_payloads() {
        assert_eq!(
            normalize_pcm_f32_le(&bytes(&[0.1]), 16_000, 2)
                .unwrap_err()
                .code,
            SpeechErrorCode::InvalidAudio
        );
        assert_eq!(
            normalize_pcm_f32_le(&[1, 2, 3], 16_000, 1)
                .unwrap_err()
                .code,
            SpeechErrorCode::InvalidAudio
        );
        assert_eq!(
            normalize_pcm_f32_le(&bytes(&[f32::NAN]), 16_000, 1)
                .unwrap_err()
                .code,
            SpeechErrorCode::InvalidAudio
        );
    }

    #[test]
    fn treats_empty_and_silent_audio_as_empty() {
        assert_eq!(
            normalize_pcm_f32_le(&[], 16_000, 1).unwrap_err().code,
            SpeechErrorCode::InvalidAudio
        );
        assert_eq!(
            normalize_pcm_f32_le(&bytes(&[0.0; 32]), 16_000, 1)
                .unwrap_err()
                .code,
            SpeechErrorCode::EmptyAudio
        );
    }

    #[test]
    fn rejects_audio_longer_than_the_duration_limit() {
        let samples = vec![0.2; MIN_INPUT_SAMPLE_RATE as usize * MAX_INPUT_SECONDS as usize + 1];
        let bytes = bytes(&samples);
        assert_eq!(
            normalize_pcm_f32_le(&bytes, MIN_INPUT_SAMPLE_RATE, 1)
                .unwrap_err()
                .code,
            SpeechErrorCode::InvalidAudio
        );
    }

    #[test]
    fn resamples_valid_audio_to_whisper_rate() {
        let result = normalize_pcm_f32_le(&bytes(&[0.2; 48_000]), 48_000, 1).unwrap();
        assert_eq!(result.samples.len(), 16_000);
        assert_eq!(result.source_sample_rate, 48_000);
        assert!(
            result
                .samples
                .iter()
                .all(|sample| (*sample - 0.2).abs() < 0.0001)
        );
    }

    #[test]
    fn clamps_samples_without_accepting_non_finite_values() {
        let result = normalize_pcm_f32_le(&bytes(&[2.0, -2.0]), 16_000, 1).unwrap();
        assert_eq!(result.samples, vec![1.0, -1.0]);
    }

    #[test]
    fn exposes_stable_error_codes() {
        assert_eq!(SpeechErrorCode::InvalidAudio.as_str(), "invalid_audio");
        assert_eq!(SpeechErrorCode::EmptyAudio.as_str(), "empty_audio");
        assert_eq!(
            SpeechErrorCode::ModelUnavailable.as_str(),
            "model_unavailable"
        );
        assert_eq!(SpeechErrorCode::EngineFailed.as_str(), "engine_failed");
        assert_eq!(SpeechErrorCode::Cancelled.as_str(), "cancelled");
    }
}
