'use client';

/**
 * A dropdown of checkboxes that still submits with the plain GET form around it.
 *
 * Every option is a real `<input type="checkbox" name=...>`, so ticking two countries
 * sends `country=A&country=B` and the URL stays the single source of truth. The only
 * things this component adds in the browser are the open/close behaviour, a live label,
 * and a type-to-narrow box for the long lists (465 cities is not something to scroll).
 *
 * Options already ticked are pinned to the top when the page loads, so a selection made
 * at the bottom of the city list is visible without hunting for it.
 */

import { useEffect, useRef, useState } from 'react';

export type Option = { value: string; label: string; count?: number };

export function MultiSelect({
  name,
  options,
  selected,
  anyLabel,
  noun,
}: {
  name: string;
  options: Option[];
  selected: string[];
  anyLabel: string;
  noun: string;
}) {
  const [picked, setPicked] = useState<string[]>(selected);
  const [needle, setNeedle] = useState('');
  const root = useRef<HTMLDetailsElement>(null);

  // Close when clicking anywhere else, the way a native select does.
  useEffect(() => {
    function onPointer(event: PointerEvent) {
      const el = root.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, []);

  const pinned = new Set(selected);
  const ordered = [
    ...options.filter((o) => pinned.has(o.value)),
    ...options.filter((o) => !pinned.has(o.value)),
  ];
  const lowered = needle.trim().toLowerCase();

  const summary =
    picked.length === 0
      ? anyLabel
      : picked.length === 1
        ? (options.find((o) => o.value === picked[0])?.label ?? picked[0])
        : `${picked.length} ${noun}`;

  function toggle(value: string, on: boolean) {
    setPicked((now) => (on ? [...now, value] : now.filter((v) => v !== value)));
  }

  return (
    <details ref={root} className="relative">
      <summary
        className={
          'flex h-9 w-[13rem] cursor-pointer list-none items-center justify-between gap-2 ' +
          'rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 text-[13px] ' +
          'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 [&::-webkit-details-marker]:hidden'
        }
      >
        <span className={`truncate ${picked.length ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}>
          {summary}
        </span>
        <span aria-hidden className="text-[10px] text-[var(--ink-faint)]">▼</span>
      </summary>

      <div className="absolute left-0 z-20 mt-1 w-[16rem] rounded-md border border-[var(--line-strong)] bg-[var(--panel)] shadow-lg">
        {options.length > 12 ? (
          <div className="border-b border-[var(--line)] p-1.5">
            <input
              type="search"
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
              // Enter would submit the whole form mid-search.
              onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
              placeholder="Type to narrow"
              aria-label={`Narrow the ${noun}`}
              className="h-8 w-full rounded border border-[var(--line)] bg-[var(--bg)] px-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
        ) : null}

        <ul className="max-h-72 overflow-y-auto py-1">
          {ordered.map((o) => {
            // Hidden rather than removed: a ticked box filtered out of view must still
            // submit, or narrowing the list would silently drop part of the selection.
            const hidden = lowered !== '' && !o.label.toLowerCase().includes(lowered);
            return (
              <li key={o.value} hidden={hidden}>
                <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-[13px] hover:bg-[var(--bg)]">
                  <input
                    type="checkbox"
                    name={name}
                    value={o.value}
                    defaultChecked={pinned.has(o.value)}
                    onChange={(e) => toggle(o.value, e.target.checked)}
                    className="size-3.5 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.count !== undefined ? (
                    <span className="nums text-[11px] text-[var(--ink-faint)]">
                      {o.count.toLocaleString('en-GB')}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
