import type { Address } from "viem";

/**
 * Account-kind model. A "wallet" elsewhere in the app is just an `Address`
 * (see `TokenAmount.walletAddress`); this sidecar map records which of those
 * addresses are Gnosis Safes and where each Safe is actually deployed. An
 * address absent from the map is an EOA — the pre-Safe behavior — so every
 * caller that doesn't pass accounts keeps working unchanged.
 */

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

export interface EoaAccount {
  kind: "eoa";
  address: Address;
}

export type WalletAccount = EoaAccount | SafeAccount;

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

export function safeDeploymentOn(account: WalletAccount, chainId: number): SafeChainDeployment | undefined {
  return account.kind === "safe" ? account.deployments[chainId] : undefined;
}

/** True when the address is usable on `chainId`: EOAs everywhere, Safes only where deployed. */
export function safeDeployedOn(account: WalletAccount, chainId: number): boolean {
  return account.kind === "eoa" || account.deployments[chainId] !== undefined;
}

/** True when txs of this account can be signed on `chainId` by the connected owner. */
export function safeControlledOn(account: WalletAccount, chainId: number): boolean {
  return account.kind === "eoa" || account.deployments[chainId]?.controlled === true;
}

/**
 * Who signs and pays gas for transactions of `wallet`: the owner EOA for a
 * Safe (execTransaction's msg.sender), the wallet itself for an EOA.
 */
export function executorFor(accounts: AccountsMap | undefined, wallet: Address): Address {
  const account = accountFor(accounts, wallet);
  return account.kind === "safe" ? account.ownerAddress : wallet;
}
