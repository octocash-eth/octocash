import { arbitrum, avalanche, base, linea, mainnet, optimism, polygon, unichain } from "viem/chains";

export const tokenAddresses: Record<number, `0x${string}`> = {
  [mainnet.id]: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  [avalanche.id]: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  [optimism.id]: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  [arbitrum.id]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [polygon.id]: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  [unichain.id]: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
  [linea.id]: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
};

export const tokenMessenger: Record<number, `0x${string}`> = {
  [mainnet.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [avalanche.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [optimism.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [arbitrum.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [base.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [polygon.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [unichain.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [linea.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
};

export const messageTransmitter: Record<number, `0x${string}`> = {
  [mainnet.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [avalanche.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [optimism.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [arbitrum.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [base.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [polygon.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [unichain.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [linea.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
};

export const tokenMinter: Record<number, `0x${string}`> = {
  [mainnet.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [avalanche.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [optimism.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [arbitrum.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [base.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [polygon.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [unichain.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [linea.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
};

export const chainIdToDomain: Record<number, number> = {
  [mainnet.id]: 0,
  [avalanche.id]: 1,
  [optimism.id]: 2,
  [arbitrum.id]: 3,
  [base.id]: 6,
  [polygon.id]: 7,
  [unichain.id]: 10,
  [linea.id]: 11,
};
