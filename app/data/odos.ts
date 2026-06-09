import { getAddress } from "viem";

/**
 * Odos splits the fee 80/20 with the recipient.
 * See https://docs.odos.xyz/home/api-monetization.
 */
export const OCTOCASH_REFERRAL_FEE = 0.001;

/** Checksummed recipient for the Odos `referralFeeRecipient` quote param. */
export const OCTOCASH_FEE_RECIPIENT = getAddress("0x6b3CffBfBeba292b1E588DA438d5D172Ee89387D");
