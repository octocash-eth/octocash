import { describe, expect, test } from "vitest";
import type { LiFiStatusResponse } from "./lifi";
import { attestationStageMessage, lifiStageMessage } from "./step-progress";

const transfer = (fromChainId: number, toChainId: number, substatus?: string) => ({
  fromChainId,
  toChainId,
  status: { status: "PENDING", substatus } as LiFiStatusResponse,
});

describe("lifiStageMessage", () => {
  test("no transfers yet → generic bridging", () => {
    expect(lifiStageMessage([])).toBe("Bridging…");
  });

  test("source confirmations names the source chain", () => {
    expect(lifiStageMessage([transfer(1, 8453, "WAIT_SOURCE_CONFIRMATIONS")])).toMatch(/^Confirming on .+…$/);
  });

  test("destination wait names the destination chain", () => {
    expect(lifiStageMessage([transfer(1, 8453, "WAIT_DESTINATION_TRANSACTION")])).toMatch(/^Bridging to .+…$/);
  });

  test("least-advanced transfer wins across destinations", () => {
    // One leg already bridging to dest, another still confirming at source —
    // the laggard (source confirmations) must drive the message.
    const msg = lifiStageMessage([
      transfer(1, 8453, "WAIT_DESTINATION_TRANSACTION"),
      transfer(1, 10, "WAIT_SOURCE_CONFIRMATIONS"),
    ]);
    expect(msg).toMatch(/^Confirming on /);
  });

  test("refund + bridge-unavailable copy", () => {
    expect(lifiStageMessage([transfer(1, 8453, "REFUND_IN_PROGRESS")])).toBe("Refund in progress…");
    expect(lifiStageMessage([transfer(1, 8453, "BRIDGE_NOT_AVAILABLE")])).toBe("Waiting for bridge…");
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
