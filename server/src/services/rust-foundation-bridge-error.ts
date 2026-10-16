export class RustFoundationBridgeError extends Error {
  constructor(
    public readonly code:
      | "invalid_mode"
      | "database_unconfigured"
      | "actor_envelope_unconfigured"
      | "binary_unavailable"
      | "startup_failed"
      | "not_ready"
      | "request_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RustFoundationBridgeError";
  }
}
