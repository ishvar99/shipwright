/** `job.failed.error` is a raw Python repr. Its reachable content includes SQLAlchemy
 * connection URLs with credentials and absolute home directories, so it cannot be shown as-is.
 * Structured leaks are fixed at the backend; this is the residual net for unbounded text. */
export function redact(text: string): string {
  return text
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//***:***@")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~")
    .replace(/\[parameters: [^\]]*\]/g, "[parameters: redacted]");
}
