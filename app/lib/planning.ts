import { type Address, formatUnits, getAddress, isAddressEqual, zeroAddress } from "viem";
import { gnosis, mainnet } from "viem/chains";
import { RAILGUN_SUPPORTED_CHAINS } from "~/data/railgun";
import { chains, transports } from "~/data/supported-chains";
import { USDC as USDC_ADDRESSES } from "~/data/token-contracts";
import { type AccountsMap, accountFor, executorFor, isSafeAccount, safeControlledOn } from "./accounts";
import { deloraPriceKey, fetchDeloraPrices } from "./api/delora";
import { getBridgeFee } from "./cctp";
import { type DeloraSwapLeg, getSwapQuoteWithLegs } from "./delora";
import { getNativeBalance } from "./gas";
import {
  attachGasEstimates,
  buildBridgeSimOps,
  buildGasContext,
  buildOmnibridgeSimOps,
  buildSwapLegSimOps,
  emptyPlanArtifacts,
  estimateChainGasCosts,
  estimateDestinationChainOperations,
  formatGasCostNative,
  type GasContext,
  measureOpsGas,
  type OperationType,
  type PlanArtifacts,
  type SimOp,
} from "./gas-estimation";
import { getGasRefuelQuote } from "./gas-refuel";
import { getOmnibridgeMinPerTx, type OmnibridgeTokenPair, resolveOmnibridgeTokenPair } from "./omnibridge";
import { getPublicClient } from "./public-client";
import { decodeRailgunAddress, getShieldedAmountAfterFee, isRailgunAddress } from "./railgun";
import { groupTokensByChainAndWallet } from "./tokens";
import type { DestinationToken, TokenAmount, TransactionStep } from "./types";

const SUPPORTED_CHAINS = Object.keys(chains).map(Number);

/**
 * Per-(chain, wallet) deficit of native gas. Collected during planning instead of
 * throwing, so a `gas-topup` step can be prepended to refuel the wallet from
 * another source (Gas.zip/Delora refuel or same-chain native transfer).
 */
type GasGap = { chainId: number; walletAddress: Address; deficitWei: bigint };
type GasGaps = Map<string, GasGap>;

/**
 * Native balances observed while drafting, keyed by {@link gapKey}. Reused by
 * {@link reconcileGasGaps} so the post-drafting reconciliation doesn't refetch
 * what the capping checks already paid for.
 */
type NativeBalances = Map<string, bigint>;

function gapKey(chainId: number, walletAddress: Address): string {
  return `${chainId}:${getAddress(walletAddress)}`;
}

/**
 * Records a gas deficit. If the same (chain, wallet) already has a recorded gap,
 * the larger of the two is kept so the eventual top-up covers all paths.
 */
function recordGasGap(gaps: GasGaps, chainId: number, walletAddress: Address, deficitWei: bigint): void {
  if (deficitWei <= 0n) return;
  const key = gapKey(chainId, walletAddress);
  const existing = gaps.get(key);
  const normalized = getAddress(walletAddress) as Address;
  if (existing) {
    if (deficitWei > existing.deficitWei) existing.deficitWei = deficitWei;
    return;
  }
  gaps.set(key, { chainId, walletAddress: normalized, deficitWei });
}

/**
 * Fetches (and caches) a wallet's native balance on a chain.
 */
async function getCachedNativeBalance(balances: NativeBalances, chainId: number, wallet: Address): Promise<bigint> {
  const key = gapKey(chainId, wallet);
  const cached = balances.get(key);
  if (cached !== undefined) return cached;
  const chain = chains[chainId as keyof typeof chains];
  const balance = await getNativeBalance(chain, wallet, transports?.[chainId as keyof typeof transports]);
  balances.set(key, balance);
  return balance;
}

/**
 * Computes the final gas gaps from the drafted plan's *measured* per-step
 * estimates, superseding the budget-based deficits sketched while drafting.
 *
 * For each (chain, executing wallet): required = Σ `estimatedGas.gasCostWei`
 * over the wallet's steps + the native it spends from its pre-existing balance
 * (native inputs without provenance — provenance-tagged native arrived from an
 * earlier in-plan step and doesn't draw the balance down). A wallet whose
 * balance covers that is not a gap, even if the budget math said otherwise;
 * a wallet whose measured cost exceeds the budget gets the bigger top-up it
 * actually needs. Must run after {@link attachGasEstimates} and before
 * {@link createGasTopUpSteps}.
 */
async function reconcileGasGaps(
  steps: TransactionStep[],
  balances: NativeBalances,
  log: (...args: unknown[]) => void,
  accounts?: AccountsMap,
): Promise<GasGaps> {
  const gaps: GasGaps = new Map();
  // Gas is charged to whoever SIGNS the step: the wallet itself for EOAs, the
  // owner EOA for Safe steps (execTransaction's msg.sender pays). Native
  // *value* always comes from the step wallet's own balance, so for Safe
  // steps the two are tracked under different keys.
  const groups = new Map<string, { chainId: number; wallet: Address; gasWei: bigint; nativeSpendWei: bigint }>();

  const groupFor = (chainId: number, wallet: Address) => {
    const key = gapKey(chainId, wallet);
    let group = groups.get(key);
    if (!group) {
      group = { chainId, wallet: getAddress(wallet) as Address, gasWei: 0n, nativeSpendWei: 0n };
      groups.set(key, group);
    }
    return group;
  };

  for (const step of steps) {
    if (
      step.type === "attestation" ||
      step.type === "gas-topup" ||
      step.type === "gas-topup-wait" ||
      step.type === "gnosis-wait"
    )
      continue;
    const wallet = step.inputTokens[0]?.walletAddress;
    if (!wallet) continue;
    const gasPayer = executorFor(accounts, wallet);
    groupFor(step.chainId, gasPayer).gasWei += step.estimatedGas?.gasCostWei ?? 0n;
    for (const input of step.inputTokens) {
      if (
        isAddressEqual(input.token, zeroAddress) &&
        input.provenance === undefined &&
        isAddressEqual(input.walletAddress, wallet)
      ) {
        groupFor(step.chainId, wallet).nativeSpendWei += input.amount;
      }
    }
  }

  for (const group of groups.values()) {
    const balance = await getCachedNativeBalance(balances, group.chainId, group.wallet);
    const required = group.gasWei + group.nativeSpendWei;
    if (balance >= required) continue;

    if (isSafeAccount(accounts, group.wallet)) {
      // A Safe's shortfall can only be native VALUE (its gas is charged to
      // the owner EOA above), and Safes aren't refuelable by gas-topup steps
      // (their native can't be sent with a quick EOA transfer) — hard error.
      const chainName = chains[group.chainId as keyof typeof chains]?.name ?? `chain ${group.chainId}`;
      throw new Error(
        `PlanningError: Safe ${group.wallet} holds ${formatGasCostNative(balance)} native on ${chainName} but the ` +
          `plan spends ${formatGasCostNative(group.nativeSpendWei)}. Reduce the selected native amount.`,
      );
    }

    recordGasGap(gaps, group.chainId, group.wallet, required - balance);
    log(
      `🔍 [DEBUG] Reconciled gas gap on chain ${group.chainId} for ${group.wallet}: balance=${balance.toString()}, gas=${group.gasWei.toString()}, nativeSpend=${group.nativeSpendWei.toString()}, deficit=${(required - balance).toString()}`,
    );
  }

  return gaps;
}

/**
 * Assumed worst-case cross-chain top-up overhead (refuel fee + relayer +
 * slippage), as a fraction of the delivered amount, in basis points. Native
 * bridges (Across-style) typically run ~0.1–1%; 1.5% is a conservative
 * catch-all. Used ONLY to gate dust top-ups — not to size the recorded deficit
 * — so we don't request a cross-chain refuel to move an amount the fees would
 * eat. Same-chain refuels have ~no overhead, so this slightly over-rejects gaps
 * that end up funded same-chain, an acceptable bias for a dust guard.
 */
const ASSUMED_TOPUP_OVERHEAD_BPS = 150n;

/**
 * Minimum native amount worth topping up for: the operation gas plus the assumed
 * refuel overhead on the whole deficit it would take to deliver it. At or below
 * this, a cross-chain top-up costs more than the amount it would rescue, so the
 * caller refuses (sole dust) or drops the dust native (other value present).
 */
function dustTopUpThreshold(amount: bigint, gasCost: bigint, balance: bigint): bigint {
  const deficit = amount + gasCost - balance;
  const assumedOverhead = deficit > 0n ? (deficit * ASSUMED_TOPUP_OVERHEAD_BPS) / 10_000n : 0n;
  return gasCost + assumedOverhead;
}

/**
 * Refuses to plan when the user selected a native amount on a wallet that can't
 * cover its own gas AND that amount is no larger than the gas needed to move it.
 *
 * Recording a gas gap here would prepend a `gas-topup` step that bridges native
 * in from another wallet — costing extra gas plus a refuel fee — just to
 * consolidate an amount worth less than those fees. That's a guaranteed net
 * loss, so we surface an actionable error instead (mirrors the pre-top-up
 * behavior the user already knew). Only used when the dust native is the sole
 * asset on that wallet; if other value is present the caller drops the dust
 * native and tops up for the rest.
 */
function throwNativeAmountTooSmall(chainId: number, walletAddress: Address, amount: bigint, gasCost: bigint): never {
  const chain = chains[chainId as keyof typeof chains];
  const chainName = chain?.name ?? `chain ${chainId}`;
  const symbol = chain?.nativeCurrency?.symbol ?? "ETH";
  throw new Error(
    `The ${symbol} amount selected on ${chainName} from ${walletAddress} ` +
      `(~${formatGasCostNative(amount)} ${symbol}) is smaller than the gas needed to move it ` +
      `(~${formatGasCostNative(gasCost)} ${symbol}). Topping up gas to consolidate it would cost ` +
      `more than it's worth. Deselect ${symbol}, increase its amount, or add more ${symbol} to the wallet.`,
  );
}

/** Absolute floor for value routed through the Gnosis<->mainnet hop: $10. */
export const GNOSIS_ROUTE_MIN_USD = 10;

/**
 * The mainnet hop's gas must not exceed 1/N of the routed value (N = 5 ⇒ 20%).
 * Together with the absolute floor this keeps Gnosis routes from spending more
 * on Ethereum gas than the dust they rescue is worth.
 */
const GNOSIS_HOP_MAX_GAS_SHARE = 5;

/** One bridged flavor of a Gnosis route, for the value-floor check. */
type RoutedValue = { token: Address; chainId: number; decimals: number; amount: bigint };

/**
 * Rejects a Gnosis route whose mainnet hop (Omnibridge claim and/or CCTP leg)
 * would eat too much of the routed value. Runs where the route's real bridged
 * totals are known — inside the egress/ingress step creators — and is a hard
 * reject, consistent with the dust policy elsewhere in planning.
 *
 * `routed` lists each bridged flavor: USDC on the fallback route, the
 * destination token's bridge twin on the direct route, or both in a mixed
 * ingress. USDC counts $1 per unit outright; other tokens use the Delora
 * spot price, and when any price is unavailable the check is skipped (a
 * transient price outage must not fail an otherwise valid plan). When only
 * the ETH price is unavailable the absolute $10 floor still applies.
 */
async function assertGnosisRouteWorthIt(
  routed: RoutedValue[],
  hopOps: OperationType[],
  gasCtx: GasContext,
  direction: "from" | "to",
  log: (...args: unknown[]) => void,
): Promise<void> {
  const isUsdc = (entry: RoutedValue) =>
    isAddressEqual(
      entry.token,
      (USDC_ADDRESSES[entry.chainId as keyof typeof USDC_ADDRESSES] as Address | undefined) ?? zeroAddress,
    );
  const needsPrice = routed.filter((entry) => !isUsdc(entry));
  let totalUsd: number | null = null;

  let minUsd = GNOSIS_ROUTE_MIN_USD;
  let hopGasUsd = 0;
  try {
    const pricePairs: { chainId: number; token: Address }[] = [
      { chainId: mainnet.id, token: zeroAddress },
      ...needsPrice.map((entry) => ({ chainId: entry.chainId, token: entry.token })),
    ];
    const priceMap = await fetchDeloraPrices(pricePairs);

    totalUsd = 0;
    for (const entry of routed) {
      const price = isUsdc(entry) ? 1 : priceMap.get(deloraPriceKey(entry.chainId, entry.token));
      if (price === undefined) {
        log(`⚠️ [DEBUG] No price for routed token ${entry.token}; skipping the Gnosis route value floor`);
        totalUsd = null;
        break;
      }
      totalUsd += price * Number(formatUnits(entry.amount, entry.decimals));
    }

    const hopGas = await estimateChainGasCosts(mainnet.id, hopOps, gasCtx.maxFeePerGas[mainnet.id]);
    const ethUsd = priceMap.get(deloraPriceKey(mainnet.id, zeroAddress)) ?? 0;
    hopGasUsd = ethUsd * Number(formatUnits(hopGas.totalGasCost, 18));
    const gasFloorUsd = hopGasUsd * GNOSIS_HOP_MAX_GAS_SHARE;
    if (gasFloorUsd > minUsd) minUsd = gasFloorUsd;
  } catch (error) {
    log(`⚠️ [DEBUG] Gnosis route pricing/gas floor unavailable, using what's known: ${String(error)}`);
    if (totalUsd === null) {
      // The price fetch itself failed. All-USDC routes are $1/unit without a
      // price, so the absolute floor still applies; otherwise skip the check.
      if (needsPrice.length > 0) return;
      totalUsd = routed.reduce((sum, entry) => sum + Number(formatUnits(entry.amount, entry.decimals)), 0);
    }
  }

  if (totalUsd === null) return;

  if (totalUsd < minUsd) {
    const gasNote = hopGasUsd > 0 ? ` costing ~$${hopGasUsd.toFixed(2)} in gas` : "";
    throw new Error(
      `PlanningError: Consolidating $${totalUsd.toFixed(2)} ${direction === "from" ? "from" : "to"} Gnosis requires an ` +
        `Ethereum mainnet hop${gasNote}, which isn't worth it below ~$${minUsd.toFixed(2)}. ` +
        `Add more value or ${direction === "from" ? "deselect the Gnosis tokens" : "choose a different destination chain"}.`,
    );
  }
}

/**
 * A resolved direct token<->token Omnibridge route: the destination token is
 * itself registered on the bridge, so the sending side swaps everything into
 * its twin and bridges it 1:1 instead of routing value through USDC (e.g.
 * DAI + USDC + GNO -swap-> GNO -bridge-> GNO). Omnibridge twins share
 * decimals (the bridged deployment copies the native token's), so one
 * symbol/decimals pair describes both sides.
 */
type GnosisDirectRoute = {
  pair: OmnibridgeTokenPair;
  symbol: string;
  decimals: number;
};

/**
 * Enforces the sending mediator's per-transaction minimum on every wallet's
 * bridged amount for a direct route — `relayTokens` reverts below it. The
 * fallback USDC route keeps its historical behavior (the legacy USDC minimum
 * is far under the $10 route floor).
 */
async function assertOmnibridgeMinPerTx(
  direction: "egress" | "ingress",
  token: Address,
  route: GnosisDirectRoute,
  walletAmounts: { walletAddress: Address; amount: bigint }[],
): Promise<void> {
  const min = await getOmnibridgeMinPerTx(direction, token);
  const below = walletAmounts.find((w) => w.amount < min);
  if (below) {
    throw new Error(
      `PlanningError: The ${route.symbol} amount from ${below.walletAddress} ` +
        `(${formatUnits(below.amount, route.decimals)} ${route.symbol}) is below the Omnibridge minimum of ` +
        `${formatUnits(min, route.decimals)} ${route.symbol} per transaction. Add more value from that wallet.`,
    );
  }
}

/**
 * EIP-7702 designation prefix. An EOA that has authorized a delegate has
 * bytecode of the form `0xef0100 || <20-byte delegate address>` (23 bytes
 * total). The account remains an EOA — the original key still controls it
 * and the address is the same on every chain — so for our planning purposes
 * (CCTP mintRecipient, intermediate-wallet candidate, signing) it should be
 * treated like a plain EOA, not a smart-account wallet.
 *
 * See https://eips.ethereum.org/EIPS/eip-7702.
 */
const EIP7702_DELEGATION_PREFIX = "0xef0100";

/**
 * Wallets sign on their source chain and (since the same address is the
 * default CCTP mintRecipient and the intermediate-wallet candidate pool) need
 * to be reachable everywhere they're used. EOAs are the same address on every
 * chain; a registered Safe is usable only on chains where discovery verified a
 * deployment controlled by the connected owner. Unregistered contract
 * addresses are rejected — bridging to them risks stranded funds. The
 * destination wallet only needs this check when it's itself a connected
 * wallet (intermediate-wallet candidate); an arbitrary destination address
 * can be a contract and just receive ERC20.
 *
 * EIP-7702-delegated EOAs report non-empty bytecode but are still EOAs (same
 * address on every chain, signable by the original key), so we recognize the
 * `0xef0100` designation prefix and let them through.
 */
async function assertAccountsUsable(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[],
  accounts: AccountsMap | undefined,
): Promise<void> {
  const pairs = new Map<string, { address: Address; chainId: number }>();
  for (const t of sourceTokens) {
    pairs.set(`${t.chainId}:${t.walletAddress.toLowerCase()}`, { address: t.walletAddress, chainId: t.chainId });
  }
  const destinationIsConnected = connectedWallets.some((w) => isAddressEqual(w, destinationToken.walletAddress));
  if (destinationIsConnected) {
    pairs.set(`${destinationToken.chainId}:${destinationToken.walletAddress.toLowerCase()}`, {
      address: destinationToken.walletAddress,
      chainId: destinationToken.chainId,
    });
  }

  await Promise.all(
    Array.from(pairs.values()).map(({ address, chainId }) => assertAccountUsableOnChain(address, chainId, accounts)),
  );
}

/**
 * Throws when `address` is not usable on `chainId`: an unregistered
 * (non-EIP-7702) contract, or a registered Safe without a controlled, verified
 * deployment there. Registered Safes additionally get a `getCode` freshness
 * check — a stale discovery snapshot must never route funds to an address
 * with no contract behind it. Also used standalone for the intermediate
 * wallet on mainnet when a plan routes through the Gnosis<->mainnet
 * Omnibridge hop — the hop's claim/burn steps execute on mainnet, a chain the
 * source/destination sweep may not otherwise cover.
 */
async function assertAccountUsableOnChain(
  address: Address,
  chainId: number,
  accounts: AccountsMap | undefined,
): Promise<void> {
  const chainName = chains[chainId as keyof typeof chains]?.name ?? `chain ${chainId}`;
  const account = accountFor(accounts, address);

  if (account.kind === "safe") {
    if (!safeControlledOn(account, chainId)) {
      throw new Error(
        `SafeNotDeployedError: Safe ${address} has no deployment controlled by your connected owner on ${chainName}.`,
      );
    }
    const code = await getPublicClient(chainId).getCode({ address });
    if (code === undefined || code === "0x") {
      throw new Error(
        `SafeNotDeployedError: Safe ${address} has no contract code on ${chainName} — refusing to route funds there.`,
      );
    }
    return;
  }

  const code = await getPublicClient(chainId).getCode({ address });
  const hasCode = code !== undefined && code !== "0x";
  const is7702 = hasCode && code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX);
  if (hasCode && !is7702) {
    throw new Error(
      `PlanningError: Smart-account wallets are not supported. ${address} is a contract on ${chainName}. ` +
        `If this is a Gnosis Safe, connect one of its owners and enable it from the Safe accounts panel.`,
    );
  }
}

/** Max source tokens accepted by a single consolidation plan. */
export const MAX_SOURCE_TOKENS = 50;

/**
 * Finds a suitable intermediate wallet in case the destination wallet is not connected
 * It ensures the wallet has sufficient gas to execute the claim and transfer steps
 *
 * @param sourceTokens - Array of source tokens
 * @param destinationToken - Destination token
 * @param connectedWallets - Array of connected wallets
 * @returns The intermediate wallet address
 */
/**
 * Predicts the destination-chain ops a specific candidate intermediate wallet
 * would execute. The shape depends on whether the candidate is the destination
 * wallet (no final transfer) and on which source tokens it holds on the dest
 * chain (those participate in the same final swap as bridged USDC).
 */
function predictIntermediateDestinationOps(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  candidate: Address,
  isCandidateDestination: boolean,
  isRailgun = false,
): OperationType[] {
  const destChainId = destinationToken.chainId;
  const destChainUsdc = USDC_ADDRESSES[destChainId as keyof typeof USDC_ADDRESSES] as Address | undefined;
  const destIsNative = isAddressEqual(destinationToken.token, zeroAddress);
  // When the destination is Gnosis the CCTP claim runs on the mainnet hub, not
  // on the destination chain, so it doesn't count toward dest-chain ops.
  const hasBridges = destChainId !== gnosis.id && sourceTokens.some((t) => t.chainId !== destChainId);

  const candidateDestSources = sourceTokens.filter(
    (t) => t.chainId === destChainId && isAddressEqual(t.walletAddress, candidate),
  );
  const candidateNonMatching = candidateDestSources.filter((t) => !isAddressEqual(t.token, destinationToken.token));

  const bridgedUsdcNeedsSwap = hasBridges && !!destChainUsdc && !isAddressEqual(destinationToken.token, destChainUsdc);
  const nonNativeFromSources = candidateNonMatching.filter((t) => !isAddressEqual(t.token, zeroAddress)).length;
  const nonNativeSwapTokenCount = nonNativeFromSources + (bridgedUsdcNeedsSwap ? 1 : 0);
  const hasNativeInFinalSwap = candidateNonMatching.some((t) => isAddressEqual(t.token, zeroAddress));

  return estimateDestinationChainOperations(
    hasBridges,
    nonNativeSwapTokenCount,
    hasNativeInFinalSwap,
    // Railgun destinations never end with a public transfer — the candidate
    // itself performs the final shield (approve + shield ops below).
    !isCandidateDestination && !isRailgun,
    destIsNative,
    isRailgun,
  );
}

async function resolveIntermediateWallet(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[],
  gasCtx: GasContext,
  balances: NativeBalances,
  isRailgun = false,
  accounts?: AccountsMap,
  safeMode = false,
): Promise<Address> {
  const destinationWallet = destinationToken.walletAddress;
  const destChainId = destinationToken.chainId;
  const chain = chains[destChainId as keyof typeof chains];
  const chainName = chain?.name ?? `chain ${destChainId}`;

  // Safe mode (every source is Safe-held): funds must never be custodied by
  // an EOA, not even transiently — the intermediate can ONLY be a Safe. The
  // owner EOA still signs and submits (execTransaction, permissionless
  // claims), but mint recipients, hub balances, and final swaps all live on a
  // Safe; an EOA destination receives exactly one final transfer at the end.
  if (safeMode) {
    const destinationAccount = accountFor(accounts, destinationWallet);
    if (!isRailgun && destinationAccount.kind === "safe" && safeControlledOn(destinationAccount, destChainId)) {
      await getCachedNativeBalance(balances, destChainId, destinationWallet);
      return destinationWallet;
    }
    const sourceSafe = [...new Set(sourceTokens.map((token) => token.walletAddress))].find((wallet) =>
      safeControlledOn(accountFor(accounts, wallet), destChainId),
    );
    if (sourceSafe) {
      await getCachedNativeBalance(balances, destChainId, sourceSafe);
      return sourceSafe;
    }
    throw new Error(
      `PlanningError: None of your Safes is deployed on ${chainName}, so Safe-held funds cannot be safely ` +
        `received there. Pick a destination chain where a source Safe (or a Safe destination) is deployed.`,
    );
  }

  // A Railgun destination has no public destination wallet (the UI passes a
  // zero-address placeholder), so a connected wallet is always chosen below.
  const isDestinationConnected =
    !isRailgun && connectedWallets.some((wallet) => isAddressEqual(wallet, destinationWallet));

  if (isDestinationConnected) {
    // Even if the destination wallet can't cover its own dest-chain gas it is
    // still the intermediate; `reconcileGasGaps` sizes the top-up afterwards
    // from the drafted steps' measured estimates. A controlled Safe
    // destination qualifies too (assertAccountsUsable verified its deployment
    // on the destination chain): the bridge mints straight into it and the
    // final swap becomes one batched Safe transaction.
    await getCachedNativeBalance(balances, destChainId, destinationWallet);
    return destinationWallet;
  }

  // EOA mode: Safes are never intermediate candidates — sources are all
  // EOA-held here, and an intermediate exists precisely to be a cheap
  // same-address relay (a Safe would cost an N-of-M round per hop).
  const searchOrder = [...new Set([...sourceTokens.map((token) => token.walletAddress), ...connectedWallets])].filter(
    (wallet) => !isSafeAccount(accounts, wallet),
  );

  // Find first wallet whose destination-chain balance covers its predicted ops
  // (each candidate may need a different op shape — e.g. one holds extra
  // dest-chain source tokens that increase the final-swap batch). The shape
  // check runs on conservative budgets — the steps don't exist yet — so it
  // biases toward candidates that need no top-up at all.
  for (const wallet of searchOrder) {
    const destOps = predictIntermediateDestinationOps(sourceTokens, destinationToken, wallet, false, isRailgun);
    const destGas = await estimateChainGasCosts(destChainId, destOps, gasCtx.maxFeePerGas[destChainId]);
    const balance = await getCachedNativeBalance(balances, destChainId, wallet);
    if (balance >= destGas.totalGasCost) {
      return wallet;
    }
  }

  // No connected wallet has enough — pick the first one; reconcileGasGaps
  // records its measured deficit once the plan is drafted.
  if (searchOrder.length > 0) {
    return searchOrder[0];
  }

  throw new Error(
    `PlanningError: Destination wallet ${destinationWallet} is not connected and no connected wallet found for ${chainName}`,
  );
}

/**
 * Validates that all input parameters meet the requirements for planning
 *
 * Checks include:
 * - Source tokens array is not empty and contains no more than 50 tokens
 * - All token amounts are greater than 0
 * - All chains (source and destination) are supported
 *
 * @param sourceTokens - Array of tokens to consolidate
 * @param destinationToken - Target token and chain for consolidation
 * @param log - Logging function for debug output
 *
 * @throws {Error} PlanningError if validation fails
 * @throws {Error} UnsupportedRouteError if chain is not supported
 */
function validateInputs(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[],
  log: (...args: unknown[]) => void,
): void {
  log("🔍 [DEBUG] planConsolidation called with:", {
    sourceTokensCount: sourceTokens.length,
    sourceTokens: sourceTokens.map((t) => ({
      chainId: t.chainId,
      token: t.token,
      symbol: t.symbol,
      amount: t.amount.toString(),
      walletAddress: t.walletAddress,
    })),
    destinationToken: {
      chainId: destinationToken.chainId,
      token: destinationToken.token,
      symbol: destinationToken.symbol,
      walletAddress: destinationToken.walletAddress,
    },
  });

  if (!sourceTokens || sourceTokens.length === 0) {
    throw new Error("PlanningError: Source tokens cannot be empty");
  }

  if (sourceTokens.length > MAX_SOURCE_TOKENS) {
    throw new Error(`PlanningError: Too many source tokens (max ${MAX_SOURCE_TOKENS})`);
  }

  for (const token of sourceTokens) {
    if (token.amount <= 0n) {
      throw new Error(`PlanningError: Token amount must be greater than 0`);
    }
    if (!SUPPORTED_CHAINS.includes(token.chainId)) {
      throw new Error(`UnsupportedRouteError: Chain ${token.chainId} is not supported`);
    }
  }

  if (!SUPPORTED_CHAINS.includes(destinationToken.chainId)) {
    throw new Error(`UnsupportedRouteError: Destination chain ${destinationToken.chainId} is not supported`);
  }

  if (destinationToken.railgunAddress !== undefined) {
    if (!isRailgunAddress(destinationToken.railgunAddress)) {
      throw new Error("PlanningError: Invalid Railgun (0zk) destination address");
    }
    if (!RAILGUN_SUPPORTED_CHAINS.includes(destinationToken.chainId)) {
      throw new Error(
        `UnsupportedRouteError: Railgun is not deployed on chain ${destinationToken.chainId}. Supported chains: Ethereum, Polygon, Arbitrum.`,
      );
    }
    if (isAddressEqual(destinationToken.token, zeroAddress)) {
      throw new Error(
        "PlanningError: Native coins cannot be shielded into Railgun. Choose an ERC20 destination token (e.g. WETH).",
      );
    }
    const decoded = decodeRailgunAddress(destinationToken.railgunAddress);
    if (decoded.chainId !== undefined && decoded.chainId !== destinationToken.chainId) {
      throw new Error(
        `PlanningError: The Railgun address is bound to chain ${decoded.chainId} but the destination chain is ${destinationToken.chainId}`,
      );
    }
  }

  const missingSourceWallet = sourceTokens.find(
    (token) => !connectedWallets.some((wallet) => isAddressEqual(wallet, token.walletAddress)),
  );

  if (missingSourceWallet) {
    throw new Error(
      `PlanningError: Source wallet ${missingSourceWallet.walletAddress} is not among the connected wallets`,
    );
  }
}

/**
 * One quoted same-address swap group awaiting step creation: the inputs it
 * consumes, the summed quote output (no provenance yet), and the retained
 * Delora legs for gas simulation.
 */
interface QuotedSwapGroup {
  group: TokenAmount[];
  output: TokenAmount;
  legs: DeloraSwapLeg[];
}

/**
 * Quotes a list of tokens toward `targetToken`, one Delora request per
 * on-chain token address (Delora quotes are single-input). A group can
 * contain multiple `TokenAmount`s for the same address (different
 * `provenance`, e.g. the user's pre-existing USDC plus a CCTP claim output) —
 * those legitimately share a quote. A token that Delora can't route to
 * `targetToken` is skipped (and logged) so the rest of the wallet can still
 * be consolidated; any other failure propagates so the plan fails loudly.
 *
 * Quoting is separated from step creation so planning can MEASURE the gas of
 * the quoted calls (via `eth_simulateV1`) and cap/drop native inputs before
 * committing the steps.
 */
async function fetchSwapQuoteGroups(
  tokensToSwap: TokenAmount[],
  targetToken: Omit<TokenAmount, "amount">,
  log: (...args: unknown[]) => void,
): Promise<QuotedSwapGroup[]> {
  const quoted: QuotedSwapGroup[] = [];
  if (tokensToSwap.length === 0) return quoted;

  // Group same-address entries (EIP-55 normalised) into a single quote/step.
  const groups = new Map<Address, TokenAmount[]>();
  for (const token of tokensToSwap) {
    const key = getAddress(token.token);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [token]);
    } else {
      group.push(token);
    }
  }

  for (const group of groups.values()) {
    try {
      const { output, legs } = await getSwapQuoteWithLegs(group, targetToken);
      quoted.push({ group, output, legs });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "quote failed";
      if (isUnroutableTokenError(error)) {
        log(
          `⚠️ [DEBUG] Skipping unroutable token ${group[0].symbol ?? group[0].token} -> ${targetToken.symbol}: ${reason}`,
        );
        continue;
      }
      throw error;
    }
  }

  return quoted;
}

/**
 * Turns quoted swap groups into swap steps, retaining each step's Delora legs
 * in {@link PlanArtifacts} so `attachGasEstimates` can batch-simulate the
 * approval + verbatim quote calldata.
 *
 * @returns Output tokens (provenance-tagged) of the created steps
 */
function createSwapStepsFromQuotes(
  quoted: QuotedSwapGroup[],
  steps: TransactionStep[],
  artifacts: PlanArtifacts,
  log: (...args: unknown[]) => void,
): TokenAmount[] {
  const outputTokens: TokenAmount[] = [];

  for (const { group, output, legs } of quoted) {
    const stepId = `step-${steps.length + 1}`;

    const outputTokenWithProvenance = {
      ...output,
      provenance: stepId, // Mark this token as coming from this swap step
    };

    steps.push({
      id: stepId,
      type: "swap",
      status: "pending",
      chainId: output.chainId,
      inputTokens: group as [TokenAmount, ...TokenAmount[]],
      outputToken: outputTokenWithProvenance,
      quotedAt: Date.now(),
    });
    artifacts.swapLegs.set(stepId, legs);

    outputTokens.push(outputTokenWithProvenance);

    log(`🔍 [DEBUG] Added swap step ${stepId} for ${group[0].symbol ?? group[0].token} -> ${output.symbol}`);
  }

  return outputTokens;
}

/**
 * Applies the measured-gas native capping policy to a wallet's quoted swap
 * groups, mutating `quoted` in place:
 * - balance covers gas: cap the native input to `balance − measuredGas` when
 *   the selected amount would eat into the reserve, re-quoting that single
 *   leg once (gas units for the same route are amount-insensitive, so the
 *   measured cost is NOT re-simulated — the unit buffer absorbs the delta).
 * - balance can't cover gas: refuse when the native is worthless dust and the
 *   wallet's only value ({@link throwNativeAmountTooSmall}); drop the dust
 *   when other value is present; keep the user's full amount otherwise —
 *   `reconcileGasGaps` sizes the top-up from the drafted steps.
 *
 * @returns The native `TokenAmount` the plan should consume, or null when the
 *   wallet has no native input among the quoted groups (or it was dropped)
 */
async function capNativeQuoteForGas(
  quoted: QuotedSwapGroup[],
  targetToken: Omit<TokenAmount, "amount">,
  measuredGasWei: bigint,
  nativeBalance: bigint,
  hasOtherValue: boolean,
  log: (...args: unknown[]) => void,
): Promise<TokenAmount | null> {
  const nativeIdx = quoted.findIndex((q) => q.group.some((t) => isAddressEqual(t.token, zeroAddress)));
  if (nativeIdx < 0) return null;

  const entry = quoted[nativeIdx];
  const nativeToken = entry.group.find((t) => isAddressEqual(t.token, zeroAddress)) as TokenAmount;
  const chainId = nativeToken.chainId;
  const walletAddress = nativeToken.walletAddress;
  const maxAffordable = nativeBalance > measuredGasWei ? nativeBalance - measuredGasWei : 0n;

  if (maxAffordable <= 0n) {
    // Wallet can't even cover gas.
    if (nativeToken.amount <= dustTopUpThreshold(nativeToken.amount, measuredGasWei, nativeBalance)) {
      if (!hasOtherValue) {
        // Dust native is the only thing on this wallet — refuse instead of
        // topping up gas to consolidate something worth less than the fees.
        throwNativeAmountTooSmall(chainId, walletAddress, nativeToken.amount, measuredGasWei);
      }
      // Other value is present. Drop the dust native from the swap;
      // reconcileGasGaps sizes the top-up for what remains.
      log(
        `🔍 [DEBUG] Dropping dust native on chain ${chainId} for ${walletAddress}: amount=${nativeToken.amount.toString()} <= gasCost=${measuredGasWei.toString()}`,
      );
      quoted.splice(nativeIdx, 1);
      return null;
    }
    // The native amount exceeds the gas to move it — keep the user's selected
    // amount; reconcileGasGaps records the deficit (amount + gas − balance).
    return nativeToken;
  }

  if (nativeToken.amount <= maxAffordable) return nativeToken;

  // Gas eats into the selected amount: cap and re-quote this single leg.
  log(
    `🔍 [DEBUG] Adjusting native token on chain ${chainId}: selected=${nativeToken.amount.toString()}, maxAffordable=${maxAffordable.toString()}, gasCost=${measuredGasWei.toString()}`,
  );
  const cappedToken = { ...nativeToken, amount: maxAffordable };
  try {
    const { output, legs } = await getSwapQuoteWithLegs([cappedToken], targetToken);
    quoted[nativeIdx] = { group: [cappedToken], output, legs };
    return cappedToken;
  } catch (error) {
    if (isUnroutableTokenError(error)) {
      // The capped amount no longer routes (e.g. below Delora's minimum) —
      // treat like dust and drop it.
      log(`⚠️ [DEBUG] Capped native amount unroutable on chain ${chainId}; dropping native from the swap`);
      quoted.splice(nativeIdx, 1);
      return null;
    }
    throw error;
  }
}

/**
 * Whether a Delora quote error means the token genuinely has no route to the
 * target, as opposed to a transient/server failure. Only the former is safe
 * to skip; the latter must propagate.
 *
 * Delora reports "no route" as HTTP 500 with `code: "UNKNOWN"` and message
 * "No adapters available for this request" (verified live), so the HTTP
 * status can't discriminate — we match on the message/code text embedded in
 * the error instead. `NO_AVAILABLE_QUOTES` is the documented code for the
 * same condition. If Delora ever rewords these, unroutable tokens will fail
 * plans loudly instead of being silently dropped — the safe direction.
 */
function isUnroutableTokenError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("no adapters available") || msg.includes("no_available_quotes");
}

/**
 * Creates swap and transfer steps to consolidate tokens to a target token at a target wallet
 *
 * This function handles the complete logic of converting and moving tokens:
 * 1. Swaps tokens with different addresses to the target token
 * 2. Creates transfer steps for tokens already at target token but wrong wallet
 * 3. Keeps tokens already at target token and target wallet (no action needed)
 *
 * @param tokens - Tokens to process (from one or multiple wallets on the same chain)
 * @param targetToken - Target token specification including wallet address
 * @param steps - Existing steps array to append to
 * @param log - Logging function for debug output
 * @returns Array of output tokens (swapped + transferred + staying)
 *
 * @throws {Error} ExternalAPIError if any swap quote fails
 */
async function createSwapsAndTransfers(
  tokens: TokenAmount[],
  targetToken: DestinationToken,
  steps: TransactionStep[],
  artifacts: PlanArtifacts,
  log: (...args: unknown[]) => void,
  quotedSwaps?: QuotedSwapGroup[],
): Promise<TokenAmount[]> {
  const outputTokens: TokenAmount[] = [];

  // Separate tokens that need swapping from those already at destination token
  const tokensToSwap = tokens.filter((token) => !isAddressEqual(token.token, targetToken.token));
  const alreadyTargetToken = tokens.filter((token) => isAddressEqual(token.token, targetToken.token));

  // Swap tokens to target token (quotes may have been pre-fetched by the
  // caller for gas measurement/capping — reuse them instead of re-quoting)
  const quoted = quotedSwaps ?? (await fetchSwapQuoteGroups(tokensToSwap, targetToken, log));
  if (quoted.length > 0) {
    log(
      `🔍 [DEBUG] Creating swap steps for ${quoted.length} token groups to ${targetToken.symbol} at wallet ${targetToken.walletAddress}`,
    );
    outputTokens.push(...createSwapStepsFromQuotes(quoted, steps, artifacts, log));
  }

  // Handle tokens already at target token
  for (const token of alreadyTargetToken) {
    if (isAddressEqual(token.walletAddress, targetToken.walletAddress)) {
      // Already at target wallet - no action needed
      log(`🔍 [DEBUG] Token ${token.symbol} already destination token and at destination wallet, no action needed`);
      outputTokens.push(token);
    } else {
      // Same token, wrong wallet - needs transfer
      log(`🔍 [DEBUG] Token ${token.symbol} already destination token but needs transfer`);
      const stepId = `step-${steps.length + 1}`;

      const transferOutput: TokenAmount = {
        ...token,
        walletAddress: targetToken.walletAddress,
        provenance: stepId,
      };

      steps.push({
        id: stepId,
        type: "transfer",
        status: "pending",
        chainId: targetToken.chainId,
        inputTokens: [token],
        outputToken: transferOutput,
      });

      outputTokens.push(transferOutput);
    }
  }

  return outputTokens;
}

/**
 * Processes all swap operations for non-destination chains
 *
 * For each wallet on each non-destination chain:
 * 1. Swaps tokens that aren't the chain's bridge target to that target —
 *    USDC by default (CCTP), or the destination token's Omnibridge twin on a
 *    direct Gnosis route (`bridgeTargets` override)
 * 2. Collects tokens already at the bridge target
 *
 * This function orchestrates the first phase of consolidation where tokens are
 * swapped to the bridgeable token before bridging.
 *
 * @param sourceTokens - Array of all source tokens
 * @param destinationToken - Final target token and chain
 * @param bridgeTargets - Per-chain overrides of the token to swap into before
 *   bridging (defaults to the chain's USDC)
 * @param log - Logging function for debug output
 * @returns Object containing swap steps and all tokens (swapped outputs + existing bridge-target tokens + destination chain tokens)
 *
 * @throws {Error} ExternalAPIError if any swap quote fails
 */
async function processChainWalletSwaps(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  gasCtx: GasContext,
  balances: NativeBalances,
  artifacts: PlanArtifacts,
  log: (...args: unknown[]) => void,
  bridgeTargets?: Map<number, Omit<TokenAmount, "amount" | "walletAddress">>,
  accounts?: AccountsMap,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const steps: TransactionStep[] = [];
  const swappedTokens: TokenAmount[] = [];
  const tokensNotToSwap: TokenAmount[] = [];

  // Group tokens by chain and wallet
  const tokensByChainAndWallet = groupTokensByChainAndWallet(sourceTokens);

  log(
    "🔍 [DEBUG] Tokens grouped by chain and wallet:",
    tokensByChainAndWallet.map((tokens) => ({
      tokenCount: tokens.length,
      tokens: tokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
        wallet: t.walletAddress,
      })),
    })),
  );

  for (const tokens of tokensByChainAndWallet) {
    const { chainId, walletAddress } = tokens[0];
    const isDestChain = chainId === destinationToken.chainId;

    log(
      `🔍 [DEBUG] Processing chain ${chainId}, wallet ${walletAddress}, isDestChain: ${isDestChain}, tokens:`,
      tokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
      })),
    );

    const chainUSDC = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] as Address;
    const bridgeTarget = bridgeTargets?.get(chainId) ?? {
      token: chainUSDC,
      chainId,
      symbol: "USDC",
      decimals: 6,
    };
    const tokensToSwapToBridgeTarget: TokenAmount[] = [];
    const bridgeTargetAlreadyHere: TokenAmount[] = [];

    for (const token of tokens) {
      const isBridgeTarget = isAddressEqual(token.token, bridgeTarget.token);

      if (isDestChain) {
        // Destination chain tokens are processed by createFinalSwaps later
        tokensNotToSwap.push(token);
        continue;
      }

      if (isBridgeTarget) {
        // Already the bridgeable token — stays as-is but still needs to be bridged
        bridgeTargetAlreadyHere.push(token);
        tokensNotToSwap.push(token);
        continue;
      }

      tokensToSwapToBridgeTarget.push(token);
    }

    // Quote, measure, cap, then create the wallet's swap steps to the bridge target.
    if (!isDestChain && tokensToSwapToBridgeTarget.length > 0) {
      const bridgeTargetToken: Omit<TokenAmount, "amount"> = { ...bridgeTarget, walletAddress };

      const quoted = await fetchSwapQuoteGroups(tokensToSwapToBridgeTarget, bridgeTargetToken, log);

      // Native capping runs on MEASURED gas: simulate the quoted swap calls
      // plus the upcoming bridge deposit (its amount is the quoted total) in
      // one eth_simulateV1 batch instead of trusting static budgets.
      const hasNative = quoted.some((q) => q.group.some((t) => isAddressEqual(t.token, zeroAddress)));
      if (hasNative) {
        const simOps: SimOp[] = quoted.flatMap((q) => buildSwapLegSimOps(q.legs));
        const totalBridged =
          quoted.reduce((sum, q) => sum + q.output.amount, 0n) +
          bridgeTargetAlreadyHere.reduce((sum, t) => sum + t.amount, 0n);
        if (totalBridged > 0n) {
          // Omnibridge legs (Gnosis sources, and mainnet sources feeding a
          // Gnosis destination) relay through the Omnibridge, not CCTP.
          const isOmnibridgeLeg =
            chainId === gnosis.id || (chainId === mainnet.id && destinationToken.chainId === gnosis.id);
          simOps.push(
            ...(isOmnibridgeLeg
              ? buildOmnibridgeSimOps(chainId, destinationToken.walletAddress, totalBridged, bridgeTarget.token)
              : buildBridgeSimOps(chainId, destinationToken.chainId, destinationToken.walletAddress, totalBridged)),
          );
        }
        // A Safe pays no gas from its own native balance (the owner EOA
        // funds execTransaction), so its native can be swapped in full — no
        // gas reserve is capped out of it.
        const gasReserveWei = isSafeAccount(accounts, walletAddress)
          ? 0n
          : await measureOpsGas(chainId, walletAddress, simOps, gasCtx.maxFeePerGas[chainId]);
        const nativeBalance = await getCachedNativeBalance(balances, chainId, walletAddress);
        const hasOtherValue = quoted.length > 1 || bridgeTargetAlreadyHere.length > 0;
        await capNativeQuoteForGas(quoted, bridgeTargetToken, gasReserveWei, nativeBalance, hasOtherValue, log);
      }
      // Wallets that can't cover their gas (native or not) are handled by
      // reconcileGasGaps after estimates are attached.

      const swapOutputs = createSwapStepsFromQuotes(quoted, steps, artifacts, log);
      swappedTokens.push(...swapOutputs);
    }
  }

  return { steps, tokens: [...swappedTokens, ...tokensNotToSwap] };
}

/**
 * Creates CCTP bridge steps to transfer USDC from source chains to destination chain
 *
 * For each non-destination chain wallet:
 * 1. Calculates total USDC (existing + swap outputs)
 * 2. Gets bridge fee quote from CCTP
 * 3. Creates bridge step with dependencies on swap steps from that wallet
 *
 * @param steps - Previously created swap steps
 * @param tokens - Tokens containing USDC to bridge (from processChainWalletSwaps)
 * @param destinationToken - Final target token and chain
 * @param log - Logging function for debug output
 * @returns Object containing all steps (input + bridge) and bridged USDC tokens on dest chain
 *
 * @throws {Error} If bridge fee calculation fails
 */
async function createBridgeSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const bridgedTokens: TokenAmount[] = [];
  const destChainUSDC = USDC_ADDRESSES[destinationToken.chainId as keyof typeof USDC_ADDRESSES] as Address;

  // Extract destination chain tokens
  const destinationChainTokens = tokens.filter((t) => t.chainId === destinationToken.chainId);
  // The rest are USDC tokens to bridge
  const usdcTokens = tokens.filter((t) => t.chainId !== destinationToken.chainId);

  // Group USDC tokens by chain and wallet
  const usdcTokensByChainAndWallet = groupTokensByChainAndWallet(usdcTokens);

  for (const usdcTokens of usdcTokensByChainAndWallet) {
    const { chainId, walletAddress } = usdcTokens[0];

    const inputTokens: TokenAmount[] = [];
    const deps: string[] = []; // Tokens from swap outputs come first (with dependencies), then existing USDC

    // Find which tokens are swap outputs and track their step IDs
    for (const token of usdcTokens) {
      // Check if this token has provenance from a swap step
      if (token.provenance) {
        // This is a swap output - add it first with dependency
        inputTokens.unshift(token);
        deps.unshift(token.provenance);
      } else {
        // This is existing USDC - add it after swap outputs
        inputTokens.push(token);
      }
    }

    // Calculate total amount
    const totalAmount = inputTokens.reduce((sum, t) => sum + t.amount, 0n);

    const bridgeFee = await getBridgeFee(totalAmount, chainId, destinationToken.chainId);
    const amountAfterFee = totalAmount - bridgeFee;

    const stepId = `step-${steps.length + 1}`;

    const bridgeOutput: TokenAmount = {
      token: destChainUSDC,
      amount: amountAfterFee,
      chainId: destinationToken.chainId,
      walletAddress: destinationToken.walletAddress,
      symbol: "USDC",
      decimals: 6,
      provenance: stepId, // Mark this token as coming from this bridge step
    };

    steps.push({
      id: stepId,
      type: "bridge",
      status: "pending",
      chainId,
      inputTokens: inputTokens as [TokenAmount, ...TokenAmount[]],
      outputToken: bridgeOutput,
    });

    bridgedTokens.push(bridgeOutput);

    log(
      `🔍 [DEBUG] Added bridge step ${stepId} for wallet ${walletAddress} on chain ${chainId}: ${deps.length} swap deps + ${inputTokens.length - deps.length} existing, total=${totalAmount.toString()}, amount=${amountAfterFee.toString()}, fee=${bridgeFee.toString()}`,
    );
  }

  return { steps, tokens: [...bridgedTokens, ...destinationChainTokens] };
}

/**
 * Creates CCTP attestation and claim steps for bridged USDC
 *
 * CCTP requires two steps on the destination chain:
 * 1. Attestation: Verifies the bridge messages are valid (depends on all bridge steps)
 * 2. Claim: Actually receives the bridged USDC (depends on attestation)
 *
 * Both steps support partial dependencies, meaning they can proceed even if some
 * bridge transactions fail or are skipped.
 *
 * **Important:** This function creates exactly ONE attestation step per plan. Plans
 * must contain at most one attestation step, as attestations are stored in global
 * state metadata. This constraint is enforced by validation in planConsolidation().
 *
 * @param steps - All steps created so far (includes bridge steps)
 * @param tokens - Bridged USDC tokens on destination chain
 * @param destinationToken - Final target token and chain
 * @returns Object containing all steps (input + attestation + claim) and claim output token
 */
function createAttestationAndClaimSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
): { steps: TransactionStep[]; tokens: TokenAmount[] } {
  const bridgeSteps = steps.filter((s) => s.type === "bridge");

  if (bridgeSteps.length === 0) {
    return { steps, tokens };
  }

  const destChainUSDC = USDC_ADDRESSES[destinationToken.chainId as keyof typeof USDC_ADDRESSES] as Address;

  // Create attestation step
  const attestationStepId = `step-${steps.length + 1}`;
  steps.push({
    id: attestationStepId,
    type: "attestation",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: bridgeSteps.map((s) => s.outputToken) as [TokenAmount, ...TokenAmount[]],
    outputToken: {
      token: destChainUSDC,
      amount: bridgeSteps.reduce((sum, s) => sum + s.outputToken.amount, 0n),
      chainId: destinationToken.chainId,
      walletAddress: destinationToken.walletAddress,
      symbol: "USDC",
      decimals: 6,
      provenance: attestationStepId,
    },
  });

  // Create claim step
  const claimStepId = `step-${steps.length + 1}`;
  const totalBridged = bridgeSteps.reduce((sum, s) => sum + s.outputToken.amount, 0n);

  const claimOutput: TokenAmount = {
    token: destChainUSDC,
    amount: totalBridged,
    chainId: destinationToken.chainId,
    walletAddress: destinationToken.walletAddress,
    symbol: "USDC",
    decimals: 6,
    provenance: claimStepId, // Mark this token as coming from this claim step
  };

  steps.push({
    id: claimStepId,
    type: "claim",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: bridgeSteps.map((s) => s.outputToken) as [TokenAmount, ...TokenAmount[]],
    outputToken: claimOutput,
  });

  // Filter out bridged tokens (they're now claimed) and add the claim output
  // Bridged tokens have provenance from bridge steps - exclude them since they're being claimed
  const bridgeStepProvenance = new Set(bridgeSteps.map((s) => s.id));
  const destinationChainTokens = tokens.filter(
    (t) => t.chainId === destinationToken.chainId && !bridgeStepProvenance.has(t.provenance || ""),
  );
  return { steps, tokens: [...destinationChainTokens, claimOutput] };
}

/**
 * Creates the Gnosis egress leg (source Gnosis, destination elsewhere): per
 * Gnosis wallet one `gnosis-bridge` step relaying its bridgeable token into
 * the Omnibridge toward a single mainnet hub wallet, then exactly one
 * `gnosis-wait` (AMB signature collection) and one `gnosis-claim`
 * (executeSignatures on mainnet, releasing the mainnet token).
 *
 * On the fallback route the bridged token is USDC.e and the claim output is
 * mainnet USDC, so the downstream CCTP stages treat it like any other source
 * USDC: `createBridgeSteps` burns it toward the destination chain (or passes
 * it through when the destination IS mainnet). On a direct route the bridged
 * token is the destination token's Gnosis twin and the claim output IS the
 * destination token — no further swap on mainnet.
 *
 * @returns Tokens with the Gnosis entries replaced by the claim output
 */
async function createGnosisEgressSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  hubWallet: Address,
  destinationChainId: number,
  gasCtx: GasContext,
  log: (...args: unknown[]) => void,
  route: GnosisDirectRoute | null = null,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const gnosisTokens = tokens.filter((t) => t.chainId === gnosis.id);
  if (gnosisTokens.length === 0) return { steps, tokens };
  const otherTokens = tokens.filter((t) => t.chainId !== gnosis.id);

  const claimSpec = route
    ? { token: route.pair.mainnetToken, symbol: route.symbol, decimals: route.decimals }
    : { token: USDC_ADDRESSES[mainnet.id] as Address, symbol: "USDC", decimals: 6 };
  const gnosisSideToken = route ? route.pair.gnosisToken : (USDC_ADDRESSES[gnosis.id] as Address);

  const totalAmount = gnosisTokens.reduce((sum, t) => sum + t.amount, 0n);
  const hopOps: OperationType[] = ["omnibridge-claim"];
  if (destinationChainId !== mainnet.id) hopOps.push("cctp-approval", "cctp-burn");
  await assertGnosisRouteWorthIt(
    [{ token: gnosisSideToken, chainId: gnosis.id, decimals: claimSpec.decimals, amount: totalAmount }],
    hopOps,
    gasCtx,
    "from",
    log,
  );

  const walletGroups = groupTokensByChainAndWallet(gnosisTokens);
  if (route) {
    await assertOmnibridgeMinPerTx(
      "egress",
      gnosisSideToken,
      route,
      walletGroups.map((g) => ({
        walletAddress: g[0].walletAddress,
        amount: g.reduce((sum, t) => sum + t.amount, 0n),
      })),
    );
  }

  const bridgeOutputs: TokenAmount[] = [];
  for (const walletTokens of walletGroups) {
    // Swap outputs first (with provenance), then pre-existing bridgeable
    // tokens — mirrors createBridgeSteps' dependency ordering.
    const inputTokens: TokenAmount[] = [];
    for (const token of walletTokens) {
      if (token.provenance) inputTokens.unshift(token);
      else inputTokens.push(token);
    }
    const amount = inputTokens.reduce((sum, t) => sum + t.amount, 0n);

    const stepId = `step-${steps.length + 1}`;
    const bridgeOutput: TokenAmount = {
      ...claimSpec,
      amount, // Omnibridge is fee-free 1:1
      chainId: mainnet.id,
      walletAddress: hubWallet,
      provenance: stepId,
    };
    steps.push({
      id: stepId,
      type: "gnosis-bridge",
      status: "pending",
      chainId: gnosis.id,
      inputTokens: inputTokens as [TokenAmount, ...TokenAmount[]],
      outputToken: bridgeOutput,
    });
    bridgeOutputs.push(bridgeOutput);

    log(
      `🔍 [DEBUG] Added gnosis-bridge step ${stepId} for wallet ${walletTokens[0].walletAddress}: amount=${amount.toString()} -> ${hubWallet} on mainnet`,
    );
  }

  const waitStepId = `step-${steps.length + 1}`;
  steps.push({
    id: waitStepId,
    type: "gnosis-wait",
    status: "pending",
    chainId: mainnet.id,
    inputTokens: [...bridgeOutputs] as [TokenAmount, ...TokenAmount[]],
    outputToken: {
      ...claimSpec,
      amount: totalAmount,
      chainId: mainnet.id,
      walletAddress: hubWallet,
      provenance: waitStepId,
    },
  });

  const claimStepId = `step-${steps.length + 1}`;
  const claimOutput: TokenAmount = {
    ...claimSpec,
    amount: totalAmount,
    chainId: mainnet.id,
    walletAddress: hubWallet,
    provenance: claimStepId,
  };
  steps.push({
    id: claimStepId,
    type: "gnosis-claim",
    status: "pending",
    chainId: mainnet.id,
    inputTokens: [...bridgeOutputs] as [TokenAmount, ...TokenAmount[]],
    outputToken: claimOutput,
  });

  log(`🔍 [DEBUG] Added gnosis-wait ${waitStepId} + gnosis-claim ${claimStepId}: total=${totalAmount.toString()}`);

  return { steps, tokens: [...otherTokens, claimOutput] };
}

/**
 * Creates the Gnosis ingress leg (destination Gnosis), mirroring the CCTP
 * shape: one `gnosis-bridge` step per mainnet wallet — every deposit
 * delivering to the same intermediate wallet on Gnosis — then exactly one
 * `gnosis-wait` that balance-watches the minted token there (no claim
 * transaction exists in this direction).
 *
 * A plan bridges exactly one token flavor. On the fallback route it is USDC,
 * relayed through the USDCTransmuter so USDC.e lands on Gnosis (its swap
 * into the destination token happens cheaply there). On a direct route it is
 * the destination token's mainnet twin: mainnet source assets were already
 * swapped into it by `processChainWalletSwaps`, and the CCTP-claimed hub
 * USDC joins them via a hub swap created here, so tokens never bridge
 * individually per flavor.
 *
 * @returns Tokens with the mainnet entries replaced by the wait output
 *   (bridged token at the intermediate wallet, ready for `createFinalSwaps`)
 */
async function createGnosisIngressSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  intermediateWallet: Address,
  gasCtx: GasContext,
  artifacts: PlanArtifacts,
  log: (...args: unknown[]) => void,
  route: GnosisDirectRoute | null = null,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  let mainnetTokens = tokens.filter((t) => t.chainId === mainnet.id);
  if (mainnetTokens.length === 0) return { steps, tokens };
  const otherTokens = tokens.filter((t) => t.chainId !== mainnet.id);

  const mainnetUSDC = USDC_ADDRESSES[mainnet.id] as Address;
  const bridgeSpec = route
    ? { token: route.pair.mainnetToken, symbol: route.symbol, decimals: route.decimals }
    : { token: mainnetUSDC, symbol: "USDC", decimals: 6 };
  const deliveredSpec = route
    ? { token: route.pair.gnosisToken, symbol: route.symbol, decimals: route.decimals }
    : { token: USDC_ADDRESSES[gnosis.id] as Address, symbol: "USDC.e", decimals: 6 };

  // On a direct route the CCTP claim output is still USDC and needs the hub
  // swap into the twin; mainnet source assets are already the twin.
  const usdcToHubSwap = route ? mainnetTokens.filter((t) => isAddressEqual(t.token, mainnetUSDC)) : [];
  const usdcWalletGroups = groupTokensByChainAndWallet(usdcToHubSwap);
  const walletCount = new Set(mainnetTokens.map((t) => getAddress(t.walletAddress))).size;

  const hadCctpBridges = steps.some((s) => s.type === "bridge");
  const hopOps: OperationType[] = [
    ...(hadCctpBridges ? (["cctp-claim"] as OperationType[]) : []),
    ...usdcWalletGroups.flatMap(() => ["erc20-approval", "swap"] as OperationType[]),
    ...Array.from({ length: walletCount }).flatMap(() => ["erc20-approval", "omnibridge-relay"] as OperationType[]),
  ];
  // Value floor on the pre-hub-swap amounts — the entries may still be mixed
  // (claimed USDC + twin), which the USD-based check handles.
  await assertGnosisRouteWorthIt(
    [
      ...(usdcToHubSwap.length > 0
        ? [
            {
              token: mainnetUSDC,
              chainId: mainnet.id,
              decimals: 6,
              amount: usdcToHubSwap.reduce((sum, t) => sum + t.amount, 0n),
            },
          ]
        : []),
      ...(mainnetTokens.length > usdcToHubSwap.length
        ? [
            {
              token: bridgeSpec.token,
              chainId: mainnet.id,
              decimals: bridgeSpec.decimals,
              amount: mainnetTokens.filter((t) => !usdcToHubSwap.includes(t)).reduce((sum, t) => sum + t.amount, 0n),
            },
          ]
        : []),
    ],
    hopOps,
    gasCtx,
    "to",
    log,
  );

  // Hub swap: convert the claimed USDC into the twin at its holding wallet.
  // Fails loudly when Delora has no route — silently skipping would strand
  // the bridged USDC on mainnet.
  if (usdcWalletGroups.length > 0 && route) {
    const rest = mainnetTokens.filter((t) => !usdcToHubSwap.includes(t));
    const outputs: TokenAmount[] = [];
    for (const walletTokens of usdcWalletGroups) {
      const target: Omit<TokenAmount, "amount"> = {
        ...bridgeSpec,
        chainId: mainnet.id,
        walletAddress: walletTokens[0].walletAddress,
      };
      const quoted = await fetchSwapQuoteGroups(walletTokens, target, log);
      if (quoted.length === 0) {
        throw new Error(
          `PlanningError: No route to swap the bridged USDC to ${route.symbol} on Ethereum mainnet. Please try again later.`,
        );
      }
      outputs.push(...createSwapStepsFromQuotes(quoted, steps, artifacts, log));
    }
    mainnetTokens = [...rest, ...outputs];
  }

  const walletGroups = groupTokensByChainAndWallet(mainnetTokens);
  if (route) {
    await assertOmnibridgeMinPerTx(
      "ingress",
      bridgeSpec.token,
      route,
      walletGroups.map((g) => ({
        walletAddress: g[0].walletAddress,
        amount: g.reduce((sum, t) => sum + t.amount, 0n),
      })),
    );
  }

  const totalAmount = mainnetTokens.reduce((sum, t) => sum + t.amount, 0n);
  const bridgeOutputs: TokenAmount[] = [];
  for (const walletTokens of walletGroups) {
    const inputTokens: TokenAmount[] = [];
    for (const token of walletTokens) {
      if (token.provenance) inputTokens.unshift(token);
      else inputTokens.push(token);
    }
    const amount = inputTokens.reduce((sum, t) => sum + t.amount, 0n);

    const stepId = `step-${steps.length + 1}`;
    const bridgeOutput: TokenAmount = {
      ...deliveredSpec,
      amount, // Omnibridge is fee-free 1:1
      chainId: gnosis.id,
      walletAddress: intermediateWallet,
      provenance: stepId,
    };
    steps.push({
      id: stepId,
      type: "gnosis-bridge",
      status: "pending",
      chainId: mainnet.id,
      inputTokens: inputTokens as [TokenAmount, ...TokenAmount[]],
      outputToken: bridgeOutput,
    });
    bridgeOutputs.push(bridgeOutput);

    log(
      `🔍 [DEBUG] Added gnosis-bridge (ingress) step ${stepId} for wallet ${walletTokens[0].walletAddress}: amount=${amount.toString()} -> ${intermediateWallet} on Gnosis`,
    );
  }

  const waitStepId = `step-${steps.length + 1}`;
  const waitOutput: TokenAmount = {
    ...deliveredSpec,
    amount: totalAmount,
    chainId: gnosis.id,
    walletAddress: intermediateWallet,
    provenance: waitStepId,
  };
  steps.push({
    id: waitStepId,
    type: "gnosis-wait",
    status: "pending",
    chainId: gnosis.id,
    inputTokens: [...bridgeOutputs] as [TokenAmount, ...TokenAmount[]],
    outputToken: waitOutput,
  });

  log(`🔍 [DEBUG] Added gnosis-wait ${waitStepId} (ingress delivery watch): total=${totalAmount.toString()}`);

  return { steps, tokens: [...otherTokens, waitOutput] };
}

/**
 * Creates final swap steps to convert remaining tokens to the destination token on destination chain
 *
 * This is the last phase in consolidation when the destination token is not USDC.
 * It aggregates:
 * - USDC that was already on the destination chain
 * - USDC that was bridged and claimed from other chains
 *
 * Same-address USDC entries (pre-existing + claimed) share one swap step.
 * The final swaps depend on claim steps (if any bridges exist).
 *
 * @param steps - All steps created so far (swaps, bridges, attestation, claim)
 * @param tokens - Remaining tokens on destination chain (includes USDC that was already on the destination
 * chain and USDC that was bridged and claimed from other chains, among other tokens)
 * @param destinationToken - Final target token and chain
 * @param log - Logging function for debug output
 * @returns Object containing all steps (input + final swaps) and final output tokens
 *
 * @throws {Error} ExternalAPIError if swap quote fails
 */
async function createFinalSwaps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  gasCtx: GasContext,
  hasBridges: boolean,
  needsFinalTransfer: boolean,
  needsShield: boolean,
  balances: NativeBalances,
  artifacts: PlanArtifacts,
  log: (...args: unknown[]) => void,
  accounts?: AccountsMap,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  log(
    "🔍 [DEBUG] createFinalSwaps called with tokens:",
    tokens.map((t) => ({
      symbol: t.symbol,
      amount: t.amount.toString(),
      token: t.token,
      wallet: t.walletAddress,
      provenance: t.provenance,
    })),
  );

  // Group tokens by chain and wallet
  const tokensByChainAndWallet = groupTokensByChainAndWallet(tokens);

  log(
    "🔍 [DEBUG] Tokens grouped by wallet (consolidated):",
    tokensByChainAndWallet.map((tokens) => ({
      tokenCount: tokens.length,
    })),
  );

  const allOutputTokens: TokenAmount[] = [];

  // Process each wallet - create swaps and transfers as needed
  for (const consolidatedTokens of tokensByChainAndWallet.values()) {
    const walletAddress = consolidatedTokens[0].walletAddress;

    log(
      `🔍 [DEBUG] Wallet ${walletAddress} - Processing ${consolidatedTokens.length} consolidated tokens`,
      consolidatedTokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
      })),
    );

    // Quote the wallet's final swaps at full amounts, then MEASURE the whole
    // dest-chain sequence (claim + swaps + transfer/shield) via eth_simulateV1
    // so native capping runs on real numbers (skipped when the destination
    // token IS native — the user wants to KEEP it). Wallets that can't cover
    // their gas are handled by reconcileGasGaps after estimates are attached.
    const tokensToProcess = [...consolidatedTokens];
    const destIsNative = isAddressEqual(destinationToken.token, zeroAddress);
    const destChainId = destinationToken.chainId;
    const isIntermediateWallet = isAddressEqual(walletAddress, destinationToken.walletAddress);

    // Only the wallet holding the consolidated token (the intermediate wallet,
    // i.e. destinationToken.walletAddress here) executes the final shield.
    const shieldsHere = needsShield && isIntermediateWallet;

    const tokensToSwap = tokensToProcess.filter((t) => !isAddressEqual(t.token, destinationToken.token));
    const quoted = await fetchSwapQuoteGroups(tokensToSwap, destinationToken, log);

    const hasNativeToCap =
      !destIsNative && quoted.some((q) => q.group.some((t) => isAddressEqual(t.token, zeroAddress)));
    if (hasNativeToCap) {
      const simOps: SimOp[] = [];
      if (hasBridges && isIntermediateWallet) {
        simOps.push({ op: "cctp-claim" });
      }
      // A Gnosis egress into a mainnet destination puts the Omnibridge claim
      // on this same wallet+chain — reserve its gas too.
      if (isIntermediateWallet && steps.some((s) => s.type === "gnosis-claim" && s.chainId === destChainId)) {
        simOps.push({ op: "omnibridge-claim" });
      }
      simOps.push(...quoted.flatMap((q) => buildSwapLegSimOps(q.legs)));
      if (needsFinalTransfer && isIntermediateWallet) {
        simOps.push({ op: destIsNative ? "transfer-native" : "transfer-erc20" });
      }
      if (shieldsHere) {
        simOps.push({ op: "erc20-approval" }, { op: "shield" });
      }

      // Safe wallets don't fund gas from their own native (see
      // processChainWalletSwaps) — skip the gas reserve when capping.
      const gasReserveWei = isSafeAccount(accounts, walletAddress)
        ? 0n
        : await measureOpsGas(destChainId, walletAddress, simOps, gasCtx.maxFeePerGas[destChainId]);
      const nativeBalance = await getCachedNativeBalance(balances, destChainId, walletAddress);
      const hasOtherValue = tokensToProcess.length > 1;
      const cappedNative = await capNativeQuoteForGas(
        quoted,
        destinationToken,
        gasReserveWei,
        nativeBalance,
        hasOtherValue,
        log,
      );

      // Mirror the cap/drop into tokensToProcess so the transfer/keep split in
      // createSwapsAndTransfers stays consistent with the quoted groups.
      const nativeIdx = tokensToProcess.findIndex((t) => isAddressEqual(t.token, zeroAddress));
      if (nativeIdx >= 0) {
        if (cappedNative === null) {
          tokensToProcess.splice(nativeIdx, 1);
        } else {
          tokensToProcess[nativeIdx] = cappedNative;
        }
      }
    }

    // Use shared logic to create swaps and transfers
    const walletOutputs = await createSwapsAndTransfers(
      tokensToProcess,
      destinationToken,
      steps,
      artifacts,
      log,
      quoted,
    );

    allOutputTokens.push(...walletOutputs);
  }

  // Final consolidation - sum up all destination tokens at destination wallet
  const finalTokens = groupTokensByChainAndWallet(allOutputTokens).flat();

  log(
    "🔍 [DEBUG] Final tokens after consolidation:",
    finalTokens.map((t) => ({
      symbol: t.symbol,
      amount: t.amount.toString(),
      wallet: t.walletAddress,
    })),
  );

  return { steps, tokens: finalTokens };
}

async function createFinalTransfer(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const consolidatedTokens = groupTokensByChainAndWallet(tokens);

  // Validate that all tokens are at the same wallet, chain, and token address
  if (consolidatedTokens.length !== 1) {
    throw new Error("PlanningError: Final transfer step must have tokens from exactly one wallet and chain");
  }

  const tokensAtWallet = consolidatedTokens[0];
  if (tokensAtWallet.length === 0) {
    throw new Error("PlanningError: Final transfer step must have at least one token");
  }

  // Verify all tokens are the same token address
  const tokenAddress = tokensAtWallet[0].token;
  for (const token of tokensAtWallet) {
    if (token.token !== tokenAddress) {
      throw new Error("PlanningError: Final transfer step must have tokens of the same address");
    }
  }

  const stepId = `step-${steps.length + 1}`;

  // Calculate total amount from all tokens (they may have different provenances)
  const totalAmount = tokensAtWallet.reduce((sum, t) => sum + t.amount, 0n);
  const sourceWallet = tokensAtWallet[0].walletAddress;

  const transferOutput: TokenAmount = {
    ...tokensAtWallet[0],
    amount: totalAmount,
    walletAddress: destinationToken.walletAddress,
    provenance: stepId,
  };

  steps.push({
    id: stepId,
    type: "transfer",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: tokensAtWallet as [TokenAmount, ...TokenAmount[]],
    outputToken: transferOutput,
  });

  log(
    `🔍 [DEBUG] Added transfer step ${stepId} from wallet ${sourceWallet} to ${destinationToken.walletAddress} with ${tokensAtWallet.length} input token(s) totaling ${totalAmount.toString()}`,
  );

  return { steps, tokens: [transferOutput] };
}

/**
 * Appends the final Railgun shield step: deposits the consolidated ERC20 held
 * by the intermediate wallet into the RailgunSmartWallet, credited to
 * `railgunAddress`. The output reflects the 0.25% protocol shield fee.
 * The output token's `walletAddress` stays the public holder — the private
 * recipient is recorded on the step's `railgunAddress`.
 */
function createShieldStep(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  railgunAddress: string,
  log: (...args: unknown[]) => void,
): { steps: TransactionStep[]; tokens: TokenAmount[] } {
  const consolidatedTokens = groupTokensByChainAndWallet(tokens);

  if (consolidatedTokens.length !== 1) {
    throw new Error("PlanningError: Shield step must have tokens from exactly one wallet and chain");
  }

  const tokensAtWallet = consolidatedTokens[0];
  if (tokensAtWallet.length === 0) {
    throw new Error("PlanningError: Shield step must have at least one token");
  }

  const tokenAddress = tokensAtWallet[0].token;
  for (const token of tokensAtWallet) {
    if (!isAddressEqual(token.token, tokenAddress)) {
      throw new Error("PlanningError: Shield step must have tokens of the same address");
    }
  }

  const stepId = `step-${steps.length + 1}`;
  const totalAmount = tokensAtWallet.reduce((sum, t) => sum + t.amount, 0n);

  const shieldOutput: TokenAmount = {
    ...tokensAtWallet[0],
    amount: getShieldedAmountAfterFee(totalAmount),
    provenance: stepId,
  };

  steps.push({
    id: stepId,
    type: "shield",
    status: "pending",
    chainId: tokensAtWallet[0].chainId,
    inputTokens: tokensAtWallet as [TokenAmount, ...TokenAmount[]],
    outputToken: shieldOutput,
    railgunAddress,
  });

  log(
    `🔍 [DEBUG] Added shield step ${stepId} from wallet ${tokensAtWallet[0].walletAddress} to ${railgunAddress}: total=${totalAmount.toString()}, after fee=${shieldOutput.amount.toString()}`,
  );

  return { steps, tokens: [shieldOutput] };
}

/**
 * Builds gas-topup (and optional gas-topup-wait) steps that refuel wallets which
 * couldn't cover their own gas during pipeline construction.
 *
 * Funding source preference:
 *   1. Destination wallet on the destination chain (if it has enough native).
 *   2. Otherwise the richest source across ALL supported chains × executor wallets.
 *
 * Per gap, we get a refuel quote (Gas.zip, Delora fallback) sized to deliver exactly
 * the deficit (cross-chain),
 * or schedule a same-chain native transfer (when source and gap share a chain).
 *
 * @returns Empty array when there are no gaps; one or two steps otherwise.
 */
async function createGasTopUpSteps(
  gaps: GasGaps,
  intermediateWallet: Address,
  destinationToken: DestinationToken,
  executorAddresses: Set<Address>,
  log: (...args: unknown[]) => void,
  accounts?: AccountsMap,
): Promise<TransactionStep[]> {
  if (gaps.size === 0) return [];

  const gapEntries = [...gaps.values()];

  // Try a sequence of source candidates in priority order. For each candidate we
  // get the actual refuel quotes (they include provider fees and cross-token rates)
  // and accept the candidate only if its usable balance covers the total deposit.
  const destChainId = destinationToken.chainId;
  const destChain = chains[destChainId as keyof typeof chains];
  const candidates: { chainId: number; address: Address; balance: bigint; label: string }[] = [];

  // A Safe can't fund top-ups: the gas-topup step sends native via a plain
  // EOA transaction, and routing it through an N-of-M round isn't worth it.
  if (destChain && !isSafeAccount(accounts, intermediateWallet)) {
    const destBalance = await getNativeBalance(
      destChain,
      intermediateWallet,
      transports?.[destChainId as keyof typeof transports],
    );
    candidates.push({
      chainId: destChainId,
      address: getAddress(intermediateWallet) as Address,
      balance: destBalance,
      label: `destination wallet ${intermediateWallet} on ${destChain.name}`,
    });
  }

  // Build the full fallback candidate set from on-chain native balances. We
  // sort non-L1 pairs by USD value of the native balance — comparing raw wei
  // across chains is wrong because natives have wildly different prices and
  // decimals: e.g. 5 POL (5e18 wei ≈ $1) would otherwise outrank 0.5 ETH
  // (5e17 wei ≈ $1500). Mainnet pairs sort to the bottom regardless, because
  // bridging gas *out of* L1 is expensive. When Delora has no price for a chain
  // (or the fetch fails), that pair gets `usd = 0` and tie-breaks by raw
  // balance, matching the previous behavior so the sort never makes things
  // worse.
  const executorPairs = [...executorAddresses].flatMap((addr) =>
    SUPPORTED_CHAINS.map((c) => [c, addr] as [number, Address]),
  );
  const fallbackBalances = (
    await Promise.all(
      executorPairs.map(async ([chainId, address]) => {
        const chain = chains[chainId as keyof typeof chains];
        if (!chain) return null;
        const balance = await getNativeBalance(chain, address, transports?.[chainId as keyof typeof transports]);
        return balance > 0n ? { chainId, address: getAddress(address) as Address, balance, chain } : null;
      }),
    )
  ).filter(<T>(x: T | null): x is T => x !== null);

  const uniqueChains = [...new Set(fallbackBalances.map((b) => b.chainId))];
  const priceMap = await fetchDeloraPrices(uniqueChains.map((chainId) => ({ chainId, token: zeroAddress })));

  const sortedFallbacks = fallbackBalances
    .map((b) => {
      const priceUsd = priceMap.get(deloraPriceKey(b.chainId, zeroAddress)) ?? 0;
      const usd = priceUsd * Number(formatUnits(b.balance, b.chain.nativeCurrency.decimals));
      return { ...b, usd, isMainnet: b.chainId === mainnet.id };
    })
    .sort((a, b) => {
      if (a.isMainnet !== b.isMainnet) return a.isMainnet ? 1 : -1;
      if (a.usd !== b.usd) return b.usd - a.usd;
      return a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0;
    });

  for (const fallback of sortedFallbacks) {
    const isDup = candidates.some((c) => c.chainId === fallback.chainId && isAddressEqual(c.address, fallback.address));
    if (isDup) continue;
    candidates.push({
      chainId: fallback.chainId,
      address: fallback.address,
      balance: fallback.balance,
      label: `richest source ${fallback.address} on ${fallback.chain.name}`,
    });
  }

  if (candidates.length === 0) {
    throw new Error("PlanningError: No wallet with native balance found to fund gas top-up");
  }

  let resolved: {
    source: { chainId: number; address: Address; balance: bigint };
    sourceChain: (typeof chains)[keyof typeof chains];
    destinations: { chainId: number; address: Address; amountWei: string; depositRequired: bigint }[];
    totalDeposit: bigint;
  } | null = null;
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    const sourceChain = chains[candidate.chainId as keyof typeof chains];
    if (!sourceChain) continue;

    const sourceOwnGap = gaps.get(gapKey(candidate.chainId, candidate.address))?.deficitWei ?? 0n;
    const sourceUsableBalance = candidate.balance > sourceOwnGap ? candidate.balance - sourceOwnGap : 0n;

    const destinations: { chainId: number; address: Address; amountWei: string; depositRequired: bigint }[] = [];

    let candidateError: Error | null = null;
    for (const gap of gapEntries) {
      if (gap.chainId === candidate.chainId && isAddressEqual(gap.walletAddress, candidate.address)) {
        continue;
      }

      if (gap.chainId === candidate.chainId) {
        destinations.push({
          chainId: gap.chainId,
          address: gap.walletAddress,
          amountWei: gap.deficitWei.toString(),
          depositRequired: gap.deficitWei,
        });
        continue;
      }

      try {
        const quote = await getGasRefuelQuote(
          candidate.chainId,
          gap.chainId,
          gap.deficitWei,
          candidate.address,
          gap.walletAddress,
        );
        destinations.push({
          chainId: gap.chainId,
          address: gap.walletAddress,
          amountWei: gap.deficitWei.toString(),
          depositRequired: quote.depositWei,
        });
      } catch (error) {
        const gapChain = chains[gap.chainId as keyof typeof chains];
        const chainName = gapChain ? (gapChain as { name: string }).name : String(gap.chainId);
        candidateError = new Error(
          `PlanningError: You don't have enough gas on ${chainName} and no gas refuel route (Gas.zip or Delora) is available right now. Please try again later or manually top up gas on that network. (${error instanceof Error ? error.message : String(error)})`,
        );
        break;
      }
    }

    if (candidateError) {
      lastError = candidateError;
      continue;
    }

    if (destinations.length === 0) {
      // All gaps were for the candidate itself. The candidate can't fund its own
      // deficit (the gap exists precisely because it lacks the funds), so try the
      // next candidate.
      log(`🔍 [DEBUG] Gas top-up: ${candidate.label} can only fund itself, trying next candidate`);
      continue;
    }

    const totalDeposit = destinations.reduce((sum, d) => sum + d.depositRequired, 0n);

    if (sourceUsableBalance < totalDeposit) {
      const symbol = sourceChain.nativeCurrency.symbol;
      const decimals = sourceChain.nativeCurrency.decimals;
      const balanceFormatted = formatUnits(sourceUsableBalance, decimals);
      const neededFormatted = formatUnits(totalDeposit, decimals);
      lastError = new Error(
        `PlanningError: Insufficient funds for gas top-up. Wallet ${candidate.address} on ${sourceChain.name} has ${balanceFormatted} ${symbol} available but needs ${neededFormatted} ${symbol}.`,
      );
      log(`🔍 [DEBUG] Gas top-up: ${candidate.label} can't cover total deposit, trying next candidate`);
      continue;
    }

    log(`🔍 [DEBUG] Gas top-up: funding from ${candidate.label}`);
    resolved = {
      source: { chainId: candidate.chainId, address: candidate.address, balance: candidate.balance },
      sourceChain,
      destinations,
      totalDeposit,
    };
    break;
  }

  if (!resolved) {
    throw lastError ?? new Error("PlanningError: No funding source available for gas top-up");
  }

  const { source, sourceChain, destinations, totalDeposit } = resolved;

  const gasTopUpStepId = "step-gas-topup";
  const gasTopUpWaitStepId = "step-gas-topup-wait";

  const inputToken: TokenAmount = {
    token: zeroAddress,
    amount: totalDeposit,
    chainId: source.chainId,
    walletAddress: source.address,
    symbol: sourceChain.nativeCurrency.symbol,
    decimals: sourceChain.nativeCurrency.decimals,
  };

  const outputToken: TokenAmount = {
    ...inputToken,
    provenance: gasTopUpStepId,
  };

  const gasTopUpDestinations = destinations.map((d) => ({
    chainId: d.chainId,
    address: d.address,
    amountWei: d.amountWei,
  }));

  const gasTopUpStep: TransactionStep = {
    id: gasTopUpStepId,
    type: "gas-topup",
    status: "pending",
    chainId: source.chainId,
    inputTokens: [inputToken],
    outputToken,
    gasTopUpDestinations,
  };

  const hasCrossChain = destinations.some((d) => d.chainId !== source.chainId);

  if (!hasCrossChain) {
    log(
      `🔍 [DEBUG] Gas top-up: created 1 step (same-chain only) for ${destinations.length} destinations, total deposit: ${totalDeposit.toString()} wei`,
    );
    return [gasTopUpStep];
  }

  const gasTopUpWaitStep: TransactionStep = {
    id: gasTopUpWaitStepId,
    type: "gas-topup-wait",
    status: "pending",
    chainId: source.chainId,
    inputTokens: [outputToken],
    outputToken: { ...outputToken, provenance: gasTopUpWaitStepId },
    gasTopUpDestinations,
  };

  log(
    `🔍 [DEBUG] Gas top-up: created steps for ${destinations.length} destinations, total deposit: ${totalDeposit.toString()} wei`,
  );

  return [gasTopUpStep, gasTopUpWaitStep];
}

/** Step types whose calls the step wallet itself signs (Safe path candidates). */
const SAFE_EXECUTABLE_TYPES = new Set<TransactionStep["type"]>([
  "swap",
  "bridge",
  "transfer",
  "gnosis-bridge",
  "shield",
]);

/**
 * Base execTransaction overhead plus per-signature verification cost, added
 * on top of the measured inner-call gas for Safe-executed steps. Conservative
 * constants — the real number is re-estimated via eth_estimateGas at send
 * time; this only keeps planning-side reservations from undershooting.
 */
const SAFE_EXEC_BASE_GAS = 45_000n;
const SAFE_EXEC_PER_SIGNATURE_GAS = 8_000n;

/**
 * Tags steps whose input wallet is a Safe with the execution marker the
 * executor dispatches on, and groups independent same-(chain, Safe) steps
 * into MultiSend batches by provenance: a step joins the current open group
 * when none of its inputs were produced by a member of that group (an intra-
 * group dependency means the amount doesn't exist until the group executes,
 * so the dependent step starts the next group). Batched steps execute as ONE
 * Safe transaction — one signature round — and succeed/fail/retry together.
 *
 * Claim steps (`claim`/`gnosis-claim`) are deliberately not tagged: CCTP's
 * `receiveMessage` (via Multicall3) and Omnibridge's `executeSignatures` are
 * permissionless, so the owner EOA runs them directly and co-signers are
 * never bothered for them.
 */
function tagSafeSteps(steps: TransactionStep[], accounts: AccountsMap | undefined): void {
  if (!accounts) return;

  type BatchGroup = { batchId: string; chainId: number; safe: string; memberIds: Set<string> };
  let openGroup: BatchGroup | null = null;

  for (const step of steps) {
    const wallet = step.inputTokens[0]?.walletAddress;
    if (!wallet || !SAFE_EXECUTABLE_TYPES.has(step.type)) continue;
    const account = accountFor(accounts, wallet);
    if (account.kind !== "safe") continue;

    const deployment = account.deployments[step.chainId];
    if (!deployment) {
      // assertSafeChainConsistency rejects this plan; keep the tag pass total.
      continue;
    }

    // Only swaps and transfers share a MultiSend batch: their calls are pure
    // and their outputs attributable from one receipt's logs. Bridge and
    // Omnibridge steps persist per-step side effects (burn tx hashes feeding
    // the attestation, delivery baselines) and shield is gated off — each
    // gets a singleton group. (Final swaps never feed a transfer: they pay
    // out directly to the destination wallet, so intra-group dependencies
    // simply don't arise between swaps and transfers.)
    const canShareGroup = step.type === "swap" || step.type === "transfer";
    const current: BatchGroup | null = openGroup;
    const dependsOnOpenGroup =
      current !== null &&
      step.inputTokens.some((input) => input.provenance !== undefined && current.memberIds.has(input.provenance));
    const sameGroupTarget =
      current !== null && current.chainId === step.chainId && current.safe === wallet.toLowerCase();

    const group: BatchGroup =
      canShareGroup && current !== null && sameGroupTarget && !dependsOnOpenGroup
        ? current
        : {
            batchId: `safe-batch-${step.id}`,
            chainId: step.chainId,
            safe: wallet.toLowerCase(),
            memberIds: new Set<string>(),
          };
    openGroup = canShareGroup ? group : null;
    group.memberIds.add(step.id);

    step.execution = {
      via: "safe",
      safeAddress: account.address,
      ownerAddress: account.ownerAddress,
      threshold: deployment.threshold,
      safeVersion: deployment.version,
      batchId: group.batchId,
    };
  }
}

/**
 * Adds the execTransaction wrapper's gas to Safe-executed steps, once per
 * batch group (a group is one on-chain transaction). Runs after
 * `attachGasEstimates` so the measured inner-call figures stay intact.
 */
function addSafeExecGasOverhead(steps: TransactionStep[]): void {
  const chargedBatches = new Set<string>();
  for (const step of steps) {
    if (!step.execution || !step.estimatedGas) continue;
    if (chargedBatches.has(step.execution.batchId)) continue;
    chargedBatches.add(step.execution.batchId);
    const overheadUnits = SAFE_EXEC_BASE_GAS + SAFE_EXEC_PER_SIGNATURE_GAS * BigInt(step.execution.threshold);
    step.estimatedGas = {
      ...step.estimatedGas,
      gasUnits: step.estimatedGas.gasUnits + overheadUnits,
      gasCostWei: step.estimatedGas.gasCostWei + overheadUnits * step.estimatedGas.maxFeePerGas,
    };
  }
}

/**
 * Final invariant over the drafted plan: every token that sits at a Safe's
 * address must sit on a chain where that Safe has a controlled, verified
 * deployment. This is the single guarantee that a Safe address is never used
 * as a CCTP mintRecipient, Omnibridge receiver, transfer target, or top-up
 * destination on a chain where the Safe doesn't exist — regardless of which
 * code path produced the token.
 */
function assertSafeChainConsistency(steps: TransactionStep[], accounts: AccountsMap | undefined): void {
  if (!accounts) return;
  for (const step of steps) {
    for (const token of [...step.inputTokens, step.outputToken]) {
      const account = accountFor(accounts, token.walletAddress);
      if (account.kind === "safe" && !safeControlledOn(account, token.chainId)) {
        const chainName = chains[token.chainId as keyof typeof chains]?.name ?? `chain ${token.chainId}`;
        throw new Error(
          `SafeNotDeployedError: Plan step ${step.id} would route ${token.symbol} to Safe ${token.walletAddress} ` +
            `on ${chainName}, where it has no controlled deployment.`,
        );
      }
    }
    if (step.type === "gas-topup") {
      for (const destination of step.gasTopUpDestinations ?? []) {
        if (isSafeAccount(accounts, destination.address)) {
          throw new Error(
            `PlanningError: Gas top-up targets Safe ${destination.address} — top-ups must target the owner EOA.`,
          );
        }
      }
    }
  }
}

/**
 * Fast path for plans whose every source token is already the destination token
 * on the destination chain — used only when there's a single source wallet or
 * the destination wallet is connected (multi-source non-connected destinations
 * still need the intermediate-wallet aggregation handled by the general
 * pipeline).
 *
 * Emits one transfer per source row directly to the destination, plus an
 * optional gas-topup when a source wallet can't cover its own transfer gas.
 * Avoids the multi-chain gas context, intermediate-wallet resolution, and the
 * swap/bridge/claim phases that would all be no-ops here.
 */
async function planTransferOnly(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  log: (...args: unknown[]) => void,
  accounts?: AccountsMap,
): Promise<TransactionStep[]> {
  const destChainId = destinationToken.chainId;
  const destIsNative = isAddressEqual(destinationToken.token, zeroAddress);
  const transferOp: OperationType = destIsNative ? "transfer-native" : "transfer-erc20";
  const gasCtx = await buildGasContext([destChainId]);
  const balances: NativeBalances = new Map();
  const steps: TransactionStep[] = [];

  // One transfer step per source row (mirrors createSwapsAndTransfers). Group
  // by source wallet so one balance check covers every transfer that wallet
  // signs.
  const byWallet = groupTokensByChainAndWallet(sourceTokens);

  for (const walletTokens of byWallet) {
    const sourceWallet = walletTokens[0].walletAddress;

    if (isAddressEqual(sourceWallet, destinationToken.walletAddress)) {
      log(`🔍 [DEBUG] Transfer-only: ${walletTokens.length} row(s) already at destination ${sourceWallet}, skipping`);
      continue;
    }

    const ops: OperationType[] = walletTokens.map(() => transferOp);
    const gasCost = await estimateChainGasCosts(destChainId, ops, gasCtx.maxFeePerGas[destChainId]);
    const nativeBalance = await getCachedNativeBalance(balances, destChainId, sourceWallet);
    // A Safe source pays no gas from its own native (the owner EOA funds
    // execTransaction), so nothing is reserved out of the transfer amount.
    const gasReserveWei = isSafeAccount(accounts, sourceWallet) ? 0n : gasCost.totalGasCost;

    let processedTokens: TokenAmount[] = walletTokens;

    if (destIsNative) {
      const totalAmount = walletTokens.reduce((sum, t) => sum + t.amount, 0n);
      const maxAffordable = nativeBalance > gasReserveWei ? nativeBalance - gasReserveWei : 0n;

      if (maxAffordable <= 0n) {
        // Wallet can't cover its own gas. Refuse a sole dust transfer;
        // otherwise keep the amount — reconcileGasGaps sizes the top-up.
        if (totalAmount <= dustTopUpThreshold(totalAmount, gasReserveWei, nativeBalance)) {
          throwNativeAmountTooSmall(destChainId, sourceWallet, totalAmount, gasReserveWei);
        }
      } else if (totalAmount > maxAffordable) {
        // Cap the last row by the overshoot so enough native is left for gas.
        const overshoot = totalAmount - maxAffordable;
        processedTokens = [...walletTokens];
        const last = processedTokens.length - 1;
        processedTokens[last] = {
          ...processedTokens[last],
          amount: processedTokens[last].amount - overshoot,
        };
        log(
          `🔍 [DEBUG] Transfer-only: capped native amount on ${sourceWallet}: total=${totalAmount.toString()} → ${maxAffordable.toString()} (gas=${gasCost.totalGasCost.toString()})`,
        );
      }
    }
    // Gas-poor wallets are topped up via reconcileGasGaps below.

    for (const token of processedTokens) {
      const stepId = `step-${steps.length + 1}`;
      const transferOutput: TokenAmount = {
        ...token,
        walletAddress: destinationToken.walletAddress,
        provenance: stepId,
      };
      steps.push({
        id: stepId,
        type: "transfer",
        status: "pending",
        chainId: destChainId,
        inputTokens: [token],
        outputToken: transferOutput,
      });
    }
  }

  // Measure first (batched eth_simulateV1 with ladder fallback), then size
  // top-ups from the measured deficits.
  tagSafeSteps(steps, accounts);
  await attachGasEstimates(steps, gasCtx);
  addSafeExecGasOverhead(steps);
  const gaps = await reconcileGasGaps(steps, balances, log, accounts);

  let finalSteps = steps;
  if (gaps.size > 0) {
    const executorAddresses = new Set<Address>();
    executorAddresses.add(getAddress(executorFor(accounts, destinationToken.walletAddress)) as Address);
    for (const t of sourceTokens) {
      executorAddresses.add(getAddress(executorFor(accounts, t.walletAddress)) as Address);
    }
    const gasTopUpSteps = await createGasTopUpSteps(
      gaps,
      destinationToken.walletAddress,
      destinationToken,
      executorAddresses,
      log,
      accounts,
    );
    await attachGasEstimates(gasTopUpSteps, gasCtx);
    finalSteps = [...gasTopUpSteps, ...steps];
  }

  assertSafeChainConsistency(finalSteps, accounts);
  return finalSteps;
}

/**
 * Plans a complete multi-chain token consolidation by generating transaction steps
 *
 * This is the main planning function that orchestrates the entire consolidation process:
 *
 * **Planning Flow:**
 * 1. Validates inputs (token limits, chain support, amounts)
 * 2. Groups tokens by chain and wallet for efficient processing
 * 3. Creates swap steps to convert tokens to USDC or destination token
 * 4. Creates bridge steps to transfer USDC across chains via CCTP
 * 5. Creates attestation and claim steps for bridged USDC
 * 6. Creates final swap step if destination is not USDC
 * 7. Validates plan constraints (at most one attestation step)
 *
 * **Strategy:**
 * - Tokens are first swapped to USDC on their source chains
 * - USDC is bridged to destination chain using Circle's CCTP
 * - On destination chain, USDC is swapped to final token (if needed)
 * - Steps are bundled when they can execute in parallel
 *
 * **Constraints:**
 * - Plans must contain at most one attestation step (enforced by validation)
 * - This ensures attestations stored in global state metadata don't conflict
 *
 * @param sourceTokens - Array of tokens to consolidate (max 50)
 * @param destinationToken - Final target token and chain for consolidation
 * @param connectedWallets - Wallets that are available for signing
 * @param log - Optional logging function for debug output
 * @returns Array of transaction steps with dependencies and bundling information
 *
 * @throws {Error} PlanningError - Invalid inputs, too many tokens, or multiple attestation steps
 * @throws {Error} UnsupportedRouteError - Unsupported chain
 * @throws {Error} ExternalAPIError - Swap quote or bridge fee request failed
 *
 * @example
 * const steps = await planConsolidation(
 *   [
 *     { token: "0x...", amount: 100n, chainId: 1, ... },    // ETH on Ethereum
 *     { token: "0x...", amount: 50n, chainId: 8453, ... },  // USDC on Base
 *   ],
 *   { token: "0x...", chainId: 8453, symbol: "WETH", ... }, // Target: WETH on Base
 *   [WALLET1, WALLET2], // Wallets that are available for signing
 *   console.log
 * );
 * // Returns: [swap1, swap2, bridge, attestation, claim, finalSwap]
 */
export async function planConsolidation(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[],
  log: (...args: unknown[]) => void = () => {},
  accounts?: AccountsMap,
): Promise<TransactionStep[]> {
  // Validate inputs
  validateInputs(sourceTokens, destinationToken, connectedWallets, log);
  await assertAccountsUsable(sourceTokens, destinationToken, connectedWallets, accounts);

  // Source-kind homogeneity: a plan draws either from EOAs or from Safes,
  // never both (the Addresses / Safes tabs enforce this in the UI; planning
  // re-checks as defense in depth). Safe mode hardens custody: funds from
  // Safes are only ever held by Safes until final delivery.
  const sourceKinds = new Set(sourceTokens.map((t) => accountFor(accounts, t.walletAddress).kind));
  if (sourceKinds.size > 1) {
    throw new Error(
      "PlanningError: Safe-held and address-held tokens must be consolidated in separate runs. " +
        "Use the Addresses and Safes tabs to select one kind at a time.",
    );
  }
  const safeMode = sourceKinds.has("safe");

  // Railgun (0zk) destination: everything consolidates to an intermediate
  // connected wallet first, then a final `shield` step deposits the token into
  // the Railgun contract. There is no public destination wallet.
  const isRailgun = destinationToken.railgunAddress !== undefined;

  // Railgun's shield key derives from a deterministic personal_sign, which a
  // Safe cannot produce — and in Safe mode the shielding wallet would have to
  // be a Safe (an EOA must never custody the funds). Mutually exclusive.
  if (safeMode && isRailgun) {
    throw new Error(
      "PlanningError: Railgun shielding isn't available for Safe-held funds (the shield key requires an EOA " +
        "signature, and Safe custody rules forbid routing the funds through an EOA). Use the Addresses tab.",
    );
  }

  // Fast path: when every source is already the destination token on the
  // destination chain, the plan is pure transfers — no swap/bridge/claim is
  // possible. Skip intermediate-wallet resolution, multi-chain gas context, and
  // the swap/bridge/claim phases, doing one native-balance check per source
  // wallet on the destination chain.
  //
  // We still defer to the general pipeline when destination is not connected
  // AND there are multiple source wallets: in that case the intermediate-wallet
  // step is what aggregates funds to a single final transfer, which is the
  // existing UX. Railgun destinations always need the general pipeline (the
  // plan must end with a shield step, never plain transfers).
  const isTransferOnly =
    !isRailgun &&
    sourceTokens.every(
      (t) => t.chainId === destinationToken.chainId && isAddressEqual(t.token, destinationToken.token),
    );
  if (isTransferOnly) {
    const sourceWalletSet = new Set(sourceTokens.map((t) => getAddress(t.walletAddress)));
    const destConnected = connectedWallets.some((w) => isAddressEqual(w, destinationToken.walletAddress));
    if (sourceWalletSet.size === 1 || destConnected) {
      return planTransferOnly(sourceTokens, destinationToken, log, accounts);
    }
  }

  // Gnosis has no CCTP: its bridge leg routes through Ethereum mainnet via the
  // Omnibridge (egress when Gnosis is a source, ingress when it's the
  // destination), so those plans also need mainnet gas data and an EOA hub.
  const isGnosisDest = destinationToken.chainId === gnosis.id;
  const sourceHasGnosis = sourceTokens.some((t) => t.chainId === gnosis.id);
  const needsMainnetHub =
    (sourceHasGnosis && !isGnosisDest) || (isGnosisDest && sourceTokens.some((t) => t.chainId !== gnosis.id));

  // The Omnibridge is a multi-token bridge, so when the destination token
  // itself is registered on it, the Gnosis hop bridges that token directly
  // instead of routing value through USDC: egress to a mainnet destination
  // swaps everything on Gnosis (cheap) into the token's Gnosis twin and
  // bridges it, skipping the expensive mainnet swap. Ingress activates only
  // when mainnet SOURCE assets exist — they swap into the token's mainnet
  // twin (a mainnet swap they'd need on any route) and any CCTP-claimed USDC
  // joins them via a hub swap, so the plan bridges one token flavor and
  // destination-token holdings never round-trip through USDC. Without
  // mainnet sources, CCTP value stays USDC through the hop and swaps on
  // Gnosis instead.
  let omniDirectRoute: GnosisDirectRoute | null = null;
  const wantsDirectRoute =
    (sourceHasGnosis && !isGnosisDest && destinationToken.chainId === mainnet.id) ||
    (isGnosisDest && sourceTokens.some((t) => t.chainId === mainnet.id));
  if (wantsDirectRoute && !isAddressEqual(destinationToken.token, zeroAddress)) {
    try {
      const pair = await resolveOmnibridgeTokenPair(destinationToken.token, destinationToken.chainId);
      if (pair) {
        // Omnibridge twins share decimals (the bridged deployment copies the
        // native token's), so one symbol/decimals pair describes both sides.
        omniDirectRoute = { pair, symbol: destinationToken.symbol, decimals: destinationToken.decimals };
        log(
          `🔍 [DEBUG] Direct Omnibridge route for ${destinationToken.symbol}: gnosis=${pair.gnosisToken} <-> mainnet=${pair.mainnetToken}`,
        );
      }
    } catch (error) {
      log(`⚠️ [DEBUG] Omnibridge counterpart lookup failed, falling back to the USDC route: ${String(error)}`);
    }
  }

  // Build gas context for all involved chains (fetches gas prices + native token prices)
  const allChainIds = [
    ...new Set([
      ...sourceTokens.map((t) => t.chainId),
      destinationToken.chainId,
      ...(needsMainnetHub ? [mainnet.id] : []),
    ]),
  ];
  const gasCtx = await buildGasContext(allChainIds);

  // Native balances observed while drafting (reused by reconcileGasGaps) and
  // planning-side simulation artifacts (Delora quote calldata per swap step).
  const balances: NativeBalances = new Map();
  const artifacts = emptyPlanArtifacts();

  // Find a suitable intermediate wallet using gas estimation
  const intermediateWallet = await resolveIntermediateWallet(
    sourceTokens,
    destinationToken,
    connectedWallets,
    gasCtx,
    balances,
    isRailgun,
    accounts,
    safeMode,
  );

  // Railgun's shield key derives from a deterministic personal_sign — a Safe
  // returns an EIP-1271 contract signature, which cannot seed it. The
  // intermediate performs the shield, so it must be an EOA (Safe mode is
  // rejected earlier; this guards the EOA-mode Safe-destination edge).
  if (isRailgun && isSafeAccount(accounts, intermediateWallet)) {
    throw new Error(
      "PlanningError: Railgun shielding requires an EOA wallet (its shield key derives from a signature a Safe cannot produce). Choose an EOA destination or disable the Safe.",
    );
  }

  // The intermediate target is a plain public token spec — drop the railgun
  // marker so swap/bridge outputs aren't tagged with it.
  const { railgunAddress, ...publicDestination } = destinationToken;
  const intermediateToken = { ...publicDestination, walletAddress: intermediateWallet };

  // The Omnibridge hop's mainnet steps (claim/deposit/burn) are signed by the
  // intermediate wallet on mainnet — a chain assertAccountsUsable may not
  // cover. A Safe intermediate (i.e. a Safe destination acting as its own
  // intermediate) must therefore be controlled on mainnet too, or the route
  // is rejected with an actionable error.
  if (needsMainnetHub) {
    await assertAccountUsableOnChain(intermediateWallet, mainnet.id, accounts).catch((error) => {
      if (isSafeAccount(accounts, intermediateWallet)) {
        throw new Error(
          `PlanningError: This route needs an Ethereum mainnet hop, but Safe ${intermediateWallet} isn't ` +
            `deployed (or controlled by your connected owner) there. Pick an EOA destination or a non-Gnosis route.`,
        );
      }
      throw error;
    });
  }

  // Per-chain bridge-target overrides for a direct Omnibridge route: on
  // egress the Gnosis side swaps into the destination token's Gnosis twin,
  // on ingress the mainnet side swaps into its mainnet twin. Every other
  // chain keeps swapping to USDC for CCTP.
  const bridgeTargets = new Map<number, Omit<TokenAmount, "amount" | "walletAddress">>();
  if (omniDirectRoute) {
    const { pair, symbol, decimals } = omniDirectRoute;
    if (isGnosisDest) {
      bridgeTargets.set(mainnet.id, { token: pair.mainnetToken, chainId: mainnet.id, symbol, decimals });
    } else {
      bridgeTargets.set(gnosis.id, { token: pair.gnosisToken, chainId: gnosis.id, symbol, decimals });
    }
  }

  // Build consolidation pipeline (native amounts gas-adjusted per wallet)
  let { steps, tokens } = await processChainWalletSwaps(
    sourceTokens,
    intermediateToken,
    gasCtx,
    balances,
    artifacts,
    log,
    bridgeTargets,
    accounts,
  );

  if (sourceHasGnosis && !isGnosisDest) {
    // Egress: the Gnosis-side bridgeable token (USDC.e, or the destination
    // token's twin on a direct route) exits through the Omnibridge to the hub
    // wallet on mainnet; the claim output then joins the stages below.
    ({ steps, tokens } = await createGnosisEgressSteps(
      steps,
      tokens,
      intermediateWallet,
      destinationToken.chainId,
      gasCtx,
      log,
      omniDirectRoute,
    ));
  }

  if (isGnosisDest) {
    // Ingress: the CCTP stages run unchanged but converge on a mainnet hub
    // token instead of the (CCTP-less) Gnosis destination; the Omnibridge then
    // carries the hub value to Gnosis — as USDC via the transmuter on the
    // fallback route, or as the destination token's mainnet twin on a direct
    // route (the claimed hub USDC is hub-swapped into the twin so the plan
    // bridges a single token flavor). Gnosis-held tokens stay aside — they're
    // already on the destination chain and have no CCTP route.
    const gnosisHeldTokens = tokens.filter((t) => t.chainId === gnosis.id);
    const hubToken: DestinationToken = {
      token: USDC_ADDRESSES[mainnet.id] as Address,
      chainId: mainnet.id,
      walletAddress: intermediateWallet,
      symbol: "USDC",
      decimals: 6,
    };
    ({ steps, tokens } = await createBridgeSteps(
      steps,
      tokens.filter((t) => t.chainId !== gnosis.id),
      hubToken,
      log,
    ));
    ({ steps, tokens } = createAttestationAndClaimSteps(steps, tokens, hubToken));
    ({ steps, tokens } = await createGnosisIngressSteps(
      steps,
      tokens,
      intermediateWallet,
      gasCtx,
      artifacts,
      log,
      omniDirectRoute,
    ));
    tokens = [...tokens, ...gnosisHeldTokens];
  } else {
    ({ steps, tokens } = await createBridgeSteps(steps, tokens, intermediateToken, log));
    ({ steps, tokens } = createAttestationAndClaimSteps(steps, tokens, intermediateToken));
  }

  // Whether the intermediate wallet performs a CCTP claim on the destination
  // chain (false when the destination is Gnosis — that claim runs on mainnet).
  const hasBridges = !isGnosisDest && steps.some((s) => s.type === "bridge");
  const needsFinalTransfer = !isRailgun && !isAddressEqual(intermediateWallet, destinationToken.walletAddress);

  // Safe mode with a distinct destination: the final swaps pay out DIRECTLY
  // to the destination wallet (Delora quotes support a recipient other than
  // the sender — the same mechanism the intermediate flow relies on). The
  // Safe executes the swap, so custody stays on the Safe until the router
  // delivers; value that's already the destination token is moved by the
  // transfer steps `createSwapsAndTransfers` emits toward the same target.
  // Both step kinds batch into the Safe's final MultiSend, and no trailing
  // `createFinalTransfer` (with its floor/dust trade-offs) is needed at all.
  const deliversDirectly = safeMode && needsFinalTransfer;
  const finalTarget = deliversDirectly ? { ...publicDestination } : intermediateToken;
  ({ steps, tokens } = await createFinalSwaps(
    steps,
    tokens,
    finalTarget,
    gasCtx,
    hasBridges,
    needsFinalTransfer && !deliversDirectly,
    isRailgun,
    balances,
    artifacts,
    log,
    accounts,
  ));

  if (isRailgun && railgunAddress) {
    ({ steps, tokens } = createShieldStep(steps, tokens, railgunAddress, log));
  } else if (needsFinalTransfer && !deliversDirectly) {
    ({ steps, tokens } = await createFinalTransfer(steps, tokens, destinationToken, log));
  }

  // Tag Safe-executed steps (and compute their MultiSend batch groups) before
  // estimating so the execTransaction overhead can be layered per group.
  tagSafeSteps(steps, accounts);

  // Attach per-step gas estimates (batched eth_simulateV1 with ladder
  // fallback), then derive gas deficits from the measured numbers.
  await attachGasEstimates(steps, gasCtx, artifacts);
  addSafeExecGasOverhead(steps);
  const gaps = await reconcileGasGaps(steps, balances, log, accounts);

  // If any (chain, gas payer) can't cover its own gas, prepend a gas-topup
  // step funded preferentially from the destination wallet, falling back to
  // the richest executor balance across all supported chains. Safe steps'
  // gas payer is the owner EOA (a real EOA, same address everywhere), so
  // top-ups never target or draw from a Safe.
  const executorAddresses = new Set<Address>();
  executorAddresses.add(getAddress(executorFor(accounts, intermediateWallet)) as Address);
  for (const step of steps) {
    if (step.inputTokens[0]?.walletAddress) {
      executorAddresses.add(getAddress(executorFor(accounts, step.inputTokens[0].walletAddress)) as Address);
    }
  }
  const gasTopUpSteps = await createGasTopUpSteps(
    gaps,
    intermediateWallet,
    destinationToken,
    executorAddresses,
    log,
    accounts,
  );
  if (gasTopUpSteps.length > 0) {
    await attachGasEstimates(gasTopUpSteps, gasCtx, artifacts);
    steps = [...gasTopUpSteps, ...steps];
  }

  assertSafeChainConsistency(steps, accounts);

  // Validate plan constraints
  const attestationSteps = steps.filter((s) => s.type === "attestation");
  if (attestationSteps.length > 1) {
    throw new Error("PlanningError: Plans must contain at most one attestation step");
  }
  // Same rationale for the Omnibridge leg: its claims/deliveries live in a
  // single metadata bucket, and a plan bridges exactly one token flavor per
  // direction (per-wallet gnosis-bridge steps all converge on one wait, like
  // CCTP's burns converge on one attestation). Egress and ingress legs are
  // mutually exclusive within one plan, so this holds by construction.
  if (steps.filter((s) => s.type === "gnosis-wait").length > 1) {
    throw new Error("PlanningError: Plans must contain at most one gnosis-wait step");
  }

  log(
    "🔍 [DEBUG] Generated steps:",
    steps.map((s) => ({
      id: s.id,
      type: s.type,
      chainId: s.chainId,
      estimatedGas: s.estimatedGas
        ? { gasCostWei: s.estimatedGas.gasCostWei.toString(), nativeSymbol: s.estimatedGas.nativeSymbol }
        : null,
      inputTokens: s.inputTokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        provenance: t.provenance,
      })),
      outputToken: s.outputToken ? { symbol: s.outputToken.symbol, amount: s.outputToken.amount?.toString() } : null,
    })),
  );

  return steps;
}
