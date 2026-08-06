# Shipwright design rules

Written down because this repository is edited by agents, and every rule here was previously
broken by one. If you are changing the interface, these are not suggestions.

## Colour means something

- **Green, amber, red are outcomes.** `--ok`, `--warn`, `--danger`. Never decorative.
- **The four evidence hues are retrieval channels.** `--evidence-text|graph|dense|path`. They are
  the only categorical colour in the product and must not be reused for anything else.
- **Primary actions are ink**, not colour: `--ink` / `--ink-fg`. Near-black on light, near-white
  on dark.
- `--accent` is low-chroma slate for focus, selection and links. It is not a brand colour and
  must not spread.

Why: every hue region was already carrying meaning, which is how the accent ended up as
Tailwind violet — the one hue left. Violet-to-indigo gradients are the most-cited AI tell of
2026. **Never put a gradient on type.** That is a tell independent of hue.

Verify contrast numerically, in both themes, before shipping a colour. AA is 4.5:1 for text and
3:1 for UI. Do not eyeball it.

## Hierarchy comes from size and tracking, not weight

Scale: `--text-display` and `--text-title` for marketing, `--text-head` (24px) and
`--text-subhead` (17px) in the product, then 14px body, 12px meta. Negative tracking increases
with size.

**One weighted element per row.** If a result row's name, path, score and line number are all
`font-medium text-xs`, weight has stopped meaning anything. Pick the one thing that matters and
let the rest recede to `font-normal text-subtle`.

**One ink-filled action per screen.** The sidebar's New session button used to out-shout the
composer's own CTA from the corner scanning starts in. If two filled actions compete, demote
one to an outline. The same applies to status dots: a wall of green success dots is texture,
not signal — show a dot only when it says something (running, failed).

## Radius has semantics

- `9999px` — badges and tags **only**. Never a button, never a control.
- `--radius` — controls: buttons, inputs, chips, rows.
- `--radius-card` — surfaces.

## One elevation model

`--shadow-1` and `--shadow-2` are a hairline ring plus a soft shadow, in **both** themes. A card
must be the same object in light and dark, not a border here and a float there.

## Structure follows the domain, not the schema

Sessions belong to repositories — that is a foreign key, and the interface must say so. A
repository is the place work happens, not a parameter of a composer. Routes nest the way the data
does: `/app/repo/:id`, `/app/repo/:id/s/:jobId`, `/app/repo/:id/files`.

**Build every workspace URL with `lib/repo-routes.ts`.** Never hand-write one in a component. The
helpers encode the ids and `parseWorkspacePath` reads them back, so the chrome and the page always
agree about which repository you are in. A hand-built path is how half the app ends up linking to
the old flat route and silently losing that context.

## The recording is identified by prefix, never by id

The demo bundle was captured from a real run, so its `job.id` and `repo_id` **are** live row ids
in the database it came from. Testing demo-ness with `id === demoJob.id` therefore flags a real
user's own repository as the recording. Demo ids carry a `demo-` prefix that no UUID can produce;
`isDemoJob` / `isDemoRepo` test that prefix. Ask per item, never once for the whole app — the
recording now appears alongside real rows.

## Having a backend is not having something to show

`live` means a backend is configured. `demoVisible` means there is nothing of the user's own yet.
Conflating them is what made a local install with a working backend and no imports show an empty
screen while a finished session sat unused in the bundle. Keep them separate.

## Setup never blocks writing

A repository that is still indexing does not disable the composer. The issue is accepted, parked,
and fired when the graph is ready. Anything that makes the user wait before they can type is
turning one wait into two.

## Motion

`--dur-fast` (120ms) for colour and hover, `--dur-base` (200ms) for layout and entrance. Entrance
only; exit animations need presence tracking and are not worth it. Everything is already covered
by the global `prefers-reduced-motion` rule — do not add a second mechanism.

## Copy states a consequence and a next move

Good: "That's longer than we can read — trim it under 20,000 characters." "No Python code found
here — Shipwright reads Python today."

Bad: describing what a control is. Never "seamlessly". Never explain the button; say what happens.

## Things that are load-bearing, not incidental

- **Navigation is real hrefs.** Middle-click, copy-link and browser history must work.
- **`ui-prefs.ts` stamps layout before paint.** Do not move that to an effect; it exists to stop
  a visible jump.
- **Dialogs restore focus to their opener.** There are two dialog surfaces; keep it that way.
- **`--surface-texture` is a blueprint dot-grid.** It is the one thing in the token file no
  template would produce. Do not switch it off to make things "cleaner".
- **Utility classes are defined once.** `.sw-truncate` was scoped to two ancestors, so it was
  inert on every other element that carried it and the sidebar switcher wrapped to two lines. If
  a class reads like a utility, write it as one.
- **Only use tokens that exist.** `--motion-fast`, `--ease` and `--hairline-strong` were all
  invented in a single edit and silently did nothing. The real names are `--dur-fast`,
  `--dur-base`, `--ease-swift`, `--ease-out-quart`, `--hairline`.

## Loading

Skeletons, not spinners, wherever layout is known. Never show empty-state copy while a fetch is
in flight — "nothing here" is not yet known. A wait over 10 seconds must be narrated with named
beats and real facts, not a progress bar with no information in it.

## Buttons are pointer, always

Tailwind v4's preflight leaves `<button>` on the arrow cursor, and the app had zero
`cursor: pointer` anywhere. One base rule fixes every button:
`button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer }`. Clickable pick
rows (`.sw-result`, `.sw-repo-option`, `.sw-quickopen-item`) are pointer too. Tree rows and
editor tabs stay on the arrow — that is the editor convention. Do not add per-component
cursor utilities; the base rule is the mechanism.

## The demo is a tour, not a row

The recorded run lives in no list and is never preselected. It is reachable two ways only:
the welcome view's guided replay (`?tour=1`) and deep links, which resolve by the `demo-` id
prefix. Injecting it into `repoList`/`sessions` is what made the launcher arrive pointed at
a repository the user never chose.

## The welcome view is the empty state

"No repositories" renders the welcome view — there is no `welcomed` flag, no dismissal to
persist, nothing to migrate. If a state needs a flag to know whether to show itself, first
check whether the state is simply derivable.

## One message, one place

The launcher audit found "recorded session" said five ways and "import a repository" four
ways on a single screen. Before adding explanatory copy, search for where the same sentence
already renders. The composer's placeholder is the composer's explanation.
