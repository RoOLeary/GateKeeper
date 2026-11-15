import type { AuthorizationDecision } from "./authorization/policy";

export type ServiceErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "internal";

/**
 * An expected, user-safe failure. Messages are written for end users and the model;
 * they must never contain stack traces, SQL or secrets.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly decision?: AuthorizationDecision,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}
