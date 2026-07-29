export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="font-display text-title">Shipwright</h1>
      <p className="mt-4 text-muted">
        Finds where to change code, and shows you why. Landing page lands in M8.
      </p>
      <a className="mt-8 inline-block text-accent underline" href="/kitchen-sink">
        Design system →
      </a>
    </main>
  );
}
