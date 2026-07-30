/**
 * Honest empty states for the panes M5 and M6 will fill. Each is one import for the later
 * module to replace, so the shell itself does not get edited again.
 */

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-fg">{title}</p>
      <p className="max-w-[32ch] text-subtle">{body}</p>
    </div>
  );
}

export function HistoryEmpty() {
  return <Empty title="No repositories yet" body="Importing a repository is the next module." />;
}

export function ComposerEmpty() {
  return (
    <Empty
      title="Nothing to localize yet"
      body="The issue composer and ranked results arrive with the next module. The strip above is already live."
    />
  );
}

export function CodeEmpty() {
  return <Empty title="No location selected" body="Selecting a result will show its source here." />;
}
