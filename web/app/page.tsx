import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icon";
import { HeroVisual } from "@/components/landing/hero-visual";
import { Reveal } from "@/components/landing/reveal";
import { Replay } from "@/components/landing/replay";
import { AnalyticsSchema, parseOrThrow } from "@/lib/contracts";
import snapshot from "@/fixtures/analytics.json";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "crosshair",
    title: "Pinpoints the change",
    body: "Four search signals — names, call graph, code similarity and paths mentioned in your ticket — combine to rank the exact functions that need attention.",
  },
  {
    icon: "fileCode",
    title: "Writes the fix",
    body: "Watch the corrected code stream in live, then review it as a clean diff. Every change is validated before it is ever shown to you.",
  },
  {
    icon: "folder",
    title: "Applies safely",
    body: "One click commits the fix to its own branch in Shipwright's copy of your repository. Your checkout is never touched, and the patch is always yours to download.",
  },
  {
    icon: "check",
    title: "Proves it with your tests",
    body: "Shipwright sets up the test environment and runs your suite against the fix, streaming the results. Green means verified — not vibes.",
  },
  {
    icon: "plus",
    title: "Every session, kept",
    body: "Each run is saved with its full activity, diff, branch and test results. Reopen any session and the whole story replays instantly.",
  },
  {
    icon: "moon",
    title: "Private by design",
    body: "Analysis runs entirely on your machine. Your code is never uploaded, and there is nothing to subscribe to.",
  },
];

const DEMO_BEATS = [
  "Locates the code to change from a plain-language description.",
  "Writes the change and shows you the diff before anything moves.",
  "Applies it to a branch and runs your own test suite against it.",
];

const STEPS = [
  { n: "1", title: "Connect a repository", body: "Paste a GitHub URL or point at a local folder. Shipwright indexes it in seconds." },
  { n: "2", title: "Describe the issue", body: "In plain language — paste the ticket if you have one." },
  { n: "3", title: "Review, apply, verify", body: "Read the diff, apply it to a branch, and watch the tests pass." },
];

export default function Home() {
  const { runs } = parseOrThrow(AnalyticsSchema, snapshot, "fixtures/analytics.json");
  const best = runs.filter((r) => r.n >= 100).sort((a, b) => b.file5 - a.file5)[0];

  return (
    <main>
      {/* Hero: built from tokens only, so it wears whatever theme the site is in and the
          page reads as one surface top to bottom. */}
      <section className="sw-hero text-center">
        <HeroVisual />
        <div aria-hidden className="sw-hero-veil" />

        <nav className="sw-shell sw-hero-nav" aria-label="Primary">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-[10px] bg-accent text-bg shadow-sm">
              <Icon name="crosshair" size={20} />
            </span>
            <span className="text-lg font-semibold tracking-tight text-fg">Shipwright</span>
          </Link>
          <div className="flex items-center gap-6">
            <a href="#demo" className="hidden text-muted transition-colors hover:text-fg sm:inline">
              Product
            </a>
            <Link href="/evals" className="hidden text-muted transition-colors hover:text-fg sm:inline">
              Benchmarks
            </Link>
            <Link
              href="/app"
              className="inline-flex h-9 items-center rounded-[var(--radius)] bg-accent px-4 font-medium text-bg transition-colors hover:bg-[var(--accent-hover)]"
            >
              Open the workspace
            </Link>
          </div>
        </nav>

        <div className="sw-hero-copy sw-shell">
          <h1 className="mx-auto max-w-[17ch] text-balance text-display font-display text-fg">
            Describe the bug.{" "}
            <span className="sw-gradient-text whitespace-nowrap">Ship the fix.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-[52ch] text-lg text-muted">
            Shipwright reads your repository, pinpoints the code that needs to change, writes
            the fix, and proves it with your own tests — from a plain-language description.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/app"
              className="inline-flex h-12 items-center gap-2 rounded-[var(--radius)] bg-accent px-7 text-base font-medium text-bg shadow-sm transition-colors hover:bg-[var(--accent-hover)]"
            >
              Open the workspace
              <Icon name="send" size={16} />
            </Link>
            <a
              href="#demo"
              className="inline-flex h-12 items-center rounded-[var(--radius)] border border-hairline px-7 text-base font-medium text-fg transition-colors hover:border-accent"
            >
              Watch a session
            </a>
          </div>
        </div>

        {/* The proof strip anchors the fold: three claims, all of them checkable. */}
        <dl className="sw-shell sw-hero-stats">
          <div>
            <dt className="text-subtle">Right file, top five</dt>
            <dd className="font-mono text-2xl font-medium tabular-nums text-fg">
              {best.file5.toFixed(0)}%
            </dd>
            <dd className="text-subtle">
              on {best.n} real GitHub issues ·{" "}
              <Link href="/evals" className="underline underline-offset-4 hover:text-fg">
                benchmarks
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Every fix</dt>
            <dd className="text-2xl font-medium text-fg">Verified</dd>
            <dd className="text-subtle">applied to a branch, proven by your tests</dd>
          </div>
          <div>
            <dt className="text-subtle">Your code</dt>
            <dd className="text-2xl font-medium text-fg">Stays local</dd>
            <dd className="text-subtle">nothing uploaded, nothing to pay for</dd>
          </div>
        </dl>
      </section>

      {/* The demo: a real recorded session, playing itself, with the copy on a rail beside it
          so the card gets the width instead of the margins. */}
      <section className="sw-band">
        <Reveal
          id="demo"
          className="sw-shell grid gap-10 py-16 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start lg:gap-14"
        >
          <div className="lg:sticky lg:top-14">
            <h2 className="text-title text-fg">Watch a session</h2>
            <p className="mt-3 text-muted">
              A real run, replayed with the same components the product uses.
            </p>
            <ul className="mt-6 grid gap-3">
              {DEMO_BEATS.map((b) => (
                <li key={b} className="flex items-start gap-2.5 text-muted">
                  <Icon name="check" size={16} className="mt-1 shrink-0 text-ok" />
                  {b}
                </li>
              ))}
            </ul>
          </div>
          <Replay />
        </Reveal>
      </section>

      {/* What you get. */}
      <Reveal className="sw-shell py-16">
        <h2 className="text-title text-fg">Built for the whole fix, not just the search</h2>
        <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.title} className="sw-card sw-lift p-5">
              <span className="inline-grid size-9 place-items-center rounded-[var(--radius)] bg-accent-soft text-accent">
                <Icon name={f.icon} size={18} />
              </span>
              <p className="mt-3 font-semibold text-fg">{f.title}</p>
              <p className="mt-1.5 text-muted">{f.body}</p>
            </li>
          ))}
        </ul>
      </Reveal>

      {/* How it works. */}
      <section className="sw-band">
        <Reveal className="sw-shell py-16">
        <h2 className="text-title text-fg">Three steps to a verified fix</h2>
        <ol className="mt-8 grid gap-5 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-[var(--radius)] border border-hairline p-5">
              <span className="font-mono text-title text-accent">{s.n}</span>
              <p className="mt-2 font-semibold text-fg">{s.title}</p>
              <p className="mt-1.5 text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-10 text-center">
          <Link
            href="/app"
            className="inline-flex h-11 items-center gap-2 rounded-[var(--radius)] bg-accent px-6 font-medium text-bg shadow-sm transition-colors hover:bg-[var(--accent-hover)]"
          >
            Try it now
          </Link>
        </div>
        </Reveal>
      </section>

      <footer className="sw-shell border-t border-hairline py-10 text-subtle">
        <p>
          Every number Shipwright claims is measured and published on the{" "}
          <Link href="/evals" className="underline underline-offset-4 hover:text-fg">
            benchmarks page
          </Link>
          . Python repositories today.
        </p>
      </footer>
    </main>
  );
}
