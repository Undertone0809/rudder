use crate::{Message, ProtocolError};
use rudder_native_protocol::lines::{LineDecoder, LineError};

pub use rudder_native_protocol::lines::{
    MAX_NATIVE_CHUNK_BYTES as MAX_CHUNK_BYTES, MAX_NATIVE_FRAME_BYTES as MAX_FRAME_BYTES,
};

#[derive(Default)]
pub struct FrameDecoder(LineDecoder);

impl FrameDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Message>, ProtocolError> {
        self.0.push(chunk, Message::decode)
    }

    pub fn finish(&mut self) -> Result<(), ProtocolError> {
        self.0.finish().map_err(Into::into)
    }
}

impl From<LineError> for ProtocolError {
    fn from(error: LineError) -> Self {
        match error {
            LineError::ChunkTooLarge => Self::ChunkTooLarge,
            LineError::FrameTooLarge => Self::FrameTooLarge,
            LineError::TruncatedFrame => Self::TruncatedFrame,
            LineError::StreamFailed => Self::StreamFailed,
        }
    }
}
