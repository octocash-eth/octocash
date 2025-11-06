import { http } from "viem";
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
