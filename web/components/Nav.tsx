/**
 * Two screens now, so there has to be a way between them.
 *
 * The queue is the front door because it is the only page that says what to do next; the
 * lead list is where the queue gets fed from. Both are server-rendered links with an
 * `aria-current`, which is the whole of the interaction design.
 */

const LINKS = [
  { href: '/', label: 'Work queue', hint: 'Who is waiting on you today' },
  { href: '/leads', label: 'Lead list', hint: 'Every company, filtered' },
  { href: '/health', label: 'Health', hint: 'Whether the scheduled half is still working' },
];

/**
 * CandidHQ's mark and wordmark, with the product name beside it. The mark is the same
 * gradient tile as candidhq.tech's favicon, served from public/mark.png.
 */
export function Brand() {
  return (
    <a href="/" className="flex items-center gap-2" title="Customer Radar, the work queue">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/mark.png" alt="" width={22} height={22} className="rounded-[6px]" />
      <span className="wordmark text-[17px] font-semibold tracking-tight text-[var(--ink)]">
        CandidHQ
      </span>
      <span className="text-[13px] text-[var(--ink-faint)]">Customer Radar</span>
    </a>
  );
}

export function Nav({ current }: { current: '/' | '/leads' | '/health' }) {
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--line)] pb-2 text-[13px]">
      <Brand />
      <span className="mx-1 h-4 w-px bg-[var(--line-strong)]" aria-hidden />
      {LINKS.map((link) => {
        const active = link.href === current;
        return (
          <a
            key={link.href}
            href={link.href}
            title={link.hint}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'font-semibold text-[var(--accent)]'
                : 'text-[var(--ink-soft)] hover:text-[var(--accent)]'
            }
          >
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}
