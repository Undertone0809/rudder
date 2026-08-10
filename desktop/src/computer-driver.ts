export type ComputerDriverImage = { mimeType: string; base64: string };

export type ComputerDriverResult = {
  text: string;
  structured: Record<string, unknown>;
  images: ComputerDriverImage[];
  action?: Record<string, unknown>;
};

export interface ComputerDriver {
  readonly generation: string;
  readonly version: string;
  startSession(runId: string, signal?: AbortSignal): Promise<void>;
  endSession(runId: string): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerDriverResult>;
  shutdown(): Promise<void>;
}

export class ComputerDriverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
