import type { Address, Call, Hex } from "viem";

export enum ConsolidationStep {
  IDLE = "idle",
  SWAPPING = "swapping",
  BURNING = "burning",
  WAITING_ATTESTATION = "waiting-attestation",
  MINTING = "minting",
  SWAPPING_BACK = "swapping-back",
  COMPLETED = "completed",
  ERROR = "error",
}

export interface TokenAmount {
  token: Address;
  amount: bigint;
  walletAddress: Address;
  chainId: number;
}

export type ConsolidationProgressCallback = (step: ConsolidationStep) => void;

export type SendCallsFn = (
  txId: string,
  chainId: number,
  from: Address,
  calls: Call[],
) => Promise<[string, { address: Address; data: Hex; topics: Hex[] }[]]>;
