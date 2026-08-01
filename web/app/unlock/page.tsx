import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Locked · Shipwright" };

/** A plain form post, so unlocking works with JavaScript disabled and needs no client bundle. */
export default async function Unlock({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; bad?: string }>;
}) {
  const { next, bad } = await searchParams;
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : "/app";

  return (
    <main className="sw-unlock">
      <form method="post" action="/api/unlock" className="sw-card sw-unlock-card">
        <h1 className="text-head font-semibold text-fg">This workspace is private</h1>
        <p className="text-muted">
          Shipwright is running against a real repository on someone&rsquo;s machine. Enter the
          password to continue, or read the{" "}
          <Link href="/" className="underline">
            overview
          </Link>{" "}
          instead.
        </p>
        <input type="hidden" name="next" value={target} />
        <label htmlFor="password" className="text-sm font-medium text-fg">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          required
          className="sw-textarea"
        />
        {bad && (
          <p role="alert" className="text-danger">
            That password didn&rsquo;t match. Try again.
          </p>
        )}
        <button type="submit" className="sw-primary-link justify-self-start">
          Unlock
        </button>
      </form>
    </main>
  );
}
