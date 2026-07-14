import {
  type Address,
  type Call,
  type Chain,
  concatHex,
  encodeFunctionData,
  encodePacked,
  getAddress,
  type Hex,
  type HttpTransport,
  hashTypedData,
  pad,
  parseAbi,
  size,
  type Account as ViemAccount,
  type WalletClient,
} from "viem";
import { multiSendCallOnlyFor } from "~/data/safe-contracts";
import { getPublicClient, retryOnRateLimit } from "~/lib/public-client";

/**
 * Minimal Gnosis Safe (>=1.3.0) transaction primitives, hand-rolled on viem —
 * no @safe-global SDKs, matching how CCTP and Omnibridge are integrated here.
 * Covers exactly what consolidation needs: batch a step's calls into one Safe
 * transaction (MultiSendCallOnly), hash/sign it (EIP-712), and encode
 * `execTransaction` for submission by the connected owner EOA.
 */

export interface SafeTxData {
  to: Address;
  value: bigint;
  data: Hex;
  /** 0 = CALL, 1 = DELEGATECALL (only ever the MultiSendCallOnly dispatch). */
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: number;
}

export interface SafeOnChainInfo {
  address: Address;
  owners: Address[];
  threshold: number;
  nonce: number;
  version: string;
}

export class SafeNotOwnerError extends Error {
  constructor(owner: Address, safe: Address, chainId: number) {
    super(`SafeNotOwnerError: ${owner} is not an owner of Safe ${safe} on chain ${chainId}`);
    this.name = "SafeNotOwnerError";
  }
}

/** Recoverable: the plan pauses and retry re-enters the confirmation wait. */
export class SafeConfirmationTimeoutError extends Error {
  constructor(
    public readonly safeTxHash: Hex,
    public readonly confirmed: number,
    public readonly threshold: number,
  ) {
    super(
      `SafeConfirmationTimeoutError: Safe transaction ${safeTxHash} has ${confirmed}/${threshold} confirmations; resume anytime once co-signers approve`,
    );
    this.name = "SafeConfirmationTimeoutError";
  }
}

/** The proposal's nonce was consumed by another Safe tx (rejection or competitor). */
export class SafeTxSupersededError extends Error {
  constructor(
    public readonly safeTxHash: Hex,
    reason: string,
  ) {
    super(`SafeTxSupersededError: Safe transaction ${safeTxHash} was superseded: ${reason}`);
    this.name = "SafeTxSupersededError";
  }
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

const MULTI_SEND_ABI = parseAbi(["function multiSend(bytes transactions) payable"]);

/** EIP-712 SafeTx typed-data struct for Safe >=1.3.0 (domain includes chainId). */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const safeTxTypedData = (chainId: number, safe: Address, tx: SafeTxData) =>
  ({
    domain: { chainId: BigInt(chainId), verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas,
      baseGas: tx.baseGas,
      gasPrice: tx.gasPrice,
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: BigInt(tx.nonce),
    },
  }) as const;

/**
 * Packs calls into MultiSend's byte encoding: for each call
 * `uint8 operation (always 0) | address to | uint256 value | uint256 dataLength | bytes data`.
 */
export function encodeMultiSendTransactions(calls: Call[]): Hex {
  return concatHex(
    calls.map((call) => {
      const data = call.data ?? "0x";
      return encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [0, call.to as Address, call.value ?? 0n, BigInt(size(data)), data],
      );
    }),
  );
}

/**
 * Wraps a step's calls into one Safe transaction: a single call goes out as a
 * direct CALL; multiple calls batch through MultiSendCallOnly (delegatecall
 * dispatch, inner calls are plain CALLs and revert atomically).
 *
 * `safeTxGas = 0` + `gasPrice = 0` deliberately: with no gas refund in play
 * the Safe requires the inner call(s) to succeed (GS013 on failure), so a
 * failed swap can never be "successfully executed" as a no-op — the whole
 * execTransaction reverts and the step fails loudly.
 */
export function buildSafeTx(calls: Call[], nonce: number, safeVersion: string): SafeTxData {
  if (calls.length === 0) {
    throw new Error("buildSafeTx requires at least one call");
  }
  const base = {
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
  if (calls.length === 1) {
    const [call] = calls;
    return { to: call.to as Address, value: call.value ?? 0n, data: call.data ?? "0x", operation: 0, ...base };
  }
  return {
    to: multiSendCallOnlyFor(safeVersion),
    value: 0n,
    data: encodeFunctionData({
      abi: MULTI_SEND_ABI,
      functionName: "multiSend",
      args: [encodeMultiSendTransactions(calls)],
    }),
    operation: 1,
    ...base,
  };
}

/** The safeTxHash: EIP-712 hash owners sign and the Transaction Service keys by. */
export function hashSafeTx(chainId: number, safe: Address, tx: SafeTxData): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, tx));
}

/** EIP-712 signature over the SafeTx by the connected owner EOA. */
export async function signSafeTx(
  client: WalletClient<HttpTransport, Chain, ViemAccount>,
  chainId: number,
  safe: Address,
  tx: SafeTxData,
): Promise<Hex> {
  return client.signTypedData({ account: client.account, ...safeTxTypedData(chainId, safe, tx) });
}

/**
 * Safe "approved hash" sentinel signature (v = 1): valid without any prior
 * approveHash tx when `msg.sender == owner` during execTransaction. This is
 * the 1/1 fast path — the executing owner needs no signature popup at all.
 */
export function approvedHashSignature(owner: Address): Hex {
  return concatHex([pad(owner, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
}

/**
 * Encodes `execTransaction` calldata from the signed SafeTx. The Safe requires
 * signatures concatenated in ascending order of recovered owner address, so
 * confirmations are sorted here — callers pass them in any order.
 */
export function encodeExecTransaction(tx: SafeTxData, confirmations: { owner: Address; signature: Hex }[]): Hex {
  const signatures = concatHex(
    [...confirmations]
      .sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1))
      .map((confirmation) => confirmation.signature),
  );
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      signatures,
    ],
  });
}

/**
 * EIP-712 signer for the Transaction Service's proposal DeleteRequest
 * (domain name "Safe Transaction Service"; totp = unix hour).
 */
export function makeDeleteRequestSigner(
  client: WalletClient<HttpTransport, Chain, ViemAccount>,
  chainId: number,
  safe: Address,
): (safeTxHash: Hex, totp: number) => Promise<Hex> {
  return (safeTxHash, totp) =>
    client.signTypedData({
      account: client.account,
      domain: { name: "Safe Transaction Service", version: "1.0", chainId: BigInt(chainId), verifyingContract: safe },
      types: {
        DeleteRequest: [
          { name: "safeTxHash", type: "bytes32" },
          { name: "totp", type: "uint256" },
        ],
      },
      primaryType: "DeleteRequest",
      message: { safeTxHash, totp: BigInt(totp) },
    });
}

/**
 * Reads the Safe's live configuration straight from the chain — the source of
 * truth at execution time (the Transaction Service is used for discovery and
 * co-signer coordination, but owners/threshold/nonce are verified on-chain
 * before signing or executing).
 */
export async function readSafeInfo(chainId: number, safe: Address): Promise<SafeOnChainInfo> {
  const publicClient = getPublicClient(chainId);
  const contract = { address: safe, abi: SAFE_ABI } as const;
  const [owners, threshold, nonce, version] = await retryOnRateLimit(() =>
    publicClient.multicall({
      contracts: [
        { ...contract, functionName: "getOwners" },
        { ...contract, functionName: "getThreshold" },
        { ...contract, functionName: "nonce" },
        { ...contract, functionName: "VERSION" },
      ],
      allowFailure: false,
    }),
  );
  return {
    address: safe,
    owners: owners.map((owner) => getAddress(owner)),
    threshold: Number(threshold),
    nonce: Number(nonce),
    version,
  };
}

/** True when `owner` (case-insensitive) is among the Safe's owners. */
export function isOwnerOf(info: { owners: Address[] }, owner: Address): boolean {
  const target = owner.toLowerCase();
  return info.owners.some((candidate) => candidate.toLowerCase() === target);
}
