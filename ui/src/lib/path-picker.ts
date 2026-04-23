import { ApiError } from "../api/client";

export function shouldFallbackToManualPathInstructions(error: unknown) {
  return error instanceof ApiError && error.status === 422;
}

export function getPathPickerFailureMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Couldn't open the system path picker.";
}
