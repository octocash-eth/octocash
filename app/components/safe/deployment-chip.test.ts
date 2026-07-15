import type { Address } from "viem";
import { describe, expect, test } from "vitest";
import type { SafeChainDeployment } from "~/lib/accounts";
import { groupDeployments } from "./deployment-chip";

const OWNER_A = "0x1111111111111111111111111111111111111111" as Address;
const OWNER_B = "0x2222222222222222222222222222222222222222" as Address;

function deployment(chainId: number, owners: Address[], threshold: number, controlled = true): SafeChainDeployment {
  return { chainId, owners, threshold, nonce: 0, version: "1.4.1", controlled };
}

describe("groupDeployments", () => {
  test("chains with the same owner set and threshold collapse into one group", () => {
    const groups = groupDeployments([
      deployment(8453, [OWNER_A], 1),
      deployment(1, [OWNER_A], 1),
      deployment(10, [OWNER_A], 1),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].map((d) => d.chainId)).toEqual([1, 10, 8453]);
  });

  test("a diverging owner set or threshold starts its own group, ordered by lowest chain id", () => {
    const groups = groupDeployments([
      deployment(100, [OWNER_B, OWNER_A], 1, false),
      deployment(1, [OWNER_A], 1),
      deployment(8453, [OWNER_A, OWNER_B], 2),
      deployment(10, [OWNER_A], 1),
    ]);

    expect(groups.map((group) => group.map((d) => d.chainId))).toEqual([[1, 10], [100], [8453]]);
  });

  test("owner casing and order do not split a group", () => {
    const groups = groupDeployments([
      deployment(1, [OWNER_A, OWNER_B], 2),
      deployment(10, [OWNER_B.toUpperCase() as Address, OWNER_A], 2),
    ]);

    expect(groups).toHaveLength(1);
  });
});
