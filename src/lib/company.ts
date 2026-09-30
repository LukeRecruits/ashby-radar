import { config } from '../config.ts';

export type CompanyRef = {
  id: string;
  board_name: string;
  display_name: string | null;
  domain: string | null;
};

/** The public job board a human can open to check a trigger. */
export function boardPageUrl(boardName: string): string {
  return `https://jobs.ashbyhq.com/${encodeURIComponent(boardName)}`;
}

/**
 * Ashby's board response carries no company name, so display_name is null until
 * phase 4's careers-page scan fills it from the company's own site. Until then the
 * board name is the only name we have.
 */
export function companyLabel(company: Pick<CompanyRef, 'board_name' | 'display_name'>): string {
  return company.display_name?.trim() || company.board_name;
}

export const SWEET_SPOT = config.triggers.sweetSpot;

/** True when the company is in the size band CandidHQ sells into. */
export function inSweetSpot(openRoles: number | null | undefined): boolean {
  if (typeof openRoles !== 'number') return false;
  return openRoles >= SWEET_SPOT.minRoles && openRoles <= SWEET_SPOT.maxRoles;
}
