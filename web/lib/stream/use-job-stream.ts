"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createController } from "@/lib/stream/controller";
import type { ActivityState } from "@/lib/stream/reduce";
import type { JobStream } from "@/lib/stream/transport";

/**
 * `makeStream` must be stable (useCallback) — together with jobId it identifies the
 * subscription, and an unstable factory would reopen the stream on every render.
 */
export function useJobStream(jobId: string, makeStream: () => JobStream): ActivityState {
  const controller = useMemo(() => createController(jobId, makeStream()), [jobId, makeStream]);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
