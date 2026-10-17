//! Bounded LF framing for native process protocols. Adapter parsing remains
//! outside this module; records need not be JSON-RPC messages.

pub const MAX_NATIVE_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_NATIVE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineError {
    ChunkTooLarge,
    FrameTooLarge,
    TruncatedFrame,
    StreamFailed,
}

#[derive(Default)]
pub struct LineDecoder {
    pending: Vec<u8>,
    failed: bool,
    finished: bool,
}

impl LineDecoder {
    /// Any framing or adapter error discards the batch and poisons the stream.
    /// Splitting only on LF preserves partial UTF-8 and Unicode separators.
    pub fn push<T, E: From<LineError>>(
        &mut self,
        chunk: &[u8],
        mut parse: impl FnMut(&[u8]) -> Result<T, E>,
    ) -> Result<Vec<T>, E> {
        if self.failed || self.finished {
            return Err(LineError::StreamFailed.into());
        }
        let result = self.decode(chunk, &mut parse);
        if result.is_err() {
            self.pending.clear();
            self.failed = true;
        }
        result
    }

    fn decode<T, E: From<LineError>>(
        &mut self,
        chunk: &[u8],
        parse: &mut impl FnMut(&[u8]) -> Result<T, E>,
    ) -> Result<Vec<T>, E> {
        if chunk.len() > MAX_NATIVE_CHUNK_BYTES {
            return Err(LineError::ChunkTooLarge.into());
        }
        let mut records = Vec::new();
        for piece in chunk.split_inclusive(|byte| *byte == b'\n') {
            let terminated = piece.last() == Some(&b'\n');
            let content = if terminated {
                &piece[..piece.len() - 1]
            } else {
                piece
            };
            if self.pending.len().saturating_add(content.len()) > MAX_NATIVE_FRAME_BYTES {
                return Err(LineError::FrameTooLarge.into());
            }
            self.pending.extend_from_slice(content);
            if terminated {
                if self.pending.last() == Some(&b'\r') {
                    self.pending.pop();
                }
                if !self.pending.is_empty() {
                    records.push(parse(&self.pending)?);
                }
                self.pending.clear();
            }
        }
        Ok(records)
    }

    pub fn finish(&mut self) -> Result<(), LineError> {
        if self.failed {
            return Err(LineError::StreamFailed);
        }
        self.finished = true;
        if self.pending.is_empty() {
            return Ok(());
        }
        self.pending.clear();
        self.failed = true;
        Err(LineError::TruncatedFrame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    enum TestError {
        Framing(LineError),
        Invalid,
    }
    impl From<LineError> for TestError {
        fn from(value: LineError) -> Self {
            Self::Framing(value)
        }
    }
    fn json(frame: &[u8]) -> Result<serde_json::Value, TestError> {
        serde_json::from_slice(frame).map_err(|_| TestError::Invalid)
    }

    #[test]
    fn non_rpc_records_preserve_unicode_at_every_byte_boundary() {
        let bytes = "{\"type\":\"response\",\"command\":\"prompt\",\"success\":true}\r\n{\"type\":\"message_update\",\"text\":\"你\u{2028}好\u{2029}🙂\"}\n".as_bytes();
        for split in 0..=bytes.len() {
            let mut decoder = LineDecoder::default();
            let mut records = decoder.push(&bytes[..split], json).unwrap();
            records.extend(decoder.push(&bytes[split..], json).unwrap());
            decoder.finish().unwrap();
            assert_eq!(records.len(), 2);
            assert_eq!(records[1]["text"], "你\u{2028}好\u{2029}🙂");
        }
    }

    #[test]
    fn adapter_failure_discards_batch_and_prevents_continuation() {
        let mut decoder = LineDecoder::default();
        assert_eq!(
            decoder.push(b"{}\ninvalid\n", json),
            Err(TestError::Invalid)
        );
        assert_eq!(
            decoder.push(b"{}\n", json),
            Err(TestError::Framing(LineError::StreamFailed))
        );
        assert_eq!(decoder.finish(), Err(LineError::StreamFailed));
    }

    #[test]
    fn limits_truncation_and_finished_stream_fail_closed() {
        let mut decoder = LineDecoder::default();
        assert_eq!(
            decoder.push(&vec![b'a'; MAX_NATIVE_CHUNK_BYTES + 1], json),
            Err(TestError::Framing(LineError::ChunkTooLarge))
        );
        let mut decoder = LineDecoder::default();
        for _ in 0..MAX_NATIVE_FRAME_BYTES / MAX_NATIVE_CHUNK_BYTES {
            assert!(
                decoder
                    .push(&vec![b'a'; MAX_NATIVE_CHUNK_BYTES], json)
                    .unwrap()
                    .is_empty()
            );
        }
        assert_eq!(
            decoder.push(b"a", json),
            Err(TestError::Framing(LineError::FrameTooLarge))
        );
        let mut decoder = LineDecoder::default();
        decoder.push(b"{}", json).unwrap();
        assert_eq!(decoder.finish(), Err(LineError::TruncatedFrame));
        let mut decoder = LineDecoder::default();
        decoder.finish().unwrap();
        assert_eq!(
            decoder.push(b"{}\n", json),
            Err(TestError::Framing(LineError::StreamFailed))
        );
    }
}
