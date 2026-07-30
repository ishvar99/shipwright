/** `job.failed.error` and stream failure messages are raw Python reprs. Their reachable content
 * includes SQLAlchemy connection URLs with credentials, provider API keys, and absolute home
 * directories, so none of it can be shown as-is. Structured leaks are fixed at the backend;
 * this is the residual net for unbounded text. */
export function redact(text: string): string {
  return (
    text
      // Provider tokens. An SDK auth error prints the key it tried to use.
      .replace(/\b(sk-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/g, "***")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
      // Credentials in a URL. Greedy user/password so a password containing `@` cannot leak its
      // tail through an early match.
      .replace(/\/\/[^/\s@]*:[^/\s]*@/g, "//***:***@")
      .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~")
      // Bound parameters can nest brackets, so anything short of end-of-string leaks the rest.
      .replace(/\[parameters:[\s\S]*/, "[parameters: redacted]")
  );
}
