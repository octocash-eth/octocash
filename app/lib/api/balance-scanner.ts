import { type Address, decodeFunctionResult, encodeFunctionData, type Hex, parseAbi } from "viem";
import { mapWithConcurrency } from "../concurrency";
import { getPublicClient } from "../public-client";

/**
 * Runtime bytecode of contracts/BalanceScanner.sol (solc 0.8.33, see the
 * contract header for the exact build command). It is never deployed: each
 * read injects it at {@link SCANNER_ADDRESS} through an `eth_call` state
 * override, so a single RPC call checks every wallet × token pair and
 * returns only the non-zero balances.
 */
export const BALANCE_SCANNER_RUNTIME: Hex =
  "0x608060405234801561001057600080fd5b506004361061002b5760003560e01c8063e8e83d0c14610030575b600080fd5b61004361003e366004610269565b610059565b60405161005091906102d8565b60405180910390f35b606081610067856002610331565b6100719190610331565b6001600160401b038111156100885761008861034e565b6040519080825280602002602001820160405280156100b1578160200160208202803683370190505b5090506000805b838110156102135760008585838181106100d4576100d4610364565b90506020020160208101906100e9919061037a565b905060005b8781101561020957600089898381811061010a5761010a610364565b905060200201602081019061011f919061037a565b905060006001600160a01b03841661014257506001600160a01b0381163161019f565b6201d4c05a101561016d57604051634662b5a560e11b81526004810186905260240160405180910390fd5b6040516370a0823160e01b815282600482015260208160248388620186a0fa601f3d1181161561019c57815192505b50505b80156101ff57608085901b831787876101b7816103aa565b9850815181106101c9576101c9610364565b60209081029190910101528087876101e0816103aa565b9850815181106101f2576101f2610364565b6020026020010181815250505b50506001016100ee565b50506001016100b8565b508152949350505050565b60008083601f84011261023057600080fd5b5081356001600160401b0381111561024757600080fd5b6020830191508360208260051b850101111561026257600080fd5b9250929050565b6000806000806040858703121561027f57600080fd5b84356001600160401b0381111561029557600080fd5b6102a18782880161021e565b90955093505060208501356001600160401b038111156102c057600080fd5b6102cc8782880161021e565b95989497509550505050565b602080825282518282018190526000918401906040840190835b818110156103105783518352602093840193909201916001016102f2565b509095945050505050565b634e487b7160e01b600052601160045260246000fd5b80820281158282048414176103485761034861031b565b92915050565b634e487b7160e01b600052604160045260246000fd5b634e487b7160e01b600052603260045260246000fd5b60006020828403121561038c57600080fd5b81356001600160a01b03811681146103a357600080fd5b9392505050565b6000600182016103bc576103bc61031b565b506001019056fea164736f6c6343000821000a";

/** Throwaway address the scanner code is overridden into for each call. */
const SCANNER_ADDRESS: Address = "0x0000000000000000000000000000000000ba1a1c";

const scannerAbi = parseAbi(["function scan(address[] wallets, address[] tokens) view returns (uint256[])"]);

/**
 * Wallet × token checks per `eth_call`. dRPC served ~175k in one call on
 * mainnet (16s); 20k keeps each call around 1–3s and well clear of node gas
 * and payload caps.
 */
const MAX_CHECKS_PER_CALL = 20_000;
/** Wallets per call, so the token slice stays useful with many wallets. */
const MAX_WALLETS_PER_CALL = 64;
/** Chunks in flight per chain. */
const CONCURRENCY = 4;
/** A failed chunk is halved and retried this many times before giving up. */
const MAX_SPLITS = 2;

const LOW_128 = (1n << 128n) - 1n;

/** `${lowercased token}:${lowercased wallet}` → raw balance. */
export type ScannedBalances = Map<string, bigint>;

export const scanKey = (token: Address, wallet: Address): string => `${token.toLowerCase()}:${wallet.toLowerCase()}`;

async function scanChunk(
  chainId: number,
  wallets: Address[],
  tokens: Address[],
  splits: number,
): Promise<[Address, Address, bigint][]> {
  try {
    const { data } = await getPublicClient(chainId).call({
      to: SCANNER_ADDRESS,
      data: encodeFunctionData({ abi: scannerAbi, functionName: "scan", args: [wallets, tokens] }),
      stateOverride: [{ address: SCANNER_ADDRESS, code: BALANCE_SCANNER_RUNTIME }],
    });
    if (!data) throw new Error("Balance scanner returned no data");
    const flat = decodeFunctionResult({ abi: scannerAbi, functionName: "scan", data });
    const out: [Address, Address, bigint][] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const packed = flat[i];
      out.push([tokens[Number(packed >> 128n)], wallets[Number(packed & LOW_128)], flat[i + 1]]);
    }
    return out;
  } catch (error) {
    // Oversized chunks (gas or payload caps on a given upstream) succeed when
    // halved; anything that still fails after MAX_SPLITS is a real error.
    if (splits >= MAX_SPLITS || tokens.length < 2) throw error;
    const mid = Math.ceil(tokens.length / 2);
    const [a, b] = await Promise.all([
      scanChunk(chainId, wallets, tokens.slice(0, mid), splits + 1),
      scanChunk(chainId, wallets, tokens.slice(mid), splits + 1),
    ]);
    return [...a, ...b];
  }
}

/**
 * Read every non-zero balance of `tokens` (use `zeroAddress` for the native
 * coin) held by `wallets` on `chainId`, over plain RPC. Throws if any chunk
 * still fails after being split, so callers never see a partial scan.
 */
export async function scanBalances(
  chainId: number,
  wallets: readonly Address[],
  tokens: readonly Address[],
): Promise<ScannedBalances> {
  const result: ScannedBalances = new Map();
  if (wallets.length === 0 || tokens.length === 0) return result;

  const uniqueTokens = [...new Map(tokens.map((t) => [t.toLowerCase(), t])).values()];
  const uniqueWallets = [...new Map(wallets.map((w) => [w.toLowerCase(), w])).values()];

  const chunks: { wallets: Address[]; tokens: Address[] }[] = [];
  for (let w = 0; w < uniqueWallets.length; w += MAX_WALLETS_PER_CALL) {
    const walletSlice = uniqueWallets.slice(w, w + MAX_WALLETS_PER_CALL);
    const tokensPerCall = Math.max(1, Math.floor(MAX_CHECKS_PER_CALL / walletSlice.length));
    for (let t = 0; t < uniqueTokens.length; t += tokensPerCall) {
      chunks.push({ wallets: walletSlice, tokens: uniqueTokens.slice(t, t + tokensPerCall) });
    }
  }

  const parts = await mapWithConcurrency(chunks, CONCURRENCY, (c) => scanChunk(chainId, c.wallets, c.tokens, 0));
  for (const part of parts) {
    for (const [token, wallet, balance] of part) result.set(scanKey(token, wallet), balance);
  }
  return result;
}
