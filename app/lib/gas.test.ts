import { type Address, parseUnits, type Transport, zeroAddress } from "viem";
import { degen, mainnet, optimism } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getTestClients, reset } from "../../test/globalSetup";
import { ensureSufficientGas, getNativeBalance } from "./gas";

const { testClient: mainnetTestClient, transport: mainnetTransport } = getTestClients(mainnet.id);
const { testClient: optimismTestClient, transport: optimismTransport } = getTestClients(optimism.id);

const transports: Record<number, Transport> = { [mainnet.id]: mainnetTransport, [optimism.id]: optimismTransport };

const tokensIn = [
  {
    chainId: mainnet.id,
    walletAddress: "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address,
    token: zeroAddress,
    amount: 0n,
  },
];
const tokenOut = {
  chainId: optimism.id,
  walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
  token: zeroAddress,
  amount: 0n,
};

describe("gas", () => {
  beforeAll(async () => {
    await mainnetTestClient.setBalance({
      address: "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address,
      value: parseUnits("0.002", 18),
    });
    await optimismTestClient.setBalance({
      address: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
      value: parseUnits("0.002", 18),
    });
  });

  afterAll(async () => {
    await reset();
  });

  describe("getNativeBalance", () => {
    test("should return the native balance of the address", async () => {
      const balance = await getNativeBalance(mainnet, "0xc30b007BC349d52850207F78c63b4bd0c823F122", mainnetTransport);
      expect(balance).toBe(parseUnits("0.002", 18));
      const balance2 = await getNativeBalance(
        optimism,
        "0x19afE793Fb51902883F68f06685aE5277aF13857",
        optimismTransport,
      );
      expect(balance2).toBe(parseUnits("0.002", 18));
      const balance3 = await getNativeBalance(
        optimism,
        "0x0000000020000000000000000000000000000002" as Address,
        optimismTransport,
      );
      expect(balance3).toBe(parseUnits("0", 18));
    });
    test("should use default transport if no transport is provided", async () => {
      const balance = await getNativeBalance(mainnet, "0xc30b007BC349d52850207F78c63b4bd0c823F122");
      expect(balance).toBe(parseUnits("0", 18));
      const balance2 = await getNativeBalance(optimism, "0x19afE793Fb51902883F68f06685aE5277aF13857");
      expect(balance2).toBe(parseUnits("0", 18));
    });
    test("should throw an error if the chain is not supported", async () => {
      await expect(getNativeBalance(degen, "0xc30b007BC349d52850207F78c63b4bd0c823F122")).rejects.toThrow(
        "Client not found for chain 666666666",
      );
    });
  });

  describe("ensureSufficientGas", () => {
    test("should not throw an error if the gas is sufficient", async () => {
      await expect(async () => await ensureSufficientGas(tokensIn, tokenOut, transports)).not.toThrow();
    });
    test("should throw an error if the gas is insufficient", async () => {
      const insufficientTokenOut = {
        chainId: optimism.id,
        walletAddress: "0x0000000020000000000000000000000000000002" as Address,
        token: zeroAddress,
        amount: 0n,
      };
      try {
        await ensureSufficientGas(tokensIn, insufficientTokenOut, transports);
      } catch (error) {
        expect((error as Error).message).toContain("Insufficient gas on OP Mainnet");
      }
    });
  });
});
