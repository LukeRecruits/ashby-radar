/**
 * Which client reads which source, and the workflow name each source's runs record
 * under. The refresh asks for a source and gets back everything source-specific it
 * needs; nothing below the client knows which ATS it is talking to.
 */

import { fetchBoard as fetchAshbyBoard } from '../ashby/postingApi.ts';
import { config } from '../config.ts';
import type { BoardResult, Source } from './types.ts';

export type AtsClient = {
  fetchBoard: (boardName: string) => Promise<BoardResult>;
  /** Gap between two requests to this ATS. Each source gets its own limiter. */
  requestDelayMs: number;
};

export function clientFor(source: Source): AtsClient {
  switch (source) {
    case 'ashby':
      return { fetchBoard: fetchAshbyBoard, requestDelayMs: config.ashby.requestDelayMs };
    case 'greenhouse':
      throw new Error('the Greenhouse client is not wired in yet');
  }
}

/**
 * The runs.workflow value for a source. Ashby keeps the bare names it has always had,
 * because the health page and its history key on them.
 */
export function workflowName(base: string, source: Source): string {
  return source === 'ashby' ? base : `${base}-${source}`;
}

/** RADAR_SOURCE, defaulting to Ashby so every existing workflow behaves as before. */
export function sourceFromEnv(): Source {
  const raw = process.env.RADAR_SOURCE?.trim() || 'ashby';
  if (raw !== 'ashby' && raw !== 'greenhouse') {
    throw new Error(`RADAR_SOURCE must be ashby or greenhouse, not "${raw}"`);
  }
  return raw;
}
