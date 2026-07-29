/** Every failure the UI can render. The call site picks one recovery action per kind. */
export type ErrorKind =
  | "validation"
  | "not_found"
  | "repo_not_ready"
  | "backend_unreachable"
  | "backend_error"
  | "contract_mismatch"
  | "model_unavailable"
  | "timeout";

export class ApiError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const HTTP_TO_KIND: Record<number, ErrorKind> = {
  400: "validation",
  404: "not_found",
  409: "repo_not_ready",
  422: "validation",
  504: "timeout",
};

export function kindFromStatus(status: number): ErrorKind {
  return HTTP_TO_KIND[status] ?? "backend_error";
}

/** Status the BFF hands the browser. `model_unavailable` never appears here — it is
 * derived from a failed job's error text, not from a transport failure. */
export function statusFromKind(kind: ErrorKind): number {
  switch (kind) {
    case "validation":
      return 400;
    case "not_found":
      return 404;
    case "repo_not_ready":
      return 409;
    case "timeout":
      return 504;
    case "backend_unreachable":
      return 503;
    default:
      return 502; // the backend failed, not the browser's request
  }
}
