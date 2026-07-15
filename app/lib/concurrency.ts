/**
 * Maps `items` through `fn` with at most `limit` calls in flight — a tiny
 * worker pool. Used to pace fan-outs against rate-limited public APIs (the
 * Safe Transaction Service 429s unauthenticated bursts). Results keep item
 * order; a rejection from `fn` rejects the whole map, so callers that want
 * partial results must catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
