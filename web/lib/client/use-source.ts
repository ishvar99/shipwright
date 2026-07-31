"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/client/api";
import { SourceSchema, type Location, type Source } from "@/lib/contracts";
import { ApiError } from "@/lib/errors";

/** The code pane's states, named. `rejected` is distinct from `failed`: one means the request
 * had no business being made, the other means the backend broke. */
export type SourceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; source: Source }
  | { kind: "empty" }
  | { kind: "missing" }
  | { kind: "too_large" }
  | { kind: "rejected"; message: string }
  | { kind: "not_recorded" }
  | { kind: "failed"; message: string };

/** Fixture sources are keyed by the location they were captured for. */
export function sourceKey(location: Pick<Location, "path" | "start_line">): string {
  return `${location.path}:${location.start_line}`;
}

function classify(error: unknown): SourceState {
  if (!(error instanceof ApiError)) {
    return { kind: "failed", message: error instanceof Error ? error.message : "Unknown failure" };
  }
  const detail = `${error.message} ${error.detail ?? ""}`.toLowerCase();
  if (detail.includes("too large")) return { kind: "too_large" };
  if (detail.includes("not a file") || detail.includes("missing")) return { kind: "missing" };
  if (error.kind === "validation") return { kind: "rejected", message: error.message };
  return { kind: "failed", message: error.message };
}

export function useSource(
  jobId: string,
  location: Location | null,
  recorded: Record<string, unknown> | null,
): SourceState {
  const [remote, setRemote] = useState<SourceState>({ kind: "idle" });

  // Replay needs no effect: the bundle is already in memory, so this is a render-time
  // derivation. It also carries only the top few locations, so a row without a capture says so
  // rather than firing a request that cannot succeed.
  const fromRecording = useMemo<SourceState | null>(() => {
    if (!location || !recorded) return null;
    const hit = recorded[sourceKey(location)];
    if (!hit) return { kind: "not_recorded" };
    const parsed = SourceSchema.safeParse(hit);
    if (!parsed.success) {
      return { kind: "failed", message: "The recorded snippet does not match the schema" };
    }
    return parsed.data.lines.length ? { kind: "loaded", source: parsed.data } : { kind: "empty" };
  }, [location, recorded]);

  useEffect(() => {
    if (!location || recorded) return;
    let cancelled = false;
    const query = new URLSearchParams({
      path: location.path,
      start: String(location.start_line),
      end: String(location.end_line || location.start_line),
    });
    void (async () => {
      setRemote({ kind: "loading" });
      try {
        const source = await apiGet(
          SourceSchema,
          `/api/jobs/${encodeURIComponent(jobId)}/source?${query}`,
        );
        // A successful response with no lines is not "loaded".
        if (!cancelled) {
          setRemote(source.lines.length ? { kind: "loaded", source } : { kind: "empty" });
        }
      } catch (e) {
        if (!cancelled) setRemote(classify(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, location, recorded]);

  if (!location) return { kind: "idle" };
  return fromRecording ?? remote;
}
