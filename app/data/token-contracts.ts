import { arbitrum, avalanche, base, linea, mainnet, optimism, polygon, unichain } from "viem/chains";

export const USDC: Record<number, `0x${string}`> = {
  [mainnet.id]: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  [avalanche.id]: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  [optimism.id]: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  [arbitrum.id]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [polygon.id]: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  [unichain.id]: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
  [linea.id]: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
};

export const WBTC: Record<number, `0x${string}`> = {
  [mainnet.id]: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  [avalanche.id]: "0x50B7545627a5162F82A992c33b87aDc75187B218",
  [optimism.id]: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
  [arbitrum.id]: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
  [base.id]: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
  [polygon.id]: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  [unichain.id]: "0x927B51f251480a681271180DA4de28D44EC4AfB8",
  [linea.id]: "0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4",
};

export const ETH: Record<number, `0x${string}`> = {
  [mainnet.id]: "0x0000000000000000000000000000000000000000",
  [avalanche.id]: "0x0000000000000000000000000000000000000000",
  [optimism.id]: "0x0000000000000000000000000000000000000000",
  [arbitrum.id]: "0x0000000000000000000000000000000000000000",
  [base.id]: "0x0000000000000000000000000000000000000000",
  [polygon.id]: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  [unichain.id]: "0x0000000000000000000000000000000000000000",
  [linea.id]: "0x0000000000000000000000000000000000000000",
};

export const POL: Record<number, `0x${string}`> = {
  [polygon.id]: "0x0000000000000000000000000000000000000000",
};
