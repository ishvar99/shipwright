"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Location } from "@/lib/contracts";

/**
 * The whole M5 -> M6 contract. Selection is keyed by `symbol`, never by list index: the order
 * toggle reorders the same ten rows, and an index would silently repoint the code pane at a
 * different location every time the order flips.
 */
type Selection = {
  symbol: string | null;
  location: Location | null;
  select: (location: Location) => void;
  clear: () => void;
  /** Bumped when the user asks for the code pane (Enter). M6 focuses on a change. */
  focusNonce: number;
  requestFocus: () => void;
};

const Ctx = createContext<Selection | null>(null);

export function SelectionProvider({
  locations,
  children,
}: {
  locations: readonly Location[];
  children: React.ReactNode;
}) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);

  const select = useCallback((location: Location) => setSymbol(location.symbol), []);
  const clear = useCallback(() => setSymbol(null), []);
  const requestFocus = useCallback(() => setFocusNonce((n) => n + 1), []);

  const value = useMemo<Selection>(() => {
    // Resolved from the current rows, so a new job clears a selection that no longer exists
    // rather than leaving the code pane on a stale location.
    const location = locations.find((l) => l.symbol === symbol) ?? null;
    return { symbol: location ? symbol : null, location, select, clear, focusNonce, requestFocus };
  }, [locations, symbol, select, clear, focusNonce, requestFocus]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelection(): Selection {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSelection must be used inside SelectionProvider");
  return value;
}
