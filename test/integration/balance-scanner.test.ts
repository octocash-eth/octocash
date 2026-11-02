/**
 * Runs the real BalanceScanner bytecode against the anvil mainnet fork and
 * checks it agrees with plain `balanceOf` / `getBalance` reads.
 * Run with: bun run test:integration test/integration/balance-scanner.test.ts
 */
import { type Address, encodeFunctionData, erc20Abi, parseAbi, parseEther, toFunctionSelector, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test, vi } from "vitest";
import { BALANCE_SCANNER_RUNTIME, scanBalances, scanKey } from "~/lib/api/balance-scanner";
import { getTestClients } from "../integration-global-setup";

vi.mock("../../app/lib/public-client", async () => {
  const { getTestClients } = await import("../integration-global-setup");
  return { getPublicClient: (chainId: number) => getTestClients(chainId).publicClient };
});

const HOLDER = "0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE" as Address; // holds sUSDS
const TOKENS = [
  "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", // sUSDS
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
] as Address[];
const NOT_A_TOKEN = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address; // Multicall3: no balanceOf
const EOA = "0x000000000000000000000000000000000000dEaD" as Address;

describe("balance scanner (mainnet fork)", () => {
  const { publicClient, testClient } = getTestClients(mainnet.id);

  test("matches balanceOf and getBalance for every wallet × token", async () => {
    const fresh = "0x00000000000000000000000000000000c0ffee01" as Address;
    await testClient.setBalance({ address: fresh, value: parseEther("3") });
    const wallets = [HOLDER, fresh, EOA];

    const scanned = await scanBalances(mainnet.id, wallets, [zeroAddress, ...TOKENS]);

    for (const wallet of wallets) {
      expect(scanned.get(scanKey(zeroAddress, wallet)) ?? 0n).toBe(await publicClient.getBalance({ address: wallet }));
      for (const token of TOKENS) {
        const expected = await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        });
        expect(scanned.get(scanKey(token, wallet)) ?? 0n).toBe(expected);
      }
    }
    expect(scanned.get(scanKey(TOKENS[0], HOLDER))).toBeGreaterThan(0n);
    expect(scanned.get(scanKey(zeroAddress, fresh))).toBe(parseEther("3"));
  });

  test("treats non-token addresses as zero without failing the scan", async () => {
    const scanned = await scanBalances(mainnet.id, [HOLDER], [NOT_A_TOKEN, EOA, TOKENS[0]]);

    expect(scanned.has(scanKey(NOT_A_TOKEN, HOLDER))).toBe(false);
    expect(scanned.has(scanKey(EOA, HOLDER))).toBe(false);
    expect(scanned.get(scanKey(TOKENS[0], HOLDER))).toBeGreaterThan(0n);
  });

  test("a failing token right after a successful one still reads as zero", async () => {
    // Regression: checking `returndatasize()` inline with the call made Yul
    // read the previous call's size (arguments evaluate right to left), so
    // the first token was always dropped and a reverting token right after a
    // held one reported leftover memory as its balance.
    const scanned = await scanBalances(mainnet.id, [HOLDER], [TOKENS[0], NOT_A_TOKEN, TOKENS[0]]);

    expect(scanned.has(scanKey(NOT_A_TOKEN, HOLDER))).toBe(false);
    expect(scanned.get(scanKey(TOKENS[0], HOLDER))).toBeGreaterThan(0n);
  });

  test("reverts instead of under-reporting when gas runs out", async () => {
    const scanner = "0x0000000000000000000000000000000000ba1a1c" as Address;
    // Enough budget to be a valid call (1,000 addresses of calldata cost
    // ~940k under the EIP-7623 floor) and start scanning, not to finish: the
    // guard must trip mid-scan.
    const tokens = Array.from({ length: 1_000 }, () => TOKENS[0]);

    const error = await publicClient
      .call({
        to: scanner,
        gas: 1_000_000n,
        data: encodeFunctionData({
          abi: parseAbi(["function scan(address[] wallets, address[] tokens) view returns (uint256[])"]),
          functionName: "scan",
          args: [[HOLDER], tokens],
        }),
        stateOverride: [{ address: scanner, code: BALANCE_SCANNER_RUNTIME }],
      })
      .then(() => null, (e: unknown) => e);

    // The scanner's own OutOfGas(uint256) guard, not an incidental failure.
    expect(String(error)).toContain(toFunctionSelector("OutOfGas(uint256)"));
  });
});
