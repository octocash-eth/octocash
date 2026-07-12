import {
  type Address,
  type Call,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { gnosis, mainnet } from "viem/chains";
import {
  FOREIGN_AMB,
  FOREIGN_OMNIBRIDGE,
  HOME_AMB,
  HOME_OMNIBRIDGE,
  USDC_ON_XDAI,
  USDC_TRANSMUTER,
} from "~/data/omnibridge-contracts";
import { USDC } from "~/data/token-contracts";
import { getPublicClient } from "~/lib/public-client";
import type { SendCallsFn } from "~/lib/send-calls";
import type { TokenAmount } from "~/lib/types";
import { abortableSleep, isAbortError } from "./cctp";
import { buildERC20ApprovalCalls, getTokenBalance } from "./tokens";

/**
 * Gnosis <-> Ethereum mainnet USDC bridging over the Omnibridge (the native
 * token bridge; Gnosis has no CCTP). Mirrors cctp.ts's burn / wait / claim
 * shape, with two asymmetries:
 *
 * - Egress (Gnosis -> mainnet): burn on Gnosis, wait for the home AMB's
 *   validators to collect signatures (~1-2 min), then anyone submits
 *   `executeSignatures` on the mainnet AMB to release native USDC.
 * - Ingress (mainnet -> Gnosis): deposit on mainnet; validators mint on
 *   Gnosis automatically after mainnet finality (~15-20 min) — there is no
 *   claim transaction, so delivery is confirmed by balance-watching the
 *   receiver (same idempotent baseline pattern as gas-refuel).
 *
 * USDC on Gnosis is layered (see omnibridge-contracts.ts): the bridge moves
 * the legacy "USD//C on xDai" token, while wallets and DEXes hold USDC.e.
 * The official USDCTransmuter converts 1:1 fee-free: egress unwraps USDC.e
 * before bridging; ingress routes through the transmuter via
 * `relayTokensAndCall` so USDC.e lands directly at the receiver.
 *
 * The Omnibridge is a multi-token bridge, so USDC is only the fallback
 * routing token: when the destination token itself has a registered
 * counterpart on the other side (e.g. GNO <-> GNO), the source side swaps
 * into that token and bridges it directly with plain `relayTokens`, skipping
 * the transmuter and the post-bridge swap.
 */

/** A signed home->foreign AMB message, ready for `executeSignatures`. */
export type OmnibridgeClaim = {
  messageId: Hex;
  /** Full AMB message (`encodedData` from `UserRequestForSignature`). */
  message: Hex;
  /** Packed validator signatures: count byte + v[] + r[] + s[]. */
  signatures: Hex;
  /** Bridged amount in the token's own units, as string for persistence. */
  amount: string;
  sourceTxHash: string;
};

/**
 * A sent mainnet->Gnosis deposit, persisted in
 * `ConsolidationState.metadata.omnibridge.deliveries` so the wait step can
 * confirm arrival — including across a page reload or retry, thanks to the
 * pre-deposit balance baseline.
 */
export type OmnibridgeDelivery = {
  txHash: string;
  /** Receiver of the minted token on Gnosis. */
  toAddress: Address;
  /**
   * Gnosis-side token whose balance is watched. Absent on records persisted
   * before direct-route support — those are USDC.e deliveries.
   */
  tokenAddress?: Address;
  /** Receiver's watched-token balance BEFORE the deposit (units, as string). */
  baselineUnits: string;
  /** Landed when balance >= baseline + minDelivered (units, as string). */
  minDeliveredUnits: string;
};

const SIGNATURE_TIMEOUT_MS = 15 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 40 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

/** Bit 255 of `numMessagesSigned` — set once enough signatures collected. */
const PROCESSED_FLAG = 1n << 255n;

export class OmnibridgeTimeoutError extends Error {
  constructor(detail: string) {
    // The OMNIBRIDGE_TIMEOUT prefix is what createTransactionError keys on.
    super(`OMNIBRIDGE_TIMEOUT: ${detail}`);
    this.name = "OmnibridgeTimeoutError";
  }
}

const homeAmbAbi = parseAbi([
  "event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)",
  "function numMessagesSigned(bytes32 message) view returns (uint256)",
  "function signature(bytes32 hash, uint256 index) view returns (bytes)",
]);

const foreignAmbAbi = parseAbi([
  "function relayedMessages(bytes32 messageId) view returns (bool)",
  "function executeSignatures(bytes data, bytes signatures) external",
]);

const omnibridgeInitiatedAbi = parseAbi([
  "event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)",
]);

const mediatorAbi = parseAbi([
  "function bridgedTokenAddress(address nativeToken) view returns (address)",
  "function nativeTokenAddress(address bridgedToken) view returns (address)",
  "function minPerTx(address token) view returns (uint256)",
]);

/** A token registered on the Omnibridge, addressable on both sides. */
export type OmnibridgeTokenPair = {
  /** Token address on Gnosis (home side). */
  gnosisToken: Address;
  /** Token address on Ethereum mainnet (foreign side). */
  mainnetToken: Address;
};

/**
 * Resolves the Omnibridge counterpart of `token` (held on `chainId`) on the
 * other side of the bridge. Each mediator maps tokens native to the OTHER
 * side via `bridgedTokenAddress` and tokens bridged onto ITS side via
 * `nativeTokenAddress`, so both directions are probed.
 *
 * Returns null when the token is native (zero address), not registered on
 * the bridge, or part of the USDC pair — USDC keeps the dedicated
 * USDCTransmuter route because the registered legacy "USD//C on xDai" token
 * is illiquid on Gnosis DEXes and must not become a swap target.
 */
export const resolveOmnibridgeTokenPair = async (
  token: Address,
  chainId: number,
): Promise<OmnibridgeTokenPair | null> => {
  if (isAddressEqual(token, zeroAddress)) return null;
  if (chainId !== mainnet.id && chainId !== gnosis.id) return null;

  const homeClient = getPublicClient(gnosis.id);
  const foreignClient = getPublicClient(mainnet.id);

  let counterpart: Address;
  if (chainId === mainnet.id) {
    // Mainnet-native token (GNO, WETH, ...) -> its bridged twin on Gnosis.
    counterpart = await homeClient.readContract({
      address: HOME_OMNIBRIDGE,
      abi: mediatorAbi,
      functionName: "bridgedTokenAddress",
      args: [token],
    });
    if (isAddressEqual(counterpart, zeroAddress)) {
      // Gnosis-native token bridged onto mainnet -> its home address.
      counterpart = await foreignClient.readContract({
        address: FOREIGN_OMNIBRIDGE,
        abi: mediatorAbi,
        functionName: "nativeTokenAddress",
        args: [token],
      });
    }
  } else {
    // Bridged-onto-Gnosis token -> its native mainnet address.
    counterpart = await homeClient.readContract({
      address: HOME_OMNIBRIDGE,
      abi: mediatorAbi,
      functionName: "nativeTokenAddress",
      args: [token],
    });
    if (isAddressEqual(counterpart, zeroAddress)) {
      // Gnosis-native token -> its bridged twin on mainnet.
      counterpart = await foreignClient.readContract({
        address: FOREIGN_OMNIBRIDGE,
        abi: mediatorAbi,
        functionName: "bridgedTokenAddress",
        args: [token],
      });
    }
  }
  if (isAddressEqual(counterpart, zeroAddress)) return null;

  const pair: OmnibridgeTokenPair =
    chainId === mainnet.id
      ? { gnosisToken: counterpart, mainnetToken: token }
      : { gnosisToken: token, mainnetToken: counterpart };

  if (isAddressEqual(pair.gnosisToken, USDC_ON_XDAI) || isAddressEqual(pair.mainnetToken, USDC[mainnet.id])) {
    return null;
  }
  return pair;
};

/**
 * Reads the mediator's per-transaction minimum for a direct-route token on
 * the sending side (home mediator for egress, foreign for ingress). Amounts
 * below it revert on `relayTokens`, so planning rejects them upfront.
 */
export const getOmnibridgeMinPerTx = async (direction: "egress" | "ingress", token: Address): Promise<bigint> => {
  const [chainId, mediator] =
    direction === "egress" ? ([gnosis.id, HOME_OMNIBRIDGE] as const) : ([mainnet.id, FOREIGN_OMNIBRIDGE] as const);
  return getPublicClient(chainId).readContract({
    address: mediator,
    abi: mediatorAbi,
    functionName: "minPerTx",
    args: [token],
  });
};

/**
 * Packs validator signatures into the blob `executeSignatures` expects:
 * one count byte, then all v bytes, all r words, all s words (tokenbridge
 * "packSignatures" format). Each input is a standard 65-byte r‖s‖v signature
 * as returned by the home AMB's `signature(hash, index)` getter.
 */
export const packSignatures = (signatures: Hex[]): Hex => {
  const vs: string[] = [];
  const rs: string[] = [];
  const ss: string[] = [];
  for (const sig of signatures) {
    const hex = sig.slice(2);
    if (hex.length !== 130) {
      throw new Error(`Omnibridge signature has unexpected length ${hex.length / 2} bytes (expected 65)`);
    }
    rs.push(hex.slice(0, 64));
    ss.push(hex.slice(64, 128));
    vs.push(hex.slice(128, 130));
  }
  const count = signatures.length.toString(16).padStart(2, "0");
  return `0x${count}${vs.join("")}${rs.join("")}${ss.join("")}`;
};

/**
 * Builds the Gnosis-side egress calls for one wallet.
 *
 * USDC.e takes the transmuter detour: unwrap to the bridge-registered legacy
 * USDC, then `transferAndCall` it into the home Omnibridge with the mainnet
 * receiver as payload (a raw 20-byte address, per the bridge UI's format).
 * Any other registered token bridges directly: approve the home mediator and
 * `relayTokens` it toward the receiver.
 */
export const getGnosisEgressCalls = async (tokenIn: TokenAmount, receiver: Address): Promise<Call[]> => {
  const { amount } = tokenIn;

  if (!isAddressEqual(tokenIn.token, USDC[gnosis.id])) {
    const approvalCalls = await buildERC20ApprovalCalls(tokenIn, HOME_OMNIBRIDGE);
    const relayCall: Call = {
      to: HOME_OMNIBRIDGE,
      data: encodeFunctionData({
        abi: parseAbi(["function relayTokens(address token, address receiver, uint256 value)"]),
        functionName: "relayTokens",
        args: [tokenIn.token, receiver, amount],
      }),
    };
    return [...approvalCalls, relayCall];
  }

  const approvalCalls = await buildERC20ApprovalCalls(tokenIn, USDC_TRANSMUTER);

  const withdrawCall: Call = {
    to: USDC_TRANSMUTER,
    data: encodeFunctionData({
      abi: parseAbi(["function withdraw(uint256 amount)"]),
      functionName: "withdraw",
      args: [amount],
    }),
  };

  const bridgeCall: Call = {
    to: USDC_ON_XDAI,
    data: encodeFunctionData({
      abi: parseAbi(["function transferAndCall(address to, uint256 value, bytes data) returns (bool)"]),
      functionName: "transferAndCall",
      args: [HOME_OMNIBRIDGE, amount, receiver],
    }),
  };

  return [...approvalCalls, withdrawCall, bridgeCall];
};

/**
 * Builds the mainnet-side ingress calls for one wallet: approve the foreign
 * Omnibridge, then relay. USDC goes through `relayTokensAndCall` via the
 * USDCTransmuter so its `onTokenBridged` mints USDC.e straight to `receiver`
 * on Gnosis; any other registered token uses plain `relayTokens` and its
 * bridged twin is minted (or its home token released) directly to the
 * receiver.
 */
export const getMainnetIngressCalls = async (tokenIn: TokenAmount, receiver: Address): Promise<Call[]> => {
  const { amount } = tokenIn;

  const approvalCalls = await buildERC20ApprovalCalls(tokenIn, FOREIGN_OMNIBRIDGE);

  if (!isAddressEqual(tokenIn.token, USDC[mainnet.id])) {
    const relayCall: Call = {
      to: FOREIGN_OMNIBRIDGE,
      data: encodeFunctionData({
        abi: parseAbi(["function relayTokens(address token, address receiver, uint256 value)"]),
        functionName: "relayTokens",
        args: [tokenIn.token, receiver, amount],
      }),
    };
    return [...approvalCalls, relayCall];
  }

  const relayCall: Call = {
    to: FOREIGN_OMNIBRIDGE,
    data: encodeFunctionData({
      abi: parseAbi(["function relayTokensAndCall(address token, address receiver, uint256 value, bytes data)"]),
      functionName: "relayTokensAndCall",
      args: [USDC[mainnet.id], USDC_TRANSMUTER, amount, encodeAbiParameters([{ type: "address" }], [receiver])],
    }),
  };

  return [...approvalCalls, relayCall];
};

/**
 * Executes the Gnosis->mainnet burn step.
 * @returns The bridge transaction hash (the `transferAndCall`, whose receipt
 *   carries the AMB message) and the source chain ID.
 */
export const executeOmnibridgeBurn = async (
  tokenIn: TokenAmount,
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
  retryHints?: Parameters<SendCallsFn>[5],
): Promise<[string, number]> => {
  const calls = await getGnosisEgressCalls(tokenIn, tokenOut.walletAddress);
  const [bridgeTx] = await sendCalls("burn", tokenIn.chainId, tokenIn.walletAddress, calls, "atomic-steps", retryHints);
  return [bridgeTx, tokenIn.chainId];
};

/**
 * Executes the mainnet->Gnosis deposit step. Reads the receiver's balance of
 * the delivered Gnosis-side token (`tokenOut.token`) BEFORE depositing so the
 * wait step's delivery check is idempotent.
 * @returns The deposit transaction hash and the delivery record to persist.
 */
export const executeOmnibridgeDeposit = async (
  tokenIn: TokenAmount,
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
  retryHints?: Parameters<SendCallsFn>[5],
): Promise<[string, OmnibridgeDelivery]> => {
  const receiver = tokenOut.walletAddress;
  const baseline = await getTokenBalance(gnosis.id, receiver, tokenOut.token);

  const calls = await getMainnetIngressCalls(tokenIn, receiver);
  const [depositTx] = await sendCalls(
    "deposit",
    tokenIn.chainId,
    tokenIn.walletAddress,
    calls,
    "atomic-steps",
    retryHints,
  );

  return [
    depositTx,
    {
      txHash: depositTx,
      toAddress: receiver,
      tokenAddress: tokenOut.token,
      baselineUnits: baseline.toString(),
      // The Omnibridge mints 1:1 with no fee.
      minDeliveredUnits: tokenIn.amount.toString(),
    },
  ];
};

const retrieveOmnibridgeClaim = async (
  transactionHash: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onProgress?: (collected: number, required: number) => void,
): Promise<OmnibridgeClaim[]> => {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const publicClient = getPublicClient(gnosis.id);

  const receipt = await publicClient.getTransactionReceipt({ hash: transactionHash as Hex });
  const requests = parseEventLogs({ abi: homeAmbAbi, logs: receipt.logs, eventName: "UserRequestForSignature" }).filter(
    (log) => log.address.toLowerCase() === HOME_AMB.toLowerCase(),
  );
  const initiated = parseEventLogs({
    abi: omnibridgeInitiatedAbi,
    logs: receipt.logs,
    eventName: "TokensBridgingInitiated",
  }).filter((log) => log.address.toLowerCase() === HOME_OMNIBRIDGE.toLowerCase());
  if (requests.length === 0) {
    throw new Error(`No Omnibridge message found in tx ${transactionHash}`);
  }

  const claims: OmnibridgeClaim[] = [];
  for (const request of requests) {
    const { messageId, encodedData } = request.args;
    const messageHash = keccak256(encodedData);
    const amount = initiated.find((log) => log.args.messageId === messageId)?.args.value ?? 0n;

    const deadline = Date.now() + timeoutMs;
    let signedCount = 0n;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const numSigned = await publicClient.readContract({
        address: HOME_AMB,
        abi: homeAmbAbi,
        functionName: "numMessagesSigned",
        args: [messageHash],
      });
      signedCount = numSigned & ~PROCESSED_FLAG;
      if (numSigned & PROCESSED_FLAG) break;
      onProgress?.(Number(signedCount), 0);
      if (Date.now() >= deadline) {
        throw new OmnibridgeTimeoutError(
          `signatures not collected in time for tx ${transactionHash} (message ${messageId})`,
        );
      }
      console.log("Waiting for Omnibridge signatures...");
      await abortableSleep(POLL_INTERVAL_MS, signal);
    }
    onProgress?.(Number(signedCount), Number(signedCount));

    const signatures = await Promise.all(
      Array.from({ length: Number(signedCount) }, (_, i) =>
        publicClient.readContract({
          address: HOME_AMB,
          abi: homeAmbAbi,
          functionName: "signature",
          args: [messageHash, BigInt(i)],
        }),
      ),
    );

    claims.push({
      messageId,
      message: encodedData,
      signatures: packSignatures(signatures),
      amount: amount.toString(),
      sourceTxHash: transactionHash,
    });
  }
  return claims;
};

/**
 * Waits until the home AMB validators have signed the messages produced by
 * the given Gnosis burn transactions, then returns the signed claims ready
 * for `executeOmnibridgeClaim` on mainnet. Analog of cctp's
 * `retrieveAttestations`, but fully on-chain (no external API).
 *
 * @param transactionHashes - Bridge tx hashes from `executeOmnibridgeBurn()`.
 * @param signal - Optional AbortSignal; interrupts reads and inter-poll waits.
 * @param onProgress - Optional `(readyMessages, totalMessages)` callback.
 */
export const retrieveOmnibridgeClaims = async (
  transactionHashes: string[],
  signal?: AbortSignal,
  onProgress?: (ready: number, total: number) => void,
): Promise<OmnibridgeClaim[]> => {
  const total = transactionHashes.length;
  onProgress?.(0, total);
  const claims: OmnibridgeClaim[] = [];
  for (let i = 0; i < transactionHashes.length; i++) {
    try {
      claims.push(...(await retrieveOmnibridgeClaim(transactionHashes[i], SIGNATURE_TIMEOUT_MS, signal)));
    } catch (error) {
      if (isAbortError(error) || error instanceof OmnibridgeTimeoutError) throw error;
      console.log(`Omnibridge claim error: ${error instanceof Error ? error.message : "Unknown error"}`);
      throw new Error("Omnibridge signature retrieval failed");
    }
    onProgress?.(i + 1, total);
  }
  return claims;
};

/** Builds `executeSignatures` calls for the not-yet-relayed messages. */
export const getExecuteSignaturesCalls = async (claims: OmnibridgeClaim[]): Promise<Call[]> => {
  const publicClient = getPublicClient(mainnet.id);

  const relayed = await publicClient.multicall({
    contracts: claims.map((claim) => ({
      address: FOREIGN_AMB,
      abi: foreignAmbAbi,
      functionName: "relayedMessages" as const,
      args: [claim.messageId],
    })),
  });

  return claims
    .filter((_, index) => !relayed[index].result)
    .map((claim) => ({
      to: FOREIGN_AMB,
      data: encodeFunctionData({
        abi: foreignAmbAbi,
        functionName: "executeSignatures",
        args: [claim.message, claim.signatures],
      }),
    }));
};

/**
 * Executes the mainnet claim step: submits `executeSignatures` for each
 * pending message, releasing native mainnet USDC to the receiver encoded in
 * the message. Already-relayed messages are filtered out first, so retries
 * are safe. Analog of `executeCCTPMint`.
 */
export const executeOmnibridgeClaim = async (
  claims: OmnibridgeClaim[],
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
  retryHints?: Parameters<SendCallsFn>[5],
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]> => {
  if (claims.length === 0) {
    throw new Error("No Omnibridge claims");
  }

  const calls = await getExecuteSignaturesCalls(claims);
  if (calls.length === 0) {
    console.warn(`Omnibridge claim skipped: all ${claims.length} message(s) already relayed on mainnet`);
    return ["", []];
  }

  const [claimTx, claimLogs] = await sendCalls(
    "claim",
    mainnet.id,
    tokenOut.walletAddress,
    calls,
    "atomic-multicall",
    retryHints,
  );
  return [claimTx, claimLogs];
};

/**
 * Waits until every mainnet->Gnosis deposit visibly lands: each receiver's
 * balance of the watched token reaches its pre-deposit baseline + deposited
 * amount. Idempotent — retrying after arrival resolves on the first poll.
 *
 * @param onProgress - Optional `(delivered, total)` callback per poll.
 */
export const waitForOmnibridgeDelivery = async (
  deliveries: OmnibridgeDelivery[],
  signal?: AbortSignal,
  onProgress?: (delivered: number, total: number) => void,
  timeoutMs: number = DELIVERY_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(deliveries.map((d, i) => [i, d]));

  while (pending.size > 0) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    for (const [index, delivery] of pending) {
      try {
        const balance = await getTokenBalance(gnosis.id, delivery.toAddress, delivery.tokenAddress ?? USDC[gnosis.id]);
        if (balance >= BigInt(delivery.baselineUnits) + BigInt(delivery.minDeliveredUnits)) {
          pending.delete(index);
        }
      } catch {
        // Transient RPC error — keep polling until the deadline.
      }
    }
    onProgress?.(deliveries.length - pending.size, deliveries.length);
    if (pending.size === 0) return;
    if (Date.now() >= deadline) {
      throw new OmnibridgeTimeoutError(
        `token delivery on Gnosis not confirmed for ${pending.size} of ${deliveries.length} deposit(s)`,
      );
    }
    await abortableSleep(POLL_INTERVAL_MS, signal);
  }
};
