/**
 * Fraction of the swap input taken as our integrator fee (0.001 = 0.1%).
 * Sent as the `fee` query param on `/v1/quotes`, which requires the
 * `integrator` param. The fee recipient wallet
 * (0x6b3CffBfBeba292b1E588DA438d5D172Ee89387D) is configured in the Delora
 * Partner Portal (https://portal.delora.build), not in the request; on EVM
 * chains fees accrue in Delora's Fee Pool contract and are claimed manually.
 * See https://docs.delora.build/protocol/fee-configuration.
 */
export const OCTOCASH_SWAP_FEE = 0.001;

/** Integrator identifier registered in the Delora Partner Portal. */
export const DELORA_INTEGRATOR: string = import.meta.env.VITE_DELORA_INTEGRATOR || "octocash";
