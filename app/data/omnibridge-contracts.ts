/**
 * Gnosis Omnibridge / AMB contracts used for the Gnosis <-> Ethereum mainnet
 * bridge leg (Gnosis has no CCTP; mainnet acts as the hub).
 *
 * USDC on Gnosis is layered: the Omnibridge pair of mainnet USDC is the
 * legacy "USD//C on xDai" token, while the liquid, Circle-endorsed token is
 * USDC.e. The official USDCTransmuter converts between the two 1:1 with no
 * fee: egress swaps USDC.e -> legacy USDC before bridging, ingress bridges
 * through the transmuter (`relayTokensAndCall`) so USDC.e is minted directly
 * to the receiver.
 */

/** Omnibridge token mediator on Gnosis (home side). */
export const HOME_OMNIBRIDGE = "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d" as const;

/** Omnibridge token mediator on Ethereum mainnet (foreign side). */
export const FOREIGN_OMNIBRIDGE = "0x88ad09518695c6c3712AC10a214bE5109a655671" as const;

/** Arbitrary Message Bridge on Gnosis; collects validator signatures for exits. */
export const HOME_AMB = "0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59" as const;

/** Arbitrary Message Bridge on Ethereum mainnet; `executeSignatures` target. */
export const FOREIGN_AMB = "0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e" as const;

/** Legacy "USD//C on xDai" — the token actually registered on the Omnibridge. */
export const USDC_ON_XDAI = "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83" as const;

/** USDCTransmuter on Gnosis: 1:1 fee-free swap between USDC.e and legacy USDC. */
export const USDC_TRANSMUTER = "0x0392A2F5Ac47388945D8c84212469F545fAE52B2" as const;
