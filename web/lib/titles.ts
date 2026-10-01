/**
 * Reading a job title, and deciding whether it belongs to the person worth messaging.
 *
 * Exa returns everyone it thinks matches a people search, which for "talent at Vertice"
 * included people at STRATOS, CUBE and BigID, and for most companies includes the
 * coordinator, the sourcer and somebody who left eighteen months ago. Two filters sort
 * that out: the employer has to be the company we are looking at (employer.ts), and the
 * title has to be a talent one (here).
 *
 * This duplicates a little of `src/config.ts`'s `recruiterTitlePatterns`, deliberately,
 * because the two answer different questions. That one asks "is this open role a
 * recruiting hire", over job adverts. This asks "is this person the one who owns hiring,
 * and how senior are they", over a person's own title. Sharing a list would mean one of
 * them drifting to suit the other, and the two packages share no code anyway.
 */

/** Anything matching none of these is not in talent and is dropped. */
const TALENT = [
  'talent',
  'recruit',
  'recruiting',
  'recruitment',
  'hiring',
  'people',
  'human resources',
  '\\bhr\\b',
  '\\bta\\b',
];

/**
 * Seniority, highest first. The first pattern that matches sets the band, so order
 * matters: "VP of Talent" has to be read as VP rather than as the "talent" that also
 * matches an IC title.
 */
const BANDS: { band: number; label: string; patterns: string[] }[] = [
  { band: 5, label: 'Exec', patterns: ['chief', '\\bcpo\\b', '\\bchro\\b', 'founder', 'co-founder'] },
  { band: 4, label: 'VP', patterns: ['\\bvp\\b', 'vice president', '\\bsvp\\b'] },
  { band: 3, label: 'Head', patterns: ['head of', 'director', '\\bdir\\b'] },
  { band: 2, label: 'Lead', patterns: ['lead', 'manager', 'principal'] },
  { band: 1, label: 'Senior', patterns: ['senior', '\\bsnr\\b', '\\bsr\\b'] },
];

/**
 * Titles that are in talent but are not the buyer. A coordinator or a sourcer feels the
 * problem CandidHQ solves and cannot do anything about it, so they rank below everybody
 * else rather than being dropped: on a small team the coordinator is sometimes the only
 * person there.
 */
const NOT_THE_BUYER = ['coordinator', 'sourcer', 'sourcing', 'intern', 'assistant', 'admin', 'apprentice'];

/** Being the owner of the function outright, rather than of a slice of it. */
const OWNS_IT = ['head of talent', 'head of people', 'head of recruit', 'talent acquisition', 'talent lead'];

function has(haystack: string, patterns: string[]): boolean {
  return patterns.some((p) => new RegExp(p, 'i').test(haystack));
}

export type TitleRead = {
  /** Whether this is a talent, people or recruiting title at all. */
  isTalent: boolean;
  /** 0 to 5. Higher is more senior. */
  band: number;
  bandLabel: string;
  /** What the panel prints under the name, in three or four words. */
  note: string;
  /** Sort key. Higher first. */
  score: number;
};

export function readTitle(title: string | null | undefined): TitleRead {
  const t = (title ?? '').trim();
  if (!t) {
    return { isTalent: false, band: 0, bandLabel: '', note: 'No title', score: -100 };
  }

  const isTalent = has(t, TALENT);
  const found = BANDS.find((b) => has(t, b.patterns));
  const band = found?.band ?? 0;
  const junior = has(t, NOT_THE_BUYER);
  const owner = has(t, OWNS_IT);

  // The score is only ever used to order one company's candidates against each other, so
  // the scale does not have to mean anything outside this list. Seniority dominates,
  // owning the function is worth about half a band, and not being the buyer costs more
  // than any of it.
  const score =
    (isTalent ? 10 : -50) + band * 4 + (owner ? 2 : 0) + (junior ? -8 : 0);

  const note = !isTalent
    ? 'Not a talent title'
    : junior
      ? 'In talent, but unlikely to be the buyer'
      : owner && band >= 3
        ? 'Owns the function'
        : band >= 3
          ? 'Senior, leads a team'
          : band > 0
            ? `${found?.label} level`
            : 'Individual contributor';

  return { isTalent, band, bandLabel: found?.label ?? '', note, score };
}
