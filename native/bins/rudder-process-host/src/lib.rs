mod host;

pub use host::{
    ChannelLifecycleSink, HostInput, LifecycleEvent, LifecycleEventReceiver, LifecycleSink,
    MAX_FRAME_BYTES, WriterLifecycleSink, lifecycle_channel, run_host,
};

/// Version of the opt-in newline-delimited JSON stdio multiplexer.
pub const MUX_VERSION: u16 = 1;
/// Maximum encoded bytes in one stdio-mux envelope, including its newline.
pub const MUX_MAX_FRAME_BYTES: usize = 32 * 1024;
/// Maximum raw child-output bytes carried by one stdio-mux envelope.
pub const MUX_MAX_RAW_BYTES: usize = 8 * 1024;
