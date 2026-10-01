/**
 * A company id that is not a uuid, or is one we hold no company for.
 *
 * Worth having rather than taking the framework default, because the gate in proxy.ts
 * answers 401 before anything here renders, so the only way to reach this page is a
 * mistyped or stale link from inside the console.
 */

export default function NotFound() {
  return (
    <main className="mx-auto max-w-[640px] px-4 py-16">
      <h1 className="text-lg font-semibold tracking-tight">No such company</h1>
      <p className="mt-2 text-[13px] text-[var(--ink-soft)]">
        That id does not match anything on the board. A company is never deleted here, so
        a link that used to work still should; if this one came from inside the console it
        is worth saying so.
      </p>
      <p className="mt-4 text-[13px]">
        <a href="/" className="text-[var(--accent)] hover:underline">
          ← Back to the lead list
        </a>
      </p>
    </main>
  );
}
