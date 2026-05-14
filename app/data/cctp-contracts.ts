import { arbitrum, base, linea, mainnet, optimism, polygon, unichain } from "viem/chains";

export { USDC as tokenAddresses } from "./token-contracts";

export const tokenMessenger: Record<number, `0x${string}`> = {
  [mainnet.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [optimism.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [arbitrum.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [base.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [polygon.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [unichain.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  [linea.id]: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
};

export const messageTransmitter: Record<number, `0x${string}`> = {
  [mainnet.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [optimism.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [arbitrum.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [base.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [polygon.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [unichain.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  [linea.id]: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
};

export const tokenMinter: Record<number, `0x${string}`> = {
  [mainnet.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [optimism.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [arbitrum.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [base.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [polygon.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [unichain.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
  [linea.id]: "0xfd78EE919681417d192449715b2594ab58f5D002",
};

export const chainIdToDomain: Record<number, number> = {
  [mainnet.id]: 0,
  [optimism.id]: 2,
  [arbitrum.id]: 3,
  [base.id]: 6,
  [polygon.id]: 7,
  [unichain.id]: 10,
  [linea.id]: 11,
};
