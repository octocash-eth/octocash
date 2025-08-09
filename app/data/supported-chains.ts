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
};

export const supportedChains = Object.entries(chains).map(([chainId, chain]) => ({
  id: Number(chainId),
  name: chain.name,
  icon: `/chain-icons/${chain.name.toLowerCase().replace(/\s+/g, "-")}.svg`,
  explorerUrl: chain.blockExplorers.default.url,
  nativeCurrency: chain.nativeCurrency,
}));

export const blockExplorers = {
  [mainnet.id]: 'https://eth.blockscout.com',
  // [avalanche.id]: avalanche.blockExplorers.default,
  [optimism.id]: 'https://explorer.optimism.io',
  [arbitrum.id]: 'https://arbitrum.blockscout.com',
  [base.id]: 'https://base.blockscout.com',
  [polygon.id]: 'https://polygon.blockscout.com',
  [unichain.id]: 'https://unichain.blockscout.com',
  [linea.id]: 'https://explorer.linea.build',
};