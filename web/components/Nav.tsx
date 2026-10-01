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
];

export function Nav({ current }: { current: '/' | '/leads' }) {
  return (
    <nav className="mb-4 flex items-center gap-4 border-b border-[var(--line)] pb-2 text-[13px]">
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
                ? 'font-semibold text-[var(--ink)]'
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
