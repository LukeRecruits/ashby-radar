/**
 * PostgREST caps how many rows one request returns, so every full-table read has to be
 * walked a page at a time. This is that walk, once, for everything that needs it.
 */

export type PageResult<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

/**
 * Reads every row of a query, page by page. `fetchPage` receives an inclusive row range
 * to pass straight to `.range(from, to)`. The query must have a stable `order`, or rows
 * can appear twice or not at all across pages.
 *
 * The walk advances by however many rows came back and stops only on an empty page,
 * rather than treating a short page as the end. PostgREST has its own max-rows setting
 * that can be lower than the page size asked for, and a short-page stop would silently
 * truncate every read in the codebase the day someone changed it. The cost is one extra
 * empty request per full read.
 */
export async function fetchAllPages<T>(
  label: string,
  pageSize: number,
  fetchPage: (from: number, to: number) => PageResult<T>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(`${label} query failed: ${error.message}`);
    const batch = data ?? [];
    if (batch.length === 0) return rows;
    rows.push(...batch);
    from += batch.length;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
