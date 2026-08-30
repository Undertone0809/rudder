export class ApiRequestError extends Error {
  status: number;
  code?: string | null;
  details?: unknown;
  body?: unknown;

  constructor(status: number, message: string, details?: unknown, body?: unknown, code?: string | null) {
    super(message);
    this.status = status;
    this.code = code ?? null;
    this.details = details;
    this.body = body;
  }
}
