/**
 * Minimal bounded-concurrency map. Runs `worker` over `items` with at most `limit` in
 * flight, preserving input order in the results. Rejects on the first worker throw — used
 * so an AuthError (bad API key) aborts the whole run immediately instead of retrying 73x.
 */

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner);
  await Promise.all(workers);
  return results;
}
