/** Every failure the UI can render. The call site picks one recovery action per kind. */
export type ErrorKind =
  | "validation"
  | "not_found"
  | "repo_not_ready"
  | "backend_unreachable"
  | "backend_error"
  | "contract_mismatch"
  | "model_unavailable"
  | "signed_out"
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

/** Exception names httpx raises when Ollama is unreachable or the model is not pulled. Keyed on
 * the NAME, because run_localize formats as f"{type(e).__name__}: {e}" and the message text
 * differs by platform and resolver. */
const MODEL_TRANSPORT_ERRORS = new Set([
  "ConnectError",
  "ConnectTimeout",
  "ReadTimeout",
  "ReadError",
  "RemoteProtocolError",
  "PoolTimeout",
  "HTTPStatusError",
]);

/**
 * Turns a job's error text into a kind, so "Ollama is not running" gets its own recovery action
 * instead of reading identically to a graph-build failure. Without this, `model_unavailable` is
 * declared in the union and derived by nothing.
 */
export function classifyJobError(text: string): ErrorKind {
  const name = text.slice(0, text.indexOf(":") === -1 ? undefined : text.indexOf(":")).trim();
  return MODEL_TRANSPORT_ERRORS.has(name) ? "model_unavailable" : "backend_error";
}

/** Python reprs can be multiline; only the first line is useful in a panel. */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim();
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
    case "signed_out":
      return 401;
    case "backend_unreachable":
      return 503;
    default:
      return 502; // the backend failed, not the browser's request
  }
}
