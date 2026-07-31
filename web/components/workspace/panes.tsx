/** M6's single swap point. The history and composer panes are real as of M5. */
export function CodeEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-fg">No location selected</p>
      <p className="max-w-[32ch] text-subtle">Selecting a result will show its source here.</p>
    </div>
  );
}
