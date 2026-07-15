import { describe, expect, test } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  test("maps every item and preserves order", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("a rejection propagates", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  test("empty input resolves immediately", async () => {
    expect(await mapWithConcurrency([], 4, async () => "never")).toEqual([]);
  });
});
