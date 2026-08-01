/**
 * First-run checklist. Not a tour: the only controlled study of tutorial overlays found readers
 * rated the product significantly harder to use, while a checklist with its first item already
 * ticked is the one form of guided help the evidence supports.
 *
 * The first item is complete on arrival because it is true on arrival — the recorded session is
 * on screen, which is the whole point of showing it before anything is imported.
 */

export type ChecklistItem = {
  id: "example" | "import" | "ship";
  label: string;
  done: boolean;
  href: string;
};

export type ChecklistState = {
  /** The recorded session is on screen. */
  exampleVisible: boolean;
  /** Repositories the user imported — the recording does not count. */
  ownRepos: number;
  /** Sessions the user ran — the recording does not count. */
  ownSessions: number;
  exampleHref: string;
};

export function checklist(s: ChecklistState): ChecklistItem[] {
  return [
    {
      id: "example",
      label: "See a finished session on a real repository",
      done: s.exampleVisible || s.ownRepos > 0,
      href: s.exampleHref,
    },
    {
      id: "import",
      label: "Import your own repository",
      done: s.ownRepos > 0,
      href: "/app/repos",
    },
    {
      id: "ship",
      label: "Describe a bug and ship the fix",
      done: s.ownSessions > 0,
      href: "/app",
    },
  ];
}

/** Nothing left to guide. Hiding it beats leaving a row of ticks on the page forever. */
export const checklistComplete = (items: ChecklistItem[]) => items.every((i) => i.done);

/** The first unfinished step, which is the only one worth pointing at. */
export const nextStep = (items: ChecklistItem[]) => items.find((i) => !i.done) ?? null;
