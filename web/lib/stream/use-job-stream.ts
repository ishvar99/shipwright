"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createController, type Controller } from "@/lib/stream/controller";
import type { ActivityState } from "@/lib/stream/reduce";
import type { JobStream } from "@/lib/stream/transport";

/**
 * `makeStream` must be stable (useCallback) — together with jobId it identifies the
 * subscription, so an inline factory would rebuild the controller on every render. Changing its
 * identity on purpose is the restart mechanism: a new controller replays from scratch.
 */
export function useJobStream(
  jobId: string,
  makeStream: () => JobStream,
): { state: ActivityState; retry: Controller["retry"] } {
  const controller = useMemo(() => createController(jobId, makeStream), [jobId, makeStream]);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  return { state, retry: controller.retry };
}
