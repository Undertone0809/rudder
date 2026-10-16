use crate::{Message, ProtocolError};

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// The process transport must feed bounded reads; a chunk may contain several
/// frames, and a single UTF-8 code point may span multiple chunks.
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Default)]
pub struct FrameDecoder {
    pending: Vec<u8>,
    failed: bool,
    finished: bool,
}

impl FrameDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Message>, ProtocolError> {
        if self.failed || self.finished {
            return Err(ProtocolError::StreamFailed);
        }
        let result = self.decode(chunk);
        if result.is_err() {
            self.pending.clear();
            self.failed = true;
        }
        result
    }

    fn decode(&mut self, chunk: &[u8]) -> Result<Vec<Message>, ProtocolError> {
        if chunk.len() > MAX_CHUNK_BYTES {
            return Err(ProtocolError::ChunkTooLarge);
        }
        let mut messages = Vec::new();
        for piece in chunk.split_inclusive(|byte| *byte == b'\n') {
            let terminated = piece.last() == Some(&b'\n');
            let content = if terminated {
                &piece[..piece.len() - 1]
            } else {
                piece
            };
            if self.pending.len().saturating_add(content.len()) > MAX_FRAME_BYTES {
                return Err(ProtocolError::FrameTooLarge);
            }
            self.pending.extend_from_slice(content);
            if terminated {
                if self.pending.last() == Some(&b'\r') {
                    self.pending.pop();
                }
                if !self.pending.is_empty() {
                    messages.push(Message::decode(&self.pending)?);
                }
                self.pending.clear();
            }
        }
        Ok(messages)
    }

    pub fn finish(&mut self) -> Result<(), ProtocolError> {
        if self.failed {
            return Err(ProtocolError::StreamFailed);
        }
        self.finished = true;
        if self.pending.is_empty() {
            return Ok(());
        }
        self.pending.clear();
        self.failed = true;
        Err(ProtocolError::TruncatedFrame)
    }
}
