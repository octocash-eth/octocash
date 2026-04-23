import { type Address, parseUnits, type Transport } from "viem";
import { mainnet, optimism } from "viem/chains";
import { beforeAll, describe, expect, test } from "vitest";
import { getTestClients } from "../integration-global-setup";
import { getNativeBalance } from "../../app/lib/gas";

const { testClient: mainnetTestClient, transport: mainnetTransport } = getTestClients(mainnet.id);
const { testClient: optimismTestClient, transport: optimismTransport } = getTestClients(optimism.id);

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
  });
});
