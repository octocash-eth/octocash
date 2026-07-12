import { describe, expect, test } from "vitest";
import { attestationStageMessage, refuelStageMessage } from "./step-progress";

const refuel = (fromChainId: number, toChainId: number, delivered: boolean) => ({
  fromChainId,
  toChainId,
  delivered,
});

describe("refuelStageMessage", () => {
  test("no refuels yet → generic delivering", () => {
    expect(refuelStageMessage([])).toBe("Delivering gas…");
  });

  test("pending refuel names the destination chain", () => {
    expect(refuelStageMessage([refuel(1, 8453, false)])).toMatch(/^Delivering gas to .+…$/);
  });

  test("laggard destinations drive the message across refuels", () => {
    // One leg landed, another still in flight — only the pending one is named.
    const msg = refuelStageMessage([refuel(1, 8453, true), refuel(1, 10, false)]);
    expect(msg).toBe("Delivering gas to OP Mainnet…");
  });

  test("multiple pending destinations are joined", () => {
    const msg = refuelStageMessage([refuel(1, 8453, false), refuel(1, 10, false)]);
    expect(msg).toBe("Delivering gas to Base + OP Mainnet…");
  });

  test("all delivered → confirmation copy", () => {
    expect(refuelStageMessage([refuel(1, 8453, true), refuel(1, 10, true)])).toBe("Gas delivered ✓");
  });
});

describe("attestationStageMessage", () => {
  test("single source → no count", () => {
    expect(attestationStageMessage(0, 1)).toBe("Waiting for Circle attestation…");
    expect(attestationStageMessage(1, 1)).toBe("Waiting for Circle attestation…");
  });

  test("multi source → X/N count", () => {
    expect(attestationStageMessage(0, 3)).toBe("Attestations received 0/3");
    expect(attestationStageMessage(2, 3)).toBe("Attestations received 2/3");
  });
});
