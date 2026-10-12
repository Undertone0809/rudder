//! Grow only command-stack work; retain the existing read helper's depth guard.
use serde_json::Value;
pub(super) fn stack<T>(f: impl FnOnce() -> T) -> T {
    stacker::maybe_grow(16 * 1024 * 1024, 32 * 1024 * 1024, f)
}
pub(super) fn parse(raw: &str) -> Result<Value, serde_json::Error> {
    stack(|| crate::legacy_read_json::parse_legacy_command_json(raw))
}
pub(super) async fn run<F: std::future::Future>(future: F) -> F::Output {
    struct StackFuture<F> {
        future: Option<std::pin::Pin<Box<F>>>,
    }
    impl<F: std::future::Future> std::future::Future for StackFuture<F> {
        type Output = F::Output;
        fn poll(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Self::Output> {
            stack(|| self.future.as_mut().expect("future").as_mut().poll(cx))
        }
    }
    impl<F> Drop for StackFuture<F> {
        fn drop(&mut self) {
            stack(|| drop(self.future.take()));
        }
    }
    StackFuture {
        future: Some(Box::pin(future)),
    }
    .await
}
