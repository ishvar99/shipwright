/** Pure SSE framing. The caller holds the buffer, so this function is stateless and can be
 * exercised at every byte offset — which is the only practical defence against a decoder bug
 * that only shows up when a frame happens to split across a chunk boundary. */

export type Frame = {
  /** The frame text exactly as it arrived, minus the terminating blank line. */
  raw: string;
  /** `id:` value, when present. */
  id?: string;
  /** `event:` value, when present. */
  event?: string;
  /** Concatenated `data:` lines. */
  data: string;
  /** A frame whose only content is a comment (`:`) — the backend's liveness ping. */
  comment: boolean;
};

export function feed(buffer: string, chunk: string): { frames: Frame[]; remainder: string } {
  const text = (buffer + chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = text.split("\n\n");
  const remainder = parts.pop() ?? "";
  return { frames: parts.filter((p) => p.length > 0).map(parseFrameText), remainder };
}

function parseFrameText(raw: string): Frame {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  let sawField = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Spec: exactly one optional space after the colon.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") { id = value; sawField = true; }
    else if (field === "event") { event = value; sawField = true; }
    else if (field === "data") { data.push(value); sawField = true; }
  }

  return { raw, id, event, data: data.join("\n"), comment: !sawField };
}

/** TextDecoder with `stream: true` threaded through, because a chunk boundary can fall inside a
 * multi-byte character and `job.failed` carries arbitrary text. */
export function createDecoder(): (bytes: Uint8Array | undefined) => string {
  const decoder = new TextDecoder();
  return (bytes) => (bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode());
}
