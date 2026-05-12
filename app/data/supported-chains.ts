import { type Address, http } from "viem";
import { arbitrum, base, linea, mainnet, optimism, polygon, unichain } from "viem/chains";

export const chains = {
  [mainnet.id]: mainnet,
  // [avalanche.id]: avalanche,
  [optimism.id]: optimism,
  [arbitrum.id]: arbitrum,
  [base.id]: base,
  [polygon.id]: polygon,
  [unichain.id]: unichain,
  [linea.id]: linea,
  // [sonic.id]: sonic,
};

export const transports = import.meta.env.VITE_ALCHEMY_API_KEY
  ? {
      [mainnet.id]: http(`https://eth-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`),
      [optimism.id]: http(`https://opt-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`),
      [arbitrum.id]: http(`https://arb-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`),
      [base.id]: http(`https://base-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`),
      [polygon.id]: http(`https://polygon-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`),
      [unichain.id]: http(`https://unichain-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`),
      [linea.id]: http(`https://linea-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`),
    }
  : import.meta.env.VITE_DRPC_API_KEY
    ? {
        [mainnet.id]: http(`https://lb.drpc.live/ethereum/${import.meta.env.VITE_DRPC_API_KEY}`),
        [optimism.id]: http(`https://lb.drpc.live/optimism/${import.meta.env.VITE_DRPC_API_KEY}`),
        [arbitrum.id]: http(`https://lb.drpc.live/arbitrum/${import.meta.env.VITE_DRPC_API_KEY}`),
        [base.id]: http(`https://lb.drpc.live/base/${import.meta.env.VITE_DRPC_API_KEY}`),
        [polygon.id]: http(`https://lb.drpc.live/polygon/${import.meta.env.VITE_DRPC_API_KEY}`),
        [unichain.id]: http(`https://lb.drpc.live/unichain/${import.meta.env.VITE_DRPC_API_KEY}`),
        [linea.id]: http(`https://lb.drpc.live/linea/${import.meta.env.VITE_DRPC_API_KEY}`),
      }
    : undefined;

export const supportedChains = Object.entries(chains).map(([chainId, chain]) => ({
  id: Number(chainId),
  name: chain.name,
  icon: `/chain-icons/${chain.name.toLowerCase().replace(/\s+/g, "-")}.svg`,
  explorerUrl: chain.blockExplorers.default.url,
  nativeCurrency: chain.nativeCurrency,
}));

export const blockExplorers = {
  [mainnet.id]: "https://eth.blockscout.com",
  // [avalanche.id]: avalanche.blockExplorers.default,
  [optimism.id]: "https://explorer.optimism.io",
  [arbitrum.id]: "https://arbitrum.blockscout.com",
  [base.id]: "https://base.blockscout.com",
  [polygon.id]: "https://polygon.blockscout.com",
  [unichain.id]: "https://unichain.blockscout.com",
  [linea.id]: "https://explorer.linea.build",
};

// Mapping of chain IDs to Zerion chain identifiers
export const chainIdToZerionId: Record<number, string> = {
  [mainnet.id]: "ethereum",
  [optimism.id]: "optimism",
  [arbitrum.id]: "arbitrum",
  [base.id]: "base",
  [polygon.id]: "polygon",
  [unichain.id]: "unichain",
  [linea.id]: "linea",
};

/**
 * Wrapped-native ERC20 address per chain (WETH / WPOL / etc.). Native and
 * wrapped-native are 1:1 redeemable, so for pricing purposes we treat them
 * as the same asset and prefer the wrapped quote — Odos's `0xeeee…eEEE`
 * native sentinel is unreliable on several chains (e.g. it returns a stale
 * ETH price on Optimism that's ~12% off the WETH spot quoted on the same
 * chain).
 *
 * Used by `fetchOdosPrices` to substitute `zeroAddress` requests for the
 * wrapped equivalent. If/when we need this elsewhere it's already a generic
 * piece of chain metadata.
 */
export const wrappedNative: Record<number, Address> = {
  [mainnet.id]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  [optimism.id]: "0x4200000000000000000000000000000000000006",
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  [base.id]: "0x4200000000000000000000000000000000000006",
  [polygon.id]: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  [unichain.id]: "0x4200000000000000000000000000000000000006",
  [linea.id]: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f",
};
