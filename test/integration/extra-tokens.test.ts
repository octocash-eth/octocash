/**
 * Integration test for extra tokens functionality
 * Run with: bun run test run test/integration/extra-tokens.test.ts
 */
import { erc20Abi, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test } from "vitest";
import { EXTRA_TOKENS } from "~/lib/api";
import { getTestClients } from "../integration-global-setup";

const SUSDS_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";
const TEST_WALLET = "0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE";

describe("extra tokens integration", () => {
  test("EXTRA_TOKENS contains sUSDS", () => {
    const susds = EXTRA_TOKENS.find((t) => t.address.toLowerCase() === SUSDS_ADDRESS.toLowerCase());
    expect(susds).toBeDefined();
    expect(susds?.chainId).toBe(1);
  });

  test("can fetch sUSDS balance via RPC for test wallet", async () => {
    const { publicClient } = getTestClients(mainnet.id);

    const balance = await publicClient.readContract({
      address: SUSDS_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [TEST_WALLET],
    });

    console.log(`\n=== sUSDS Balance Check ===`);
    console.log(`Wallet: ${TEST_WALLET}`);
    console.log(`sUSDS balance (raw): ${balance.toString()}`);
    console.log(`sUSDS balance (formatted): ${formatUnits(balance, 18)} sUSDS`);
    console.log(`===========================\n`);

    // This wallet should have some sUSDS
    expect(balance).toBeGreaterThan(0n);
  });
});
