import type { Address, Call, Hex, PublicClient } from "viem";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from "viem";
import { gnosis, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FOREIGN_AMB,
  FOREIGN_OMNIBRIDGE,
  HOME_AMB,
  HOME_OMNIBRIDGE,
  USDC_ON_XDAI,
  USDC_TRANSMUTER,
} from "~/data/omnibridge-contracts";
import { USDC } from "~/data/token-contracts";
import { makeToken, WALLET } from "../../test/test-helpers";

// Mock exactly the specifiers omnibridge.ts imports. `./cctp` stays real so
// abortableSleep / isAbortError run against fake timers.
vi.mock("~/lib/public-client", () => ({
  getPublicClient: vi.fn(),
}));

vi.mock("./tokens", () => ({
  buildERC20ApprovalCalls: vi.fn(),
  getTokenBalance: vi.fn(),
}));

import { getPublicClient } from "~/lib/public-client";
import {
  executeOmnibridgeBurn,
  executeOmnibridgeClaim,
  executeOmnibridgeDeposit,
  getExecuteSignaturesCalls,
  getGnosisEgressCalls,
  getMainnetIngressCalls,
  type OmnibridgeClaim,
  type OmnibridgeDelivery,
  OmnibridgeTimeoutError,
  packSignatures,
  retrieveOmnibridgeClaims,
  waitForOmnibridgeDelivery,
} from "./omnibridge";
import { buildERC20ApprovalCalls, getTokenBalance } from "./tokens";

const RECEIVER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const AMOUNT = 1_000_000n; // 1 USDC

const APPROVE_CALL: Call = { to: USDC[gnosis.id], data: "0xapprove" as Hex };

/** Builds a fake 65-byte r‖s‖v signature from repeated fill bytes. */
const fakeSig = (rByte: string, sByte: string, vByte: string): Hex =>
  `0x${rByte.repeat(32)}${sByte.repeat(32)}${vByte}` as Hex;

const SIG_1 = fakeSig("11", "22", "1b");
const SIG_2 = fakeSig("33", "44", "1c");

const MESSAGE_ID = `0x${"ab".repeat(32)}` as Hex;
const ENCODED_DATA = `0x${"1234".repeat(40)}` as Hex; // arbitrary 80-byte AMB message

const PROCESSED_FLAG = 1n << 255n;

const homeAmbEventAbi = parseAbi(["event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)"]);
const initiatedEventAbi = parseAbi([
  "event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)",
]);

/** A `UserRequestForSignature` log as emitted by the given AMB address. */
const userRequestLog = (address: Address, messageId: Hex, encodedData: Hex) => ({
  address,
  topics: encodeEventTopics({ abi: homeAmbEventAbi, eventName: "UserRequestForSignature", args: { messageId } }),
  data: encodeAbiParameters([{ type: "bytes" }], [encodedData]),
});

/** A `TokensBridgingInitiated` log as emitted by the given mediator address. */
const initiatedLog = (address: Address, messageId: Hex, value: bigint) => ({
  address,
  topics: encodeEventTopics({
    abi: initiatedEventAbi,
    eventName: "TokensBridgingInitiated",
    args: { token: USDC_ON_XDAI, sender: WALLET, messageId },
  }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});

const mockClient = (client: Record<string, unknown>) => {
  vi.mocked(getPublicClient).mockReturnValue(client as unknown as PublicClient);
  return client;
};

describe("omnibridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildERC20ApprovalCalls).mockResolvedValue([APPROVE_CALL]);
    vi.mocked(getTokenBalance).mockResolvedValue(0n);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("packSignatures", () => {
    test("packs two signatures as count byte + v[] + r[] + s[]", () => {
      const packed = packSignatures([SIG_1, SIG_2]);
      expect(packed).toBe(`0x02${"1b"}${"1c"}${"11".repeat(32)}${"33".repeat(32)}${"22".repeat(32)}${"44".repeat(32)}`);
    });

    test("throws on a signature that is not 65 bytes", () => {
      const shortSig = `0x${"11".repeat(64)}` as Hex; // 64 bytes, missing v
      expect(() => packSignatures([shortSig])).toThrow("Omnibridge signature has unexpected length 64 bytes");
    });
  });

  describe("getGnosisEgressCalls", () => {
    test("returns approve, transmuter withdraw, and transferAndCall into the home bridge", async () => {
      const tokenIn = makeToken(USDC[gnosis.id], AMOUNT, gnosis.id, { walletAddress: WALLET });

      const calls = await getGnosisEgressCalls(tokenIn, RECEIVER);

      expect(buildERC20ApprovalCalls).toHaveBeenCalledWith(tokenIn, USDC_TRANSMUTER);
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe(APPROVE_CALL);

      // Unwrap USDC.e via the transmuter: withdraw(amount), selector 0x2e1a7d4d.
      expect(calls[1].to).toBe(USDC_TRANSMUTER);
      const withdrawData = calls[1].data as Hex;
      expect(withdrawData.startsWith("0x2e1a7d4d")).toBe(true);
      const withdraw = decodeFunctionData({ abi: parseAbi(["function withdraw(uint256 amount)"]), data: withdrawData });
      expect(withdraw.functionName).toBe("withdraw");
      expect(withdraw.args).toEqual([AMOUNT]);

      // Bridge the legacy USDC with the receiver as a raw 20-byte payload.
      expect(calls[2].to).toBe(USDC_ON_XDAI);
      const bridge = decodeFunctionData({
        abi: parseAbi(["function transferAndCall(address to, uint256 value, bytes data) returns (bool)"]),
        data: calls[2].data as Hex,
      });
      expect(bridge.functionName).toBe("transferAndCall");
      expect(bridge.args?.[0]).toBe(HOME_OMNIBRIDGE);
      expect(bridge.args?.[1]).toBe(AMOUNT);
      expect((bridge.args?.[2] as Hex).toLowerCase()).toBe(RECEIVER.toLowerCase());
    });
  });

  describe("getMainnetIngressCalls", () => {
    test("returns approve and relayTokensAndCall through the transmuter", async () => {
      const tokenIn = makeToken(USDC[mainnet.id], AMOUNT, mainnet.id, { walletAddress: WALLET });

      const calls = await getMainnetIngressCalls(tokenIn, RECEIVER);

      expect(buildERC20ApprovalCalls).toHaveBeenCalledWith(tokenIn, FOREIGN_OMNIBRIDGE);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(APPROVE_CALL);

      expect(calls[1].to).toBe(FOREIGN_OMNIBRIDGE);
      const relay = decodeFunctionData({
        abi: parseAbi(["function relayTokensAndCall(address token, address receiver, uint256 value, bytes data)"]),
        data: calls[1].data as Hex,
      });
      expect(relay.functionName).toBe("relayTokensAndCall");
      expect(relay.args).toEqual([
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // mainnet USDC
        USDC_TRANSMUTER,
        AMOUNT,
        encodeAbiParameters([{ type: "address" }], [RECEIVER]),
      ]);
    });
  });

  describe("executeOmnibridgeBurn", () => {
    test("sends egress calls in atomic-steps mode on Gnosis and returns hash + chain", async () => {
      const tokenIn = makeToken(USDC[gnosis.id], AMOUNT, gnosis.id, { walletAddress: WALLET });
      const tokenOut = makeToken(USDC[mainnet.id], 0n, mainnet.id, { walletAddress: RECEIVER });
      const sendCalls = vi.fn().mockResolvedValue(["0xburnhash", []]);

      const [txHash, chainId] = await executeOmnibridgeBurn(tokenIn, tokenOut, sendCalls);

      expect(txHash).toBe("0xburnhash");
      expect(chainId).toBe(gnosis.id);
      expect(sendCalls).toHaveBeenCalledTimes(1);
      expect(sendCalls).toHaveBeenCalledWith("burn", gnosis.id, WALLET, expect.any(Array), "atomic-steps", undefined);
      // approve + withdraw + transferAndCall, receiver = tokenOut's wallet
      const calls = sendCalls.mock.calls[0][3] as Call[];
      expect(calls).toHaveLength(3);
      expect(calls[2].to).toBe(USDC_ON_XDAI);
    });
  });

  describe("executeOmnibridgeDeposit", () => {
    test("reads the receiver's USDC.e baseline before sending and returns the delivery record", async () => {
      const tokenIn = makeToken(USDC[mainnet.id], AMOUNT, mainnet.id, { walletAddress: WALLET });
      const tokenOut = makeToken(USDC[gnosis.id], 0n, gnosis.id, { walletAddress: RECEIVER });
      vi.mocked(getTokenBalance).mockResolvedValue(5_000_000n);
      const sendCalls = vi.fn().mockResolvedValue(["0xdeposithash", []]);

      const [txHash, delivery] = await executeOmnibridgeDeposit(tokenIn, tokenOut, sendCalls);

      expect(txHash).toBe("0xdeposithash");
      expect(delivery).toEqual({
        txHash: "0xdeposithash",
        toAddress: RECEIVER,
        baselineUnits: "5000000",
        minDeliveredUnits: "1000000",
      });

      expect(getTokenBalance).toHaveBeenCalledWith(gnosis.id, RECEIVER, USDC[gnosis.id]);
      expect(sendCalls).toHaveBeenCalledWith(
        "deposit",
        mainnet.id,
        WALLET,
        expect.any(Array),
        "atomic-steps",
        undefined,
      );
      // The baseline read must happen BEFORE the deposit is sent, so a retry
      // after arrival cannot double-count the minted amount.
      expect(vi.mocked(getTokenBalance).mock.invocationCallOrder[0]).toBeLessThan(
        sendCalls.mock.invocationCallOrder[0],
      );
    });
  });

  describe("retrieveOmnibridgeClaims", () => {
    test("polls numMessagesSigned until processed, then packs the collected signatures", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => {});

      const numSignedResponses = [2n, PROCESSED_FLAG | 2n];
      const readContract = vi.fn(({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === "numMessagesSigned") return Promise.resolve(numSignedResponses.shift());
        if (functionName === "signature") return Promise.resolve([SIG_1, SIG_2][Number(args[1])]);
        return Promise.reject(new Error(`unexpected readContract ${functionName}`));
      });
      mockClient({
        getTransactionReceipt: vi.fn().mockResolvedValue({
          logs: [
            // Same event from a stranger contract — must be ignored.
            userRequestLog("0x0000000000000000000000000000000000000001", `0x${"ee".repeat(32)}` as Hex, "0xdead"),
            userRequestLog(HOME_AMB, MESSAGE_ID, ENCODED_DATA),
            initiatedLog(HOME_OMNIBRIDGE, MESSAGE_ID, AMOUNT),
          ],
        }),
        readContract,
      });

      const onProgress = vi.fn();
      const promise = retrieveOmnibridgeClaims(["0xsourcetx"], undefined, onProgress);

      // First poll: 2 signatures collected but processed bit not set -> sleep 5s.
      await vi.advanceTimersByTimeAsync(0);
      expect(readContract).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);

      const claims = await promise;

      expect(getPublicClient).toHaveBeenCalledWith(gnosis.id);
      expect(claims).toEqual([
        {
          messageId: MESSAGE_ID,
          message: ENCODED_DATA,
          signatures: packSignatures([SIG_1, SIG_2]),
          amount: AMOUNT.toString(),
          sourceTxHash: "0xsourcetx",
        },
      ]);

      const messageHash = keccak256(ENCODED_DATA);
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: HOME_AMB, functionName: "numMessagesSigned", args: [messageHash] }),
      );
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: HOME_AMB, functionName: "signature", args: [messageHash, 0n] }),
      );
      expect(readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: HOME_AMB, functionName: "signature", args: [messageHash, 1n] }),
      );
      expect(onProgress.mock.calls).toEqual([
        [0, 1],
        [1, 1],
      ]);
    });

    test("throws 'Omnibridge signature retrieval failed' when the receipt has no AMB message", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      mockClient({
        getTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
        readContract: vi.fn(),
      });

      await expect(retrieveOmnibridgeClaims(["0xsourcetx"])).rejects.toThrow("Omnibridge signature retrieval failed");
    });

    test("aborting mid-poll rejects with AbortError, not the generic wrapper error", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => {});

      const readContract = vi.fn().mockResolvedValue(2n); // never processed
      mockClient({
        getTransactionReceipt: vi.fn().mockResolvedValue({
          logs: [userRequestLog(HOME_AMB, MESSAGE_ID, ENCODED_DATA), initiatedLog(HOME_OMNIBRIDGE, MESSAGE_ID, AMOUNT)],
        }),
        readContract,
      });

      const controller = new AbortController();
      const caught = retrieveOmnibridgeClaims(["0xsourcetx"], controller.signal).catch((e) => e);

      // Let the first poll resolve and the 5s inter-poll sleep start.
      await vi.advanceTimersByTimeAsync(0);
      expect(readContract).toHaveBeenCalledTimes(1);

      controller.abort();

      const err = (await caught) as Error;
      expect(err.name).toBe("AbortError");
      // No further polls after the abort.
      expect(readContract).toHaveBeenCalledTimes(1);
    });

    test("times out with OmnibridgeTimeoutError when signatures never complete", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "log").mockImplementation(() => {});

      mockClient({
        getTransactionReceipt: vi.fn().mockResolvedValue({
          logs: [userRequestLog(HOME_AMB, MESSAGE_ID, ENCODED_DATA), initiatedLog(HOME_OMNIBRIDGE, MESSAGE_ID, AMOUNT)],
        }),
        readContract: vi.fn().mockResolvedValue(2n), // never processed
      });

      const caught = retrieveOmnibridgeClaims(["0xsourcetx"]).catch((e) => e);

      // Push past the 15-minute signature deadline.
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

      const err = (await caught) as Error;
      expect(err).toBeInstanceOf(OmnibridgeTimeoutError);
      expect(err.message).toContain("OMNIBRIDGE_TIMEOUT");
    });
  });

  describe("getExecuteSignaturesCalls", () => {
    const claim = (id: string): OmnibridgeClaim => ({
      messageId: `0x${id.repeat(32)}` as Hex,
      message: `0x${id.repeat(40)}` as Hex,
      signatures: packSignatures([SIG_1, SIG_2]),
      amount: AMOUNT.toString(),
      sourceTxHash: "0xsourcetx",
    });

    test("builds executeSignatures only for not-yet-relayed messages", async () => {
      const relayedClaim = claim("aa");
      const pendingClaim = claim("bb");
      const multicall = vi.fn().mockResolvedValue([{ result: true }, { result: false }]);
      mockClient({ multicall });

      const calls = await getExecuteSignaturesCalls([relayedClaim, pendingClaim]);

      expect(getPublicClient).toHaveBeenCalledWith(mainnet.id);
      expect(multicall).toHaveBeenCalledWith({
        contracts: [
          expect.objectContaining({
            address: FOREIGN_AMB,
            functionName: "relayedMessages",
            args: [relayedClaim.messageId],
          }),
          expect.objectContaining({
            address: FOREIGN_AMB,
            functionName: "relayedMessages",
            args: [pendingClaim.messageId],
          }),
        ],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(FOREIGN_AMB);
      const decoded = decodeFunctionData({
        abi: parseAbi(["function executeSignatures(bytes data, bytes signatures) external"]),
        data: calls[0].data as Hex,
      });
      expect(decoded.functionName).toBe("executeSignatures");
      expect(decoded.args).toEqual([pendingClaim.message, pendingClaim.signatures]);
    });
  });

  describe("executeOmnibridgeClaim", () => {
    const claim: OmnibridgeClaim = {
      messageId: MESSAGE_ID,
      message: ENCODED_DATA,
      signatures: packSignatures([SIG_1, SIG_2]),
      amount: AMOUNT.toString(),
      sourceTxHash: "0xsourcetx",
    };
    const tokenOut = makeToken(USDC[mainnet.id], AMOUNT, mainnet.id, { walletAddress: RECEIVER });

    test("throws when given no claims", async () => {
      const sendCalls = vi.fn();
      await expect(executeOmnibridgeClaim([], tokenOut, sendCalls)).rejects.toThrow("No Omnibridge claims");
      expect(sendCalls).not.toHaveBeenCalled();
    });

    test("returns empty result without sending when every message is already relayed", async () => {
      mockClient({ multicall: vi.fn().mockResolvedValue([{ result: true }]) });
      const sendCalls = vi.fn();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const [txHash, logs] = await executeOmnibridgeClaim([claim], tokenOut, sendCalls);

      expect(txHash).toBe("");
      expect(logs).toEqual([]);
      expect(sendCalls).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith("Omnibridge claim skipped: all 1 message(s) already relayed on mainnet");
    });

    test("sends pending claims as an atomic multicall on mainnet, forwarding retry hints", async () => {
      mockClient({ multicall: vi.fn().mockResolvedValue([{ result: false }]) });
      const claimLogs = [[{ address: FOREIGN_AMB as Address, data: "0xlog" as Hex, topics: ["0xtopic" as Hex] }]];
      const sendCalls = vi.fn().mockResolvedValue(["0xclaimhash", claimLogs]);
      const retryHints = { nonce: 7, maxFeePerGas: 42n };

      const [txHash, logs] = await executeOmnibridgeClaim([claim], tokenOut, sendCalls, retryHints);

      expect(txHash).toBe("0xclaimhash");
      expect(logs).toBe(claimLogs);
      expect(sendCalls).toHaveBeenCalledWith(
        "claim",
        mainnet.id,
        RECEIVER,
        expect.any(Array),
        "atomic-multicall",
        retryHints,
      );
      const calls = sendCalls.mock.calls[0][3] as Call[];
      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(FOREIGN_AMB);
    });
  });

  describe("waitForOmnibridgeDelivery", () => {
    const delivery: OmnibridgeDelivery = {
      txHash: "0xdeposithash",
      toAddress: RECEIVER,
      baselineUnits: "1000000",
      minDeliveredUnits: "500000",
    };

    test("polls the receiver's USDC.e balance until baseline + minDelivered lands", async () => {
      vi.useFakeTimers();
      vi.mocked(getTokenBalance)
        .mockResolvedValueOnce(1_200_000n) // below 1.5M threshold
        .mockResolvedValueOnce(1_500_000n); // arrived
      const onProgress = vi.fn();

      const promise = waitForOmnibridgeDelivery([delivery], undefined, onProgress);
      await vi.advanceTimersByTimeAsync(0); // first poll -> still pending, sleep 5s
      expect(getTokenBalance).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000); // second poll -> delivered
      await promise;

      expect(getTokenBalance).toHaveBeenCalledTimes(2);
      expect(getTokenBalance).toHaveBeenCalledWith(gnosis.id, RECEIVER, USDC[gnosis.id]);
      expect(onProgress.mock.calls).toEqual([
        [0, 1],
        [1, 1],
      ]);
    });

    test("resolves on the first poll when the balance already covers the delivery (idempotent retry)", async () => {
      vi.mocked(getTokenBalance).mockResolvedValue(2_000_000n);
      await expect(waitForOmnibridgeDelivery([delivery])).resolves.toBeUndefined();
      expect(getTokenBalance).toHaveBeenCalledTimes(1);
    });

    test("tolerates a transient balance-read error and keeps polling", async () => {
      vi.useFakeTimers();
      vi.mocked(getTokenBalance).mockRejectedValueOnce(new Error("rpc hiccup")).mockResolvedValueOnce(1_500_000n);

      const promise = waitForOmnibridgeDelivery([delivery]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBeUndefined();
      expect(getTokenBalance).toHaveBeenCalledTimes(2);
    });

    test("times out with OmnibridgeTimeoutError when delivery never confirms", async () => {
      vi.useFakeTimers();
      vi.mocked(getTokenBalance).mockResolvedValue(0n);

      const caught = waitForOmnibridgeDelivery([delivery], undefined, undefined, 10).catch((e) => e);
      await vi.advanceTimersByTimeAsync(5000);

      const err = (await caught) as Error;
      expect(err).toBeInstanceOf(OmnibridgeTimeoutError);
      expect(err.message).toContain("OMNIBRIDGE_TIMEOUT");
    });
  });
});
