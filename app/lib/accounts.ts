import type { Address } from "viem";

/**
 * Account-kind model. A "wallet" elsewhere in the app is just an `Address`
 * (see `TokenAmount.walletAddress`); this sidecar map records which of those
 * addresses are Gnosis Safes or ERC-4337 smart accounts, and where each is
 * actually deployed. An address absent from the map is an EOA — the pre-Safe
 * behavior — so every caller that doesn't pass accounts keeps working
 * unchanged.
 */

/**
 * EIP-7702 designation prefix. An EOA that has authorized a delegate has
 * bytecode of the form `0xef0100 || <20-byte delegate address>` (23 bytes
 * total). The account remains an EOA — the original key still controls it and
 * the address is the same on every chain — so it is never classified as a
 * smart account.
 *
 * See https://eips.ethereum.org/EIPS/eip-7702.
 */
export const EIP7702_DELEGATION_PREFIX = "0xef0100";

/** A Safe's verified deployment on one chain, per that chain's Transaction Service. */
export interface SafeChainDeployment {
  chainId: number;
  owners: Address[];
  threshold: number;
  nonce: number;
  version: string; // e.g. "1.4.1"
  /**
   * Whether the connected owner is in `owners` ON THIS CHAIN. Same-address
   * redeployments replay the Safe's original owner set, so a Safe controlled
   * on chain A may be someone else's (or an older configuration) on chain B.
   */
  controlled: boolean;
}

export interface SafeAccount {
  kind: "safe";
  address: Address;
  /** Connected owner EOA through which this Safe was discovered and will be signed. */
  ownerAddress: Address;
  /** Only chains where deployment was verified via the Transaction Service. */
  deployments: Record<number, SafeChainDeployment>;
  fetchedAt: number;
}

/** wallet_getCapabilities atomic status; "unknown" when the wallet doesn't answer. */
export type AtomicStatus = "supported" | "ready" | "unsupported" | "unknown";

/** A smart account's verified deployment on one chain (non-7702 contract code). */
export interface SmartChainDeployment {
  chainId: number;
  /** EIP-5792 atomic-batch capability reported by the wallet for this chain. */
  atomic: AtomicStatus;
}

/**
 * An ERC-4337-style smart wallet CONNECTED AS ITSELF (Coinbase Smart Wallet,
 * ZeroDev Kernel, Biconomy Nexus, …). Unlike a Safe there is no owner EOA to
 * orchestrate through: the wallet app signs synchronously and submits its own
 * UserOperations; the dapp talks to it via EIP-5792 (`wallet_sendCalls`).
 * ERC-7579/6900 modular accounts are transparent at this level.
 */
export interface SmartAccount {
  kind: "smart";
  address: Address;
  /** Only chains where contract code was verified via getCode. */
  deployments: Record<number, SmartChainDeployment>;
  fetchedAt: number;
}

export interface EoaAccount {
  kind: "eoa";
  address: Address;
}

export type WalletAccount = EoaAccount | SafeAccount | SmartAccount;

/** Keyed by lowercase address; an absent address is an EOA (backward compat). */
export type AccountsMap = ReadonlyMap<string, WalletAccount>;

/** Plain-object form of the map, as persisted in `ConsolidationState.accounts`. */
export type AccountsRecord = Record<string, WalletAccount>;

export function toAccountsMap(record: AccountsRecord | undefined): AccountsMap {
  const map = new Map<string, WalletAccount>();
  for (const [address, account] of Object.entries(record ?? {})) {
    map.set(address.toLowerCase(), account);
  }
  return map;
}

export function toAccountsRecord(accounts: AccountsMap): AccountsRecord {
  return Object.fromEntries(accounts);
}

export function accountFor(accounts: AccountsMap | undefined, address: Address): WalletAccount {
  return accounts?.get(address.toLowerCase()) ?? { kind: "eoa", address };
}

export function isSafeAccount(accounts: AccountsMap | undefined, address: Address): boolean {
  return accountFor(accounts, address).kind === "safe";
}

export function isSmartAccount(accounts: AccountsMap | undefined, address: Address): boolean {
  return accountFor(accounts, address).kind === "smart";
}

export function safeDeploymentOn(account: WalletAccount, chainId: number): SafeChainDeployment | undefined {
  return account.kind === "safe" ? account.deployments[chainId] : undefined;
}

/**
 * True when the address can hold/receive funds on `chainId`: EOAs everywhere,
 * Safes and smart accounts only where a deployment was verified — sending to
 * the same address on a chain without code strands the funds.
 */
export function deployedOn(account: WalletAccount, chainId: number): boolean {
  return account.kind === "eoa" || account.deployments[chainId] !== undefined;
}

/**
 * True when transactions of this account can be signed on `chainId`: EOAs
 * everywhere; Safes where the connected owner is in that chain's owner set;
 * smart accounts wherever deployed (the connected session IS the signer).
 */
export function controlledOn(account: WalletAccount, chainId: number): boolean {
  if (account.kind === "eoa") return true;
  if (account.kind === "safe") return account.deployments[chainId]?.controlled === true;
  return account.deployments[chainId] !== undefined;
}

/** True when the wallet reports EIP-5792 atomic batching on `chainId`. */
export function atomicOn(account: WalletAccount, chainId: number): boolean {
  if (account.kind !== "smart") return false;
  const status = account.deployments[chainId]?.atomic;
  return status === "supported" || status === "ready";
}

/**
 * Who signs and pays gas for transactions of `wallet`: the owner EOA for a
 * Safe (execTransaction's msg.sender); the wallet itself for an EOA or a
 * smart account (a 4337 account prefunds its own operations from its native
 * balance — paymasters are the wallet app's business).
 */
export function executorFor(accounts: AccountsMap | undefined, wallet: Address): Address {
  const account = accountFor(accounts, wallet);
  return account.kind === "safe" ? account.ownerAddress : wallet;
}
