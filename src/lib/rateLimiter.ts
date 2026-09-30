import { sleep } from './sleep.ts';

/**
 * Hands out request slots no closer together than `minGapMs`, however many callers are
 * waiting. Node runs one thread, so reserving the next slot is atomic and no two callers
 * can be given the same one.
 *
 * This is what lets the refresh overlap its database writes with its Ashby calls while
 * still obeying the hard 1-request-per-second limit: the limiter, not the loop, is the
 * thing that paces Ashby.
 */
export function createRateLimiter(minGapMs: number) {
  let nextSlot = 0;
  return async function slot(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + minGapMs;
    if (at > now) await sleep(at - now);
  };
}
