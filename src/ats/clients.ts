/**
 * Which client reads which source, and the workflow name each source's runs record
 * under. The refresh asks for a source and gets back everything source-specific it
 * needs; nothing below the client knows which ATS it is talking to.
 */

import { fetchBoard as fetchAshbyBoard } from '../ashby/postingApi.ts';
import { config } from '../config.ts';
import {
  fetchBoard as fetchGreenhouseBoard,
  fetchBoardName as fetchGreenhouseBoardName,
} from '../greenhouse/boardApi.ts';
import type { BoardResult, Source } from './types.ts';

export type AtsClient = {
  /**
   * Reads one board. `pace` is the source's shared rate limiter and the client calls it
   * before every request it makes, because a board is one request on Ashby and two or
   * three on Greenhouse, and every one of them counts against the budget.
   */
  fetchBoard: (boardName: string, pace: () => Promise<void>) => Promise<BoardResult>;
  /** Gap between two requests to this ATS. Each source gets its own limiter. */
  requestDelayMs: number;
};

export function clientFor(source: Source): AtsClient {
  switch (source) {
    case 'ashby':
      return {
        fetchBoard: async (boardName, pace) => {
          await pace();
          return fetchAshbyBoard(boardName);
        },
        requestDelayMs: config.ashby.requestDelayMs,
      };
    case 'greenhouse':
      return { fetchBoard: fetchGreenhouse, requestDelayMs: config.greenhouse.requestDelayMs };
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

/**
 * Greenhouse puts the company name on every job, so a board with no jobs has none. For
 * those, one extra call to the board's own endpoint supplies the name and any domain its
 * intro text links to. About 2% of live boards are empty, so this is a handful of
 * requests a night, not a second pass.
 */
async function fetchGreenhouse(token: string, pace: () => Promise<void>): Promise<BoardResult> {
  const board = await fetchGreenhouseBoard(token, { pace });
  if (!board.found || board.companyName) return board;
  const info = await fetchGreenhouseBoardName(token, { pace });
  if (!info) return board;
  return {
    ...board,
    companyName: info.name,
    domainCandidates: board.domainCandidates.length ? board.domainCandidates : info.domainCandidates,
  };
}
